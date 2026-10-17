import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureScratchpadDirectory, scratchpadDirectory } from "./directory.js";

let tempDir: string;
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "scratchpad-directory-test-"));
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("scratchpad directories", () => {
  it("isolates sessions and reuses existing files for the same session", async () => {
    const first = await ensureScratchpadDirectory("session-a", tempDir);
    const second = await ensureScratchpadDirectory("session-b", tempDir);
    expect(first).not.toBe(second);
    await writeFile(join(first, "calculation.txt"), "42");
    expect(await ensureScratchpadDirectory("session-a", tempDir)).toBe(first);
    expect(await readFile(join(first, "calculation.txt"), "utf8")).toBe("42");
    if (process.getuid) {
      expect((await stat(first)).mode & 0o777).toBe(0o700);
      expect((await stat(dirname(first))).mode & 0o777).toBe(0o700);
    }
  });

  it("hashes custom session IDs instead of treating them as paths", () => {
    const directory = scratchpadDirectory("../../outside/with spaces", tempDir);
    expect(relative(tempDir, directory)).not.toMatch(/^\.\./);
    expect(directory).not.toContain("outside");
    expect(directory).toMatch(/[a-f0-9]{64}$/);
  });

  it("recreates a directory removed by temporary-file cleanup", async () => {
    const directory = await ensureScratchpadDirectory("session", tempDir);
    await rm(directory, { recursive: true });
    expect(await ensureScratchpadDirectory("session", tempDir)).toBe(directory);
    expect((await stat(directory)).isDirectory()).toBe(true);
  });

  it("rejects a symlink at the managed parent", async () => {
    const directory = scratchpadDirectory("session", tempDir);
    const target = await mkdtemp(join(tempDir, "target-"));
    await symlink(target, dirname(directory), "dir");
    await expect(ensureScratchpadDirectory("session", tempDir)).rejects.toThrow(
      "not a real directory",
    );
    expect(
      await stat(join(target, basename(directory))).catch(() => undefined),
    ).toBeUndefined();
  });

  it("rejects a symlink at the session directory", async () => {
    const directory = await ensureScratchpadDirectory("session", tempDir);
    const target = await mkdtemp(join(tempDir, "target-"));
    await rm(directory, { recursive: true });
    await symlink(target, directory, "dir");
    await expect(ensureScratchpadDirectory("session", tempDir)).rejects.toThrow(
      "not a real directory",
    );
  });
});
