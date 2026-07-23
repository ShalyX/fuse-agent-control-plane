import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface WriteOnceJsonPairOptions {
  afterFirstLink?: () => void | Promise<void>;
  afterSecondLink?: () => void | Promise<void>;
  beforeDirectorySync?: () => void | Promise<void>;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeSyncedTemp(path: string, bytes: Buffer): Promise<string> {
  const tempPath = `${path}.${process.pid}-${randomUUID()}.tmp`;
  const file = await open(tempPath, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  return tempPath;
}

async function assertExistingCompatible(path: string, expected: Buffer): Promise<void> {
  try {
    const existing = await readFile(path);
    if (!existing.equals(expected)) throw Object.assign(new Error(`EEXIST:${path}`), { code: "EEXIST" });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function ensureExactLink(tempPath: string, path: string, expected: Buffer): Promise<void> {
  try {
    await link(tempPath, path);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (!existing.equals(expected)) throw error;
  }
}

export async function writeOnceJsonPair(
  firstPath: string,
  firstValue: unknown,
  secondPath: string,
  secondValue: unknown,
  options: WriteOnceJsonPairOptions = {},
): Promise<void> {
  const firstDirectory = dirname(firstPath);
  const secondDirectory = dirname(secondPath);
  await Promise.all([
    mkdir(firstDirectory, { recursive: true, mode: 0o700 }),
    mkdir(secondDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const firstBytes = Buffer.from(`${JSON.stringify(firstValue, null, 2)}\n`, "utf8");
  const secondBytes = Buffer.from(`${JSON.stringify(secondValue, null, 2)}\n`, "utf8");

  // A prior interrupted attempt may have durably published either member. Exact
  // bytes are recoverable; any conflicting bytes remain a fail-closed overwrite.
  await assertExistingCompatible(firstPath, firstBytes);
  await assertExistingCompatible(secondPath, secondBytes);

  const [firstTemp, secondTemp] = await Promise.all([
    writeSyncedTemp(firstPath, firstBytes),
    writeSyncedTemp(secondPath, secondBytes),
  ]);
  try {
    await ensureExactLink(firstTemp, firstPath, firstBytes);
    await options.afterFirstLink?.();
    await ensureExactLink(secondTemp, secondPath, secondBytes);
    await options.afterSecondLink?.();
    await options.beforeDirectorySync?.();
    for (const directory of new Set([firstDirectory, secondDirectory])) {
      await syncDirectory(directory);
    }
  } finally {
    await Promise.all([rm(firstTemp, { force: true }), rm(secondTemp, { force: true })]);
  }
}
