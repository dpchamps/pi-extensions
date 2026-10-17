import { createHash } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function scratchpadDirectory(
  sessionId: string,
  tempDir = tmpdir(),
): string {
  // Custom session IDs must never become filesystem paths. Separate OS users
  // on systems where tmpdir() is shared, such as /tmp on Linux.
  const owner = process.getuid?.() ?? "user";
  const namespace = createHash("sha256").update(sessionId).digest("hex");
  return join(resolve(tempDir), `pi-scratchpad-${owner}`, namespace);
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Scratchpad path is not a real directory: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined) {
    if (stat.uid !== uid) {
      throw new Error(`Scratchpad directory belongs to another user: ${path}`);
    }
    await chmod(path, 0o700);
  }
}

export async function ensureScratchpadDirectory(
  sessionId: string,
  tempDir = tmpdir(),
): Promise<string> {
  const directory = scratchpadDirectory(sessionId, tempDir);
  // Check the managed parent before creating anything underneath it, so an
  // existing symlink cannot redirect the scratchpad outside the temp namespace.
  await privateDirectory(resolve(directory, ".."));
  await privateDirectory(directory);
  return directory;
}
