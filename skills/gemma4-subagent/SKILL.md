---
name: gemma4-subagent
description: Spawn a local Gemma 4 31B sub-agent for narrow, well-scoped coding tasks like implementing functions, fixing bugs, refactoring, drafting code, and explaining snippets. Free and fast — runs locally via vLLM. Use to offload straightforward work from the main model.
---

# Gemma 4 Subagent

Spawn a local Gemma 4 31B sub-agent for simple coding tasks. Runs locally, costs nothing, and is good at writing code when given clear, narrow instructions.

## What Gemma 4 Is Good At

- **Implementing** — "Add a `validateEmail` function that returns a boolean"
- **Fixing** — "Fix the off-by-one error in this loop: [code]"
- **Drafting** — "Write an Express rate-limiting middleware using this pattern: [example]"
- **Refactoring** — "Convert this callback function to async/await: [code]"
- **Explaining** — "What does this function do? [code]"

## What Gemma 4 Is NOT Good At

- Searching across a large codebase to figure out what to do
- Tasks requiring broad context or understanding of the full project
- Open-ended design decisions or architecture choices
- Multi-file refactors that require chasing dependencies

## CRITICAL: How to Delegate

Gemma 4 has a **narrow context window** and cannot explore effectively. You must **pre-gather context** before spawning it.

**Your job as the main agent:**

1. **Read the relevant files yourself first** — understand the code, the types, the patterns
2. **Craft a self-contained prompt** — include or reference everything the subagent needs
3. **Be specific** — exact file paths, exact function signatures, exact expected behavior
4. **One task per spawn** — one function, one file, one clear objective

### Good delegation

```
pi -p --provider ollama --model gemma4-31b --session /tmp/validate-email.jsonl \
  "In src/validators.ts, add a validateEmail function after the existing validatePhone function.
   It should accept a string, return a boolean, and use a standard email regex.
   Here is the current file for reference:
   [paste file contents]"
```

### Bad delegation

```
pi -p --provider ollama --model gemma4-31b --session /tmp/improve-auth.jsonl \
  "Make the auth module better"
```

The first gives Gemma 4 everything it needs. The second asks it to explore and design — it will fail.

---

## Usage

### Synchronous (wait for result)

```bash
pi -p --provider ollama --model gemma4-31b --session /tmp/taskname.jsonl "your prompt here"
```

### Asynchronous (background task)

```bash
# Start in tmux
tmux new-session -d -s taskname 'pi -p --provider ollama --model gemma4-31b --session /tmp/taskname.jsonl "your prompt here" > /tmp/taskname-result.txt 2>&1'

# Check if running
tmux has-session -t taskname 2>/dev/null && echo "running" || echo "done"

# Read result when done
cat /tmp/taskname-result.txt
```

### Analysis-only (no edits)

If you only need analysis or explanation and want to prevent the subagent from modifying files:

```bash
pi -p --provider ollama --model gemma4-31b --tools read --session /tmp/taskname.jsonl "explain the flow in this file: [paste contents]"
```

## Flags

- `-p` / `--print`: Non-interactive mode, outputs final response only
- `--session <file>`: Save session to specified JSONL file
- `--provider ollama`: Always use `ollama` for Gemma 4
- `--model gemma4-31b`: Always use `gemma4-31b`
- `--thinking <level>`: Set thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` (default: uses model default)
- `--tools <tools>`: Comma-separated list of tools (default: `read,bash,edit,write`)

## Viewing subagent session

Export and open the session to review what the subagent did:

```bash
pi --export /tmp/taskname.jsonl /tmp/taskname.html && open /tmp/taskname.html
```

## When to Use

- You need code written and the task is narrow enough to describe in one prompt
- You want to offload straightforward implementation work from the main model
- You need a quick explanation of a specific code snippet
- You want to parallelize: keep working on the main task while Gemma 4 handles a subtask in the background

## When NOT to Use

- The task requires understanding the full project architecture
- You can't fit the relevant context into the prompt
- The task is open-ended or requires design decisions
- The task requires searching across many files to figure out what to do
