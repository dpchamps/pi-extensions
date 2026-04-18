# dpchamps-pi-harness

Custom [skills](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/docs/skills.md) and [extensions](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/docs/extensions.md) for the [pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Contents

| Name | Type | Description |
|------|------|-------------|
| [autorouter](./extensions/autorouter/) | Extension | Auto-routes each prompt to the best model via classification |
| [clear-command](./extensions/clear-command/) | Extension (command) | `/clear` — wipe conversation context (keeps session & costs) |
| [web-fetch-tool](./extensions/web-fetch-tool/) | Extension (tool) | Fetch URLs and extract structured content (Reddit, Imgur, HTML) |

## Installing

### As a pi package (recommended)

```bash
pi install /path/to/dpchamps-pi-skills
```

Pi auto-discovers extensions and skills via the `pi` manifest in `package.json`. Use `/reload` after editing. Remove with `pi remove /path/to/dpchamps-pi-skills`.

For project-level installs (shared with your team):

```bash
pi install -l /path/to/dpchamps-pi-skills
```

### From npm or git (once published)

```bash
pi install npm:@dpchamps/pi-skills
pi install git:github.com/dpchamps/dpchamps-pi-skills
```

### Manual symlinks (alternative)

<details>
<summary>Click to expand</summary>

Skills:

```bash
ln -s $(pwd) ~/.pi/agent/skills/dpchamps-skills
```

Extensions:

```bash
ln -s $(pwd)/extensions/autorouter ~/.pi/agent/extensions/autorouter
ln -s $(pwd)/extensions/clear-command ~/.pi/agent/extensions/clear-command
ln -s $(pwd)/extensions/web-fetch-tool ~/.pi/agent/extensions/web-fetch-tool
```

</details>
