import { chmod, link, mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export interface AtomicJsonOptions {
  immutableWhenTerminal?: boolean;
  beforeLock?: () => void | Promise<void>;
  beforeRename?: () => void | Promise<void>;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeSyncedTemp(path: string, value: unknown): Promise<string> {
  const tempPath = `${path}.${process.pid}-${randomUUID()}.tmp`;
  const file = await open(tempPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  return tempPath;
}

export async function acquireRunClaim(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(path, { force: true });
    throw error;
  }
  await file.close();
  await syncDirectory(directory);
}

async function acquireArtifactWriteLock(path: string): Promise<{ file: FileHandle; path: string }> {
  const lockPath = `${path}.write-lock`;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      return { file: await open(lockPath, "wx", 0o600), path: lockPath };
    } catch (error) {
      const occupied = error && typeof error === "object" && "code" in error && error.code === "EEXIST";
      if (!occupied) throw error;
      if (attempt === 499) throw new Error("EVIDENCE_ARTIFACT_WRITE_LOCKED");
      await delay(10);
    }
  }
  throw new Error("EVIDENCE_ARTIFACT_WRITE_LOCKED");
}

export async function atomicReplaceJson(
  path: string,
  value: unknown,
  options: AtomicJsonOptions = {},
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await options.beforeLock?.();
  const lock = options.immutableWhenTerminal ? await acquireArtifactWriteLock(path) : null;
  try {
    if (options.immutableWhenTerminal) {
      try {
        const existing = JSON.parse(await readFile(path, "utf8")) as { phase?: unknown };
        if (existing.phase === "complete" || existing.phase === "incomplete") {
          throw new Error("EVIDENCE_TERMINAL_ARTIFACT_IMMUTABLE");
        }
      } catch (error) {
        if (error instanceof Error && error.message === "EVIDENCE_TERMINAL_ARTIFACT_IMMUTABLE") throw error;
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
    const tempPath = await writeSyncedTemp(path, value);
    try {
      await options.beforeRename?.();
      await rename(tempPath, path);
      await chmod(path, 0o600);
      await syncDirectory(directory);
    } finally {
      await rm(tempPath, { force: true });
    }
  } finally {
    if (lock) {
      await lock.file.close();
      await rm(lock.path, { force: true });
    }
  }
}

export async function writeOnceJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = await writeSyncedTemp(path, value);
  try {
    await link(tempPath, path);
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function recordAttemptDurablyBeforeAssertions<T>(
  attempts: T[],
  attempt: T,
  persist: () => Promise<void>,
  assertions: () => void | Promise<void>,
): Promise<void> {
  attempts.push(attempt);
  await persist();
  await assertions();
}
