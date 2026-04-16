# dpchamps-pi-harness

Custom [skills](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/docs/skills.md) and [extensions](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/docs/extensions.md) for the [pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Structure

```
skills/                  # SKILL.md files — instructions the LLM reads on-demand
  gemma4-subagent/       # Spawn a local Gemma 4 sub-agent for narrow coding tasks

extensions/              # TypeScript modules — register tools, commands, and event handlers
  web-fetch-tool/        # Registers the web_fetch tool (Reddit, Imgur, generic HTML)
    index.ts             # Extension entry point
    domains/             # Declarative domain configs (URL matchers, transforms)
    processors/          # Domain-specific JSON processors (Reddit, Imgur)
    package.json         # npm dependencies (readability, jsdom, turndown)
```

**Skills** are declarative — the LLM reads them and decides how to act. Good for open-ended workflows.

**Extensions** are programmatic — they register tools, commands, shortcuts, and event handlers. Good for deterministic operations.

## Naming Conventions

- **`<name>-tool`** — registers one or more tools via `pi.registerTool()`
- **`<name>-command`** — registers slash commands via `pi.registerCommand()`
- **`<name>-gate`** — intercepts/block tool calls or events via `pi.on("tool_call", ...)`
- **`<name>-handler`** — general event handling, UI customization, etc.

Extensions can combine concerns (e.g. a tool + a command) — name by the primary one.

## Installing

### As a pi package (recommended)

```bash
pi install /path/to/dpchamps-pi-skills
```

Pi auto-discovers extensions, skills, and other resources via the `pi` manifest in `package.json`. Use `/reload` after editing. Remove with `pi remove /path/to/dpchamps-pi-skills`.

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
ln -s $(pwd)/extensions/web-fetch-tool ~/.pi/agent/extensions/web-fetch-tool
```

</details>

## Contents

| Name                                           | Type             | Description                                                     |
| ---------------------------------------------- | ---------------- | --------------------------------------------------------------- |
| [gemma4-subagent](./skills/gemma4-subagent/)   | Skill            | Spawn a local Gemma 4 31B sub-agent for narrow coding tasks     |
| [web-fetch-tool](./extensions/web-fetch-tool/) | Extension (tool) | Fetch URLs and extract structured content (Reddit, Imgur, HTML) |
