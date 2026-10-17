# dpchamps-pi-harness

Custom [skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md) and [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) for the [pi coding agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).

## Development

Active extensions target **Pi 1.3.0** using the `@earendil-works` packages and Pi's host-provided TypeBox. Deprecated experiments retain their legacy dependencies and are not loaded automatically.

```bash
npm install --ignore-scripts
npm run typecheck
npm test
```

The compatibility tests load every active extension through Pi and verify that `before_agent_start` runs once per agent run, while unchanged named prompt sections are not appended again.

## Contents

| Name | Type | Description |
|------|------|-------------|
| [background-command](./extensions/background-command/) | Extension (command) | `/background` — detach running task into a supervised pi RPC child; list/resume/kill/delete |
| [clear-command](./extensions/clear-command/) | Extension (command) | `/clear` — wipe conversation context (keeps session & costs) |
| [file-command](./extensions/file-command/) | Extension (command) | `/file <path>` — open a file in `$VISUAL`/`$EDITOR` |
| [pipeline-command](./extensions/pipeline-command/) | Extension (command) | `/pipeline` — execute JSON-defined pipelines of agent steps with optional model/system-prompt/script/worktree overrides |
| [task](./extensions/task/) | Extension (command) | `/task` — run a task until a verification command succeeds (loop with nudges, cap, abort-on-input) |
| [web-fetch-tool](./extensions/web-fetch-tool/) | Extension (tool) | Fetch URLs and extract structured content from webpages and supported domains |
| [worktree-command](./extensions/worktree-command/) | Extension (command) | `/worktree` — fork branch into `.worktrees/`, switch/merge/cleanup, with autocomplete |

## Deprecated

| Name | Type | Description |
|------|------|-------------|
| [autorouter](./extensions/autorouter/) | Extension | Auto-routes each prompt to the best model via classification |
| [thinking-tool](./extensions/thinking-tool/) | Extension (tool) | `/think` — call VibeThinker-3B for complex reasoning tasks with full traces |

These were early experiments and largely failures. They are **no longer loaded by pi** — the repo root `package.json` excludes them via `!extensions/...` entries in the `pi.extensions` manifest. Their code is kept in the repo for reference only.

## Installing

```bash
pi install git:github.com/dpchamps/dpchamps-pi-harness
```

## Quick Start: VibeThinker-3B Thinking Tool

> **Deprecated:** thinking-tool was an early experiment and is no longer loaded by pi. The steps below are kept for reference only.

1. **Run VibeThinker-3B** (must be accessible at the endpoint):
   ```bash
   # With vLLM
   python -m vllm.entrypoints.openai.api_server --model WeiboAI/VibeThinker-3B --port 8000
   ```

2. **Set the endpoint**:
   ```bash
   export VIBETHINKER_ENDPOINT="http://192.168.0.40:8000/v1"
   ```

3. **Start pi with extensions**:
   ```bash
   pi -e ./extensions
   ```

4. **The agent will automatically use the `think` tool** for complex reasoning tasks

See [AGENTS.md](./AGENTS.md) for full documentation on all extensions.

## VibeThinker-3B Background

> **Deprecated:** the thinking-tool extension described below is an early experiment and is no longer loaded by pi. Kept for reference only.

VibeThinker-3B is a 3B-parameter model optimized for verifiable reasoning tasks:
- **76.4** on IMO-AnswerBench (IMO-level math)
- **96.1%** acceptance rate on recent LeetCode contests
- **94.3** on AIME26

The model returns full reasoning traces, allowing the agent to show its work and enabling verification of correctness. See the [Hugging Face page](https://huggingface.co/WeiboAI/VibeThinker-3B) for details.

### Why a Separate Tool?

VibeThinker-3B excels at reasoning but isn't designed for general-purpose dialogue or tool use. By exposing it as a tool, the pi agent can:
- Call it only when reasoning is needed
- Incorporate the full reasoning trace into context
- Let a general-purpose model handle synthesis and interaction
