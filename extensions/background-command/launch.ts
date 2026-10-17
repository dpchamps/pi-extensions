import { existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { getPackageDir, parseArgs } from "@earendil-works/pi-coding-agent";

export interface Invocation {
  command: string;
  args: string[];
}

/** Use this host's installation, never an unrelated `pi` found on PATH. */
export function hostInvocation(execPath = process.execPath): Invocation {
  if (!/^(node|bun)(\.exe)?$/i.test(basename(execPath)))
    return { command: execPath, args: [] };
  const cli = join(getPackageDir(), "dist", "cli.js");
  if (!existsSync(cli)) throw new Error("Cannot locate this host's Pi CLI");
  return { command: execPath, args: [cli] };
}

/** Carry resource/restriction flags, not prompts, files, session targets, or
 * one-shot CLI actions. Relative resources remain relative to the launch cwd. */
export function inheritedArgs(
  argv: string[],
  cwd: string,
  currentProvider?: string,
  startupProvider?: string,
): string[] {
  const parsed = parseArgs(argv);
  if (parsed.diagnostics.some((item) => item.type === "error")) {
    throw new Error("Cannot safely inherit invalid Pi launch arguments");
  }
  const args: string[] = [];
  const value = (flag: string, data: string | undefined) => {
    if (data !== undefined) args.push(flag, data);
  };
  const resource = (input: string) => {
    if (/^(builtin:|npm:|git:|https?:|~)/.test(input) || isAbsolute(input))
      return input;
    return resolve(cwd, input);
  };
  const promptValue = (input: string) =>
    existsSync(resolve(cwd, input)) ? resolve(cwd, input) : input;
  if (parsed.apiKey) {
    // A CLI override belongs to the provider selected at startup. Never send
    // that secret to a different provider after the foreground model changes.
    const keyProvider = startupProvider ?? parsed.provider;
    if (!keyProvider || !currentProvider)
      throw new Error(
        "Cannot safely scope the inherited CLI API key to a provider",
      );
    if (keyProvider === currentProvider) value("--api-key", parsed.apiKey);
  }
  value(
    "--system-prompt",
    parsed.systemPrompt === undefined
      ? undefined
      : promptValue(parsed.systemPrompt),
  );
  for (const prompt of parsed.appendSystemPrompt ?? [])
    value("--append-system-prompt", promptValue(prompt));
  for (const [flag, items] of [
    ["--extension", parsed.extensions],
    ["--skill", parsed.skills],
    ["--prompt-template", parsed.promptTemplates],
    ["--theme", parsed.themes],
  ] as const)
    for (const item of items ?? []) value(flag, resource(item));
  for (const [flag, enabled] of [
    ["--no-extensions", parsed.noExtensions],
    ["--no-mcp", parsed.noMcp],
    ["--no-tools", parsed.noTools],
    ["--no-builtin-tools", parsed.noBuiltinTools],
    ["--no-skills", parsed.noSkills],
    ["--no-prompt-templates", parsed.noPromptTemplates],
    ["--no-themes", parsed.noThemes],
    ["--no-context-files", parsed.noContextFiles],
    ["--offline", parsed.offline],
  ] as const)
    if (enabled) args.push(flag);
  if (parsed.tools) value("--tools", parsed.tools.join(","));
  if (parsed.excludeTools)
    value("--exclude-tools", parsed.excludeTools.join(","));
  if (parsed.projectTrustOverride !== undefined)
    args.push(parsed.projectTrustOverride ? "--approve" : "--no-approve");
  for (const [name, data] of parsed.unknownFlags) {
    // Extension values are kept exactly as Pi parsed them. They may contain
    // credentials and must never be included in diagnostics or status text.
    args.push(typeof data === "string" ? `--${name}=${data}` : `--${name}`);
  }
  return args;
}
