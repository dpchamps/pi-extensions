# dpchamps-pi-harness

Custom [skills](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/docs/skills.md) and [extensions](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/docs/extensions.md) for the [pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Contents

| Name | Type | Description |
|------|------|-------------|
| [autorouter](./extensions/autorouter/) | Extension | Auto-routes each prompt to the best model via classification |
| [background-command](./extensions/background-command/) | Extension (command) | `/background` — detach running task into a supervised pi RPC child; list/resume/kill/delete |
| [clear-command](./extensions/clear-command/) | Extension (command) | `/clear` — wipe conversation context (keeps session & costs) |
| [file-command](./extensions/file-command/) | Extension (command) | `/file <path>` — open a file in `$VISUAL`/`$EDITOR` |
| [ralph](./extensions/ralph/) | Extension (command) | `/ralph` — loop a prompt until a verify script exits 0 |
| [web-fetch-tool](./extensions/web-fetch-tool/) | Extension (tool) | Fetch URLs and extract structured content from webpages and supported domains |
| [worktree-command](./extensions/worktree-command/) | Extension (command) | `/worktree` — fork branch into `.worktrees/`, switch/merge/cleanup, with autocomplete |

## Installing

```bash
pi install git:github.com/dpchamps/dpchamps-pi-skills
```

