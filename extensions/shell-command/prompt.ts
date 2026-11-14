import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// Keep the session badge orange, regardless of the user's prompt colors.
const orange = "\x1b[38;5;208m";
const reset = "\x1b[0m";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Load the user's normal startup files before installing a child-only badge. */
export async function prepareShell(shell: string) {
  const env = { ...process.env };
  const name = basename(shell);
  const directory = await mkdtemp(join(tmpdir(), "pi-shell-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  let args = ["-i"];
  try {
    if (name === "zsh") {
      const prefix = `%{${orange}%}(π)%{${reset}%} `;
      // ZDOTDIR only redirects startup while our shim is being loaded. Restore
      // it before sourcing user files, including changes made by .zshenv.
      await writeFile(
        join(directory, ".zshenv"),
        `${env.ZDOTDIR === undefined ? "unset ZDOTDIR" : `export ZDOTDIR=${quote(env.ZDOTDIR)}`}
[[ -r "\${ZDOTDIR-$HOME}/.zshenv" ]] && source "\${ZDOTDIR-$HOME}/.zshenv"
typeset -g _pi_shell_zdotdir=\${ZDOTDIR-$HOME}
typeset -g _pi_shell_zdotdir_set=\${+ZDOTDIR}
export ZDOTDIR=${quote(directory)}
`,
      );
      await writeFile(
        join(directory, ".zshrc"),
        `if (( _pi_shell_zdotdir_set )); then
  export ZDOTDIR=$_pi_shell_zdotdir
else
  unset ZDOTDIR
fi
[[ -r "$_pi_shell_zdotdir/.zshrc" ]] && source "$_pi_shell_zdotdir/.zshrc"
unset _pi_shell_zdotdir _pi_shell_zdotdir_set
_pi_shell_prompt() {
  local _pi_shell_exit=$?
  case "$PROMPT" in
    ${quote(prefix)}*) ;;
    *) PROMPT=${quote(prefix)}"$PROMPT" ;;
  esac
  return $_pi_shell_exit
}
precmd_functions+=(_pi_shell_prompt)
`,
      );
      env.ZDOTDIR = directory;
    } else if (name === "bash") {
      const prefix = `\\[${orange}\\](π)\\[${reset}\\] `;
      const rc = join(directory, "bashrc");
      await writeFile(
        rc,
        `[[ -r "$HOME/.bashrc" ]] && source "$HOME/.bashrc"
_pi_shell_prompt() {
  local _pi_shell_exit=$?
  case "$PS1" in
    ${quote(prefix)}*) ;;
    *) PS1=${quote(prefix)}"$PS1" ;;
  esac
  return $_pi_shell_exit
}
# Preserve both scalar and array PROMPT_COMMAND, including macOS Bash 3.
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
  PROMPT_COMMAND+=(_pi_shell_prompt)
else
  PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND$'\\n'}_pi_shell_prompt"
fi
`,
      );
      args = ["--rcfile", rc, "-i"];
    } else {
      // POSIX shells read ENV for interactive startup. Unlike Bash/Zsh they
      // have no portable pre-prompt hook; prepend once after their startup file.
      const rc = join(directory, "shrc");
      await writeFile(
        rc,
        `${env.ENV === undefined ? "unset ENV" : `export ENV=${quote(env.ENV)}`}
[ -n "\${ENV-}" ] && [ -r "$ENV" ] && . "$ENV"
PS1=${quote(`${orange}(π)${reset} `)}"\${PS1-\$ }"
`,
      );
      env.ENV = rc;
    }
    return { args, env, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
