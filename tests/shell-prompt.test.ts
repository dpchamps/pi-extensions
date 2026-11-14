import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareShell } from "../extensions/shell-command/prompt.js";

const exec = promisify(execFile);
const orange = "\x1b[38;5;208m";
const reset = "\x1b[0m";
let home: string;
let launch: Awaited<ReturnType<typeof prepareShell>> | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pi-prompt-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("TERM_PROGRAM", "pi-shell-test");
  vi.stubEnv("ZDOTDIR", undefined);
  vi.stubEnv("ENV", undefined);
});
afterEach(async () => {
  await launch?.cleanup();
  launch = undefined;
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe.skipIf(!existsSync("/bin/bash"))("Bash prompt", () => {
  it.each(["scalar", "array"])(
    "preserves %s prompt hooks and adds exactly one badge",
    async (kind) => {
      const rc = `PS1='user> '
alias user_alias='echo kept'
${kind === "array" ? "PROMPT_COMMAND=('PS1=\"dynamic> \"' ':')" : "PROMPT_COMMAND='PS1=\"dynamic> \"'"}
`;
      await writeFile(join(home, ".bashrc"), rc);
      launch = await prepareShell("/bin/bash");
      const { stdout } = await exec(
        "/bin/bash",
        [
          ...launch.args,
          "-c",
          `
for hook in "\${PROMPT_COMMAND[@]}"; do eval "$hook"; done
printf '%s\\n' "$PS1"
for hook in "\${PROMPT_COMMAND[@]}"; do eval "$hook"; done
printf '%s\\n' "$PS1"
alias user_alias
`,
        ],
        { env: launch.env },
      );
      const prefix = `\\[${orange}\\](π)\\[${reset}\\] `;
      expect(stdout.split("\n").slice(0, 2)).toEqual([
        `${prefix}dynamic> `,
        `${prefix}dynamic> `,
      ]);
      expect(stdout).toContain("echo kept");
      expect(await readFile(join(home, ".bashrc"), "utf8")).toBe(rc);
      expect(launch.env.PS1).toBe(process.env.PS1);
      const rcPath = launch.args[1];
      await launch.cleanup();
      expect(existsSync(rcPath)).toBe(false);
    },
  );

  it("does not duplicate the badge when the user has no prompt hook", async () => {
    await writeFile(
      join(home, ".bashrc"),
      "PS1='plain> '\nunset PROMPT_COMMAND\n",
    );
    launch = await prepareShell("/bin/bash");
    const { stdout } = await exec(
      "/bin/bash",
      [
        ...launch.args,
        "-c",
        '_pi_shell_prompt; _pi_shell_prompt; printf "%s" "$PS1"',
      ],
      { env: launch.env },
    );
    expect(stdout).toBe(`\\[${orange}\\](π)\\[${reset}\\] plain> `);
  });
});

describe.skipIf(!existsSync("/bin/zsh"))("Zsh prompt", () => {
  it.each(["home", "custom", "redirected"])(
    "loads %s startup files and preserves prompt hooks",
    async (kind) => {
      const config = kind === "home" ? home : join(home, "user's config");
      await mkdir(config, { recursive: true });
      if (kind === "custom") vi.stubEnv("ZDOTDIR", config);
      if (kind === "redirected") {
        await writeFile(
          join(home, ".zshenv"),
          `export ZDOTDIR="$HOME/user's config"\n`,
        );
      } else {
        await writeFile(
          join(config, ".zshenv"),
          "export USER_ENV_LOADED=yes\n",
        );
      }
      const rc = `PROMPT='user> '
alias user_alias='echo kept'
user_prompt() { PROMPT='dynamic> '; }
precmd_functions+=(user_prompt)
`;
      await writeFile(join(config, ".zshrc"), rc);
      launch = await prepareShell("/bin/zsh");
      const { stdout } = await exec(
        "/bin/zsh",
        [
          ...launch.args,
          "-c",
          `
for hook in $precmd_functions; do $hook; done
print -r -- "$PROMPT"
for hook in $precmd_functions; do $hook; done
print -r -- "$PROMPT"
print -r -- "\${ZDOTDIR-unset}"
alias user_alias
`,
        ],
        { env: launch.env },
      );
      const prefix = `%{${orange}%}(π)%{${reset}%} `;
      const lines = stdout.split("\n");
      expect(lines.slice(0, 2)).toEqual([
        `${prefix}dynamic> `,
        `${prefix}dynamic> `,
      ]);
      expect(lines[2]).toBe(kind === "home" ? "unset" : config);
      expect(stdout).toContain("echo kept");
      expect(await readFile(join(config, ".zshrc"), "utf8")).toBe(rc);
      expect(process.env.ZDOTDIR).toBe(kind === "custom" ? config : undefined);
    },
  );

  it("does not duplicate the badge on successive prompts", async () => {
    await writeFile(join(home, ".zshrc"), "PROMPT='plain> '\n");
    launch = await prepareShell("/bin/zsh");
    const { stdout } = await exec(
      "/bin/zsh",
      [
        ...launch.args,
        "-c",
        '_pi_shell_prompt; _pi_shell_prompt; print -rn -- "$PROMPT"',
      ],
      { env: launch.env },
    );
    expect(stdout).toBe(`%{${orange}%}(π)%{${reset}%} plain> `);
  });
});

it.skipIf(!existsSync("/bin/sh"))(
  "loads the original POSIX ENV before prepending the badge",
  async () => {
    const rc = join(home, "user's shrc");
    await writeFile(rc, "PS1='user> '\n");
    vi.stubEnv("ENV", rc);
    launch = await prepareShell("/bin/sh");
    const { stdout } = await exec(
      "/bin/sh",
      [...launch.args, "-c", 'printf "%s\\n%s" "$PS1" "$ENV"'],
      { env: launch.env },
    );
    expect(stdout).toBe(`${orange}(π)${reset} user> \n${rc}`);
    expect(process.env.ENV).toBe(rc);
  },
);
