import { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { completeSimple, type Model, type Api } from "@mariozechner/pi-ai";
import { AutorouterConfig } from "./types";

const DEFAULT_PROMPT = `Classify the following developer task into exactly one category. Respond with ONLY the category name on a single line, nothing else.

Categories:
{{categories}}

Task: "{{task}}"

Category:`;

const DEFAULT_CLASSIFIER_GUIDANCE = `

Think about what the user is asking:
- Is it a quick, single-action task (run test, format, lint, check status, simple read)? → TRIVIAL
- Does it need analysis, debugging, multi-step work, or code changes? → NORMAL
- Is it architecturally complex or requires deep investigation? → COMPLEX`;

export function normalizeCategory(raw: string): string {
  return raw
    .replace(/^```[\w-]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim()
    .toLowerCase();
}

function buildClassifierPrompt(
  config: AutorouterConfig,
  prompt: string,
  branch?: any[],
): string {
  const { classifier } = config;
  const template = classifier.prompt ?? DEFAULT_PROMPT;
  const guidance = classifier.guidance ?? DEFAULT_CLASSIFIER_GUIDANCE;
  const catList = Object.entries(classifier.categories)
    .map(([name, desc]) => `- ${name}: ${desc}`)
    .join("\n");

  // Build context if branch history is available
  let context = prompt;
  if (branch) {
    const ctx = buildClassifierContext(prompt, branch);
    context = ctx.history
      ? `${ctx.history}\n\nCurrent request: ${prompt}`
      : prompt;
  }

  return (template + guidance)
    .replace("{{categories}}", catList)
    .replace("{{task}}", context);
}

export interface ClassifierContext {
  /** The user's raw prompt */
  prompt: string;
  /** Last 2 conversation exchanges for context */
  history: string;
  /** If a token override was detected, the route it maps to */
  forcedRoute?: string;
}

/**
 * Build context for the classifier from the current state.
 * Includes the most recent assistant response so follow-ups like "yes" get routed correctly.
 */
export function buildClassifierContext(
  userPrompt: string,
  branch: any[],
  forcedRoute?: string,
): ClassifierContext {
  // Find the most recent assistant message
  let lastAssistantResponse = "";
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message" && entry.message?.role === "assistant") {
      lastAssistantResponse = entry.message?.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n") ?? "";
      break;
    }
  }

  const history = lastAssistantResponse
    ? `\n\nLast Assistant Response: "${lastAssistantResponse.slice(0, 150).replace(/\\n/g, " ")}..."`
    : "";

  return {
    prompt: userPrompt,
    history,
    forcedRoute,
  };
}

export async function classify(
  config: AutorouterConfig,
  userPrompt: string,
  modelRegistry: ModelRegistry,
  branch?: any[],
): Promise<string> {
  const { classifier } = config;

  const classifierModel = modelRegistry.find(classifier.provider, classifier.model);
  if (!classifierModel) return classifier.fallback;

  const auth = await modelRegistry.getApiKeyAndHeaders(classifierModel);
  if (!auth.ok) return classifier.fallback;

  try {
    const classifierPrompt = buildClassifierPrompt(config, userPrompt, branch);

    const response = await completeSimple(
      classifierModel,
      {
        systemPrompt: "You are a task classifier. Respond with ONLY a single category name.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: classifierPrompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: 20,
        temperature: 0,
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: AbortSignal.timeout(15000),
      },
    );

    const category = normalizeCategory(
      response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("")
    );

    if (category in config.routes) return category;
    return classifier.fallback;
  } catch (err) {
    return classifier.fallback;
  }
}
