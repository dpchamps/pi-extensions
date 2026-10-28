export type TaskKind = "oracle" | "focus" | "goal";

export interface ParsedTaskArgs {
  kind: TaskKind;
  prompt: string;
  verify?: string;
  limit?: number;
}

export type TaskArgsResult =
  | { ok: true; value: ParsedTaskArgs }
  | { ok: false; error: string };

interface TokenizeResult {
  tokens?: string[];
  error?: string;
}

/** Small shell-like tokenizer for quoted flag values. It does not expand variables. */
function tokenize(input: string): TokenizeResult {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quote) {
      if (char === quote) {
        quote = undefined;
        started = true;
      } else if (char === "\\" && quote === '"') {
        index += 1;
        if (index >= input.length)
          return { error: "unfinished escape sequence" };
        current += input[index];
        started = true;
      } else {
        current += char;
        started = true;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      index += 1;
      if (index >= input.length) return { error: "unfinished escape sequence" };
      current += input[index];
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (quote) return { error: `unterminated ${quote} quote` };
  if (started) tokens.push(current);
  return { tokens };
}

function parseKind(value: string): TaskKind | undefined {
  return value === "oracle" || value === "focus" || value === "goal"
    ? value
    : undefined;
}

export function parseTaskArgs(input: string): TaskArgsResult {
  const tokenized = tokenize(input.trim());
  if (tokenized.error) return { ok: false, error: tokenized.error };
  const tokens = tokenized.tokens ?? [];

  let kind: TaskKind = "oracle";
  let kindWasSet = false;
  let verify: string | undefined;
  let limit: number | undefined;
  let optionsEnded = false;
  const promptParts: string[] = [];

  const setKind = (value: string): string | undefined => {
    const parsed = parseKind(value);
    if (!parsed)
      return `unknown task type ${JSON.stringify(value)}; expected oracle, focus, or goal`;
    if (kindWasSet) return "task type was specified more than once";
    kind = parsed;
    kindWasSet = true;
    return undefined;
  };

  const takeValue = (
    name: string,
    inline: string | undefined,
    index: number,
  ): { value?: string; next: number; error?: string } => {
    if (inline !== undefined)
      return inline.length
        ? { value: inline, next: index }
        : { next: index, error: `${name} requires a value` };
    if (index + 1 >= tokens.length)
      return { next: index, error: `${name} requires a value` };
    return { value: tokens[index + 1], next: index + 1 };
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (optionsEnded) {
      promptParts.push(token);
      continue;
    }
    if (token === "--") {
      optionsEnded = true;
      continue;
    }

    if (token === "--oracle" || token === "--focus" || token === "--goal") {
      const error = setKind(token.slice(2));
      if (error) return { ok: false, error };
      continue;
    }

    if (token.startsWith("-") && token !== "-") {
      const equal = token.indexOf("=");
      const rawName = equal >= 0 ? token.slice(0, equal) : token;
      const inline = equal >= 0 ? token.slice(equal + 1) : undefined;
      const name =
        rawName === "-t"
          ? "--type"
          : rawName === "-v"
            ? "--verify"
            : rawName === "-l"
              ? "--limit"
              : rawName === "--kind"
                ? "--type"
                : rawName;

      if (name === "--type") {
        const taken = takeValue(name, inline, index);
        if (taken.error) return { ok: false, error: taken.error };
        index = taken.next;
        const error = setKind(taken.value!);
        if (error) return { ok: false, error };
        continue;
      }
      if (name === "--verify") {
        if (verify !== undefined)
          return { ok: false, error: "--verify was specified more than once" };
        const taken = takeValue(name, inline, index);
        if (taken.error) return { ok: false, error: taken.error };
        index = taken.next;
        verify = taken.value;
        continue;
      }
      if (name === "--limit") {
        if (limit !== undefined)
          return { ok: false, error: "--limit was specified more than once" };
        const taken = takeValue(name, inline, index);
        if (taken.error) return { ok: false, error: taken.error };
        index = taken.next;
        if (!/^\d+$/.test(taken.value!) || Number(taken.value) < 1)
          return { ok: false, error: "--limit must be a positive integer" };
        limit = Number(taken.value);
        continue;
      }
      return { ok: false, error: `unknown flag ${JSON.stringify(rawName)}` };
    }

    promptParts.push(token);
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) return { ok: false, error: "a task prompt is required" };

  if (kind === "oracle") {
    if (!verify) return { ok: false, error: "oracle tasks require --verify" };
    if (limit !== undefined)
      return { ok: false, error: "--limit is only valid for focus tasks" };
  } else {
    if (verify !== undefined)
      return {
        ok: false,
        error: `--verify is only valid for oracle tasks, not ${kind}`,
      };
    if (kind === "goal" && limit !== undefined)
      return { ok: false, error: "--limit is only valid for focus tasks" };
  }

  return { ok: true, value: { kind, prompt, verify, limit } };
}
