# thinking-tool

Calls the VibeThinker-3B reasoning model for complex reasoning tasks.

## Overview

This extension registers a `think` tool that can be called by the pi agent to get reasoning assistance from the VibeThinker-3B model. VibeThinker-3B excels at tasks with clear verification signals:
- Mathematical reasoning
- Competitive programming
- STEM problems
- Complex step-by-step analysis

## Usage

The tool is automatically available when VibeThinker-3B is running at the configured endpoint.

### VibeThinker API

The tool calls the OpenAI-compatible API at `http://192.168.0.40:8000/v1` (or `$VIBETHINKER_ENDPOINT`).

### Output Format

The tool returns:
1. **Reasoning Process** - The full reasoning trace from VibeThinker
2. **Answer** - The final answer or solution

Example output:
```
## Reasoning Process
Let's break this down step by step...

## Answer
The solution is 42.
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|--|---------|--|
| `VIBETHINKER_ENDPOINT` | `http://192.168.0.40:8000/v1` | VibeThinker API endpoint |
| `VIBETHINKER_MODEL_ID` | `WeiboAI/VibeThinker-3B` | Model ID for the API |
| `VIBETHINKER_MAX_TOKENS` | `8192` | Maximum tokens for generation |
| `VIBETHINKER_TEMPERATURE` | `0.6` | Temperature for sampling |
| `VIBETHINKER_TOP_P` | `0.95` | Top-p for sampling |

### Example: Running VibeThinker-3B

To run the model locally using vLLM:

```bash
# Using vLLM (recommended for performance)
python -m vllm.entrypoints.openai.api_server \
  --model WeiboAI/VibeThinker-3B \
  --host 0.0.0.0 \
  --port 8000

# Or using Hugging Face transformers
python -m transformers-cli chat \
  --model WeiboAI/VibeThinker-3B \
  --port 8000
```

## Integration with pi

Once installed, the `think` tool will be available to the pi agent. The agent can call it by including `{"name": "think", "arguments": {"prompt": ".."}}` in its tool call requests.

## Example: Agent Using the Tool

**User**: "Solve: If x + y = 10 and x - y = 4, what is x?"

**Agent calls**:
```json
{"name": "think", "arguments": {"prompt": "Solve: If x + y = 10 and x - y = 4, what is x?"}}
```

**Tool returns**:
```
## Reasoning Process
We have two equations:
1. x + y = 10
2. x - y = 4

Adding equations 1 and 2:
(x + y) + (x - y) = 10 + 4
2x = 14
x = 7

## Answer
7
```

The agent can then present this to the user with full reasoning.

## Installation

Add to your pi configuration or install via the package manager:

```bash
pi install git:github.com/dpchamps/dpchamps-pi-harness
```

Or symlink the extension directory:

```bash
ln -s /path/to/dpchamps-pi-harness/extensions/thinking-tool ~/.pi/extensions/
```
