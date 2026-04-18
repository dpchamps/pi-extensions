/**
 * Autorouter Extension
 *
 * Routes each prompt to the best model by classifying task complexity/depth
 * with a cheap classifier model, then dispatching to your configured model.
 *
 * Config (merged, project takes precedence):
 *   - ~/.pi/agent/autorouter.json (global)
 *   - <cwd>/.pi/autorouter.json   (project-local)
 *
 * Toggle on/off: /autorouter
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";

// ── Config Types ────────────────────────────────────────────────────────────

interface RouteConfig {
  provider: string;
  model: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

interface AutorouterConfig {
  classifier: {
    provider: string;
    model: string;
    /** Categories map. Keys are route identifiers, values are human-facing descriptions. */
    categories: Record<string, string>;
    /** When classifier output doesn't match a known category or fails entirely. */
    fallback: string;
    /** Optional custom prompt template. Use {{categories}} and {{task}} as placeholders. */
    prompt?: string;
  };
  routes: Record<string, RouteConfig>;
  defaultModel: RouteConfig;
}

// ── Config Loading ──────────────────────────────────────────────────────────

function loadConfig(cwd: string): AutorouterConfig | null {
  const projectPath = join(cwd, ".pi", "autorouter.json");
  const globalPath = join(getAgentDir(), "autorouter.json");

  let config: Partial<AutorouterConfig> = {};
  let loaded = false;

  if (existsSync(globalPath)) {
    try {
      config = JSON.parse(readFileSync(globalPath, "utf-8"));
      loaded = true;
    } catch {
      // ignore
    }
  }

  if (existsSync(projectPath)) {
    try {
      config = { ...config, ...JSON.parse(readFileSync(projectPath, "utf-8")) };
      loaded = true;
    } catch {
      // ignore
    }
  }

  return loaded ? (config as AutorouterConfig) : null;
}

// ── Classifier ──────────────────────────────────────────────────────────────

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_PROMPT = `Classify the following developer task into exactly one category. Respond with ONLY the category name on a single line, nothing else.

Categories:
{{categories}}

Task: "{{task}}"

Category:`;

function buildClassifierPrompt(config: AutorouterConfig, task: string): string {
  const template = config.classifier.prompt ?? DEFAULT_PROMPT;
  const catList = Object.entries(config.classifier.categories)
    .map(([name, desc]) => `- ${name}: ${desc}`)
    .join("\n");
  return template
    .replace("{{categories}}", catList)
    .replace("{{task}}", task);
}

async function classify(config: AutorouterConfig, userPrompt: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("[autorouter] OPENROUTER_API_KEY not set, skipping classification");
    return config.classifier.fallback;
  }

  const { classifier } = config;

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/dpchamps/pi-autorouter",
        "X-Title": "pi-autorouter",
      },
      body: JSON.stringify({
        model: classifier.model,
        messages: [{ role: "user", content: buildClassifierPrompt(config, userPrompt) }],
        max_tokens: 10,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.error(`[autorouter] Classifier API error ${res.status}: ${await res.text().catch(() => "")}`);
      return classifier.fallback;
    }

    const data = await res.json();
    let category = data.choices?.[0]?.message?.content?.trim()?.toLowerCase() ?? "";

    // Strip markdown fences
    category = category.replace(/^```[\w-]*\n?/, "").replace(/\n?```$/, "").trim();

    if (category in config.routes) return category;

    console.warn(`[autorouter] Unknown category "${category}", using fallback`);
    return classifier.fallback;
  } catch (err) {
    console.error(`[autorouter] Classifier failed: ${err}`);
    return classifier.fallback;
  }
}

// ── State ───────────────────────────────────────────────────────────────────

let config: AutorouterConfig | null = null;
let enabled = true;
let savedModel: Model<Api> | undefined;
let savedThinking: ReturnType<ExtensionAPI["getThinkingLevel"]> | undefined;
let activeRoute: string | null = null;

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── /autorouter command ─────────────────────────────────────────────────
  pi.registerCommand("autorouter", {
    description: "Toggle or check autorouter status",
    getArgumentCompletions: () => [
      { value: "on", label: "on" },
      { value: "off", label: "off" },
    ],
    async handler(args, ctx) {
      await ctx.waitForIdle();
      if (!config) {
        ctx.ui.notify("No autorouter.json found", "warning");
        return;
      }

      if (args?.trim()) {
        const arg = args.trim().toLowerCase();
        if (["on", "enable", "1", "true"].includes(arg)) {
          enabled = true;
          ctx.ui.setStatus("autorouter", ctx.ui.theme.fg("accent", `⟳ autorouter`));
          ctx.ui.notify("Autorouter enabled", "info");
        } else if (["off", "disable", "0", "false"].includes(arg)) {
          enabled = false;
          ctx.ui.setStatus("autorouter", ctx.ui.theme.fg("accent", `⟳ autorouter (off)`));
          ctx.ui.notify("Autorouter disabled", "info");
        } else {
          ctx.ui.notify(`Unknown: "${args.trim()}". Use /autorouter on|off`, "warning");
        }
        return;
      }

      // Show selector
      const choice = await ctx.ui.select("Autorouter", [
        `Currently: ${enabled ? "enabled" : "disabled"}`,
        "Enable",
        "Disable",
      ]);
      if (!choice || choice === "status") return;
      enabled = choice === "Enable";
      ctx.ui.setStatus("autorouter", ctx.ui.theme.fg("accent", enabled ? `⟳ autorouter` : `⟳ autorouter (off)`));
      ctx.ui.notify(`Autorouter ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });

  // ── Session start ───────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    enabled = true;
    if (config) {
      ctx.ui.setStatus("autorouter", ctx.ui.theme.fg("accent", `⟳ autorouter`));
    } else {
      ctx.ui.setStatus("autorouter", undefined);
    }
  });

  // ── Before agent turn: classify + switch model ───────────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled || !config) return;

    const prevModel = ctx.model;
    const prevThinking = pi.getThinkingLevel();
    activeRoute = null;

    const category = await classify(config, event.prompt);
    const route =
      config.routes[category] ??
      config.routes[config.classifier.fallback] ??
      config.defaultModel;

    const model = ctx.modelRegistry.find(route.provider, route.model);
    if (!model) {
      console.warn(`[autorouter] Model ${route.provider}/${route.model} not found in registry`);
      return;
    }

    await pi.setModel(model);
    savedModel = prevModel;
    savedThinking = prevThinking;
    activeRoute = `${category} → ${model.id}`;

    if (route.thinking) {
      pi.setThinkingLevel(route.thinking);
    }
  });

  // ── After agent turn: restore previous model ────────────────────────────
  pi.on("agent_end", async () => {
    if (savedModel) {
      await pi.setModel(savedModel);
      savedModel = undefined;
    }
    if (savedThinking !== undefined) {
      pi.setThinkingLevel(savedThinking as any);
      savedThinking = undefined;
    }
  });

  // ── Turn start: show active route in status ─────────────────────────────
  pi.on("turn_start", async (_event, ctx) => {
    if (activeRoute) {
      ctx.ui.setStatus("autorouter", ctx.ui.theme.fg("accent", `⟳ ${activeRoute}`));
    }
  });
}