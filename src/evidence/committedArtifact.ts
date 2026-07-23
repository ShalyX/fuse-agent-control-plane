import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function assertArtifactCommittedAtHead(
  artifactPath: string,
  repositoryRoot = process.cwd(),
): Promise<void> {
  const root = resolve(repositoryRoot);
  const absolutePath = resolve(artifactPath);
  const relativePath = relative(root, absolutePath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)) {
    throw new Error("HELD_OUT_PLAN_NOT_COMMITTED");
  }
  const gitPath = relativePath.split(sep).join("/");
  try {
    const [current, committed] = await Promise.all([
      readFile(absolutePath),
      execFileAsync("git", ["show", `HEAD:${gitPath}`], {
        cwd: root,
        encoding: "buffer",
        maxBuffer: 10 * 1024 * 1024,
      }),
    ]);
    if (!current.equals(committed.stdout)) throw new Error("HELD_OUT_PLAN_NOT_COMMITTED");
  } catch (error) {
    if (error instanceof Error && error.message === "HELD_OUT_PLAN_NOT_COMMITTED") throw error;
    throw new Error("HELD_OUT_PLAN_NOT_COMMITTED", { cause: error });
  }
}
