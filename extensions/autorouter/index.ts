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
 *
 * Sticky turns: stays on the classified model for N subsequent prompts
 * before reclassifying. Config: { "stickyTurns": 3 } in autorouter.json.
 *
 * Token override: "autorouter:<route>" anywhere in the prompt forces that
 * route immediately (no classifier call). The token is stripped before
 * the prompt reaches the model.
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
  /** Number of user prompts to stay on the classified route before reclassifying. 0 = disabled. */
  stickyTurns?: number;
  classifier: {
    provider: string;
    model: string;
    categories: Record<string, string>;
    fallback: string;
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

    category = category.replace(/^```[\w-]*\n?/, "").replace(/\n?```$/, "").trim();

    if (category in config.routes) return category;

    console.warn(`[autorouter] Unknown category "${category}", using fallback`);
    return classifier.fallback;
  } catch (err) {
    console.error(`[autorouter] Classifier failed: ${err}`);
    return config.classifier.fallback;
  }
}

// ── Token Override Parser ──────────────────────────────────────────────────

// Matches "autorouter:<route>" (case-insensitive) anywhere in the prompt.
// e.g. "fix the bug autorouter:trivial" → route = "trivial", cleaned = "fix the bug"
function parseToken(text: string): { route: string; cleaned: string } | null {
  const m = text.match(/autorouter:(\w+)/i);
  if (!m) return null;
  const route = m[1].toLowerCase();
  const cleaned = text.replace(/autorouter:\w+/i, "").replace(/\s+/g, " ").trim();
  return { route, cleaned: cleaned || " " }; // ensure non-empty
}

// ── State ───────────────────────────────────────────────────────────────────

let config: AutorouterConfig | null = null;
let enabled = true;
let savedModel: Model<Api> | undefined;
let savedThinking: ReturnType<ExtensionAPI["getThinkingLevel"]> | undefined;
let activeRoute: string | null = null;

// Sticky routing state
let stickyRoute: string | null = null; // the route key to reuse
let stickyModel: Model<Api> | undefined; // the model to keep
let stickyThinking: ReturnType<ExtensionAPI["getThinkingLevel"]> | undefined;
let stickyRemaining = 0; // remaining sticky turns; 0 = classify next time

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
          stickyRemaining = 0;
          ctx.ui.setStatus("autorouter", ctx.ui.theme.fg("accent", `⟳ autorouter (off)`));
          ctx.ui.notify("Autorouter disabled", "info");
        } else {
          ctx.ui.notify(`Unknown: "${args.trim()}". Use /autorouter on|off`, "warning");
        }
        return;
      }

      const choice = await ctx.ui.select("Autorouter", [
        `Currently: ${enabled ? "enabled" : "disabled"}`,
        "Enable",
        "Disable",
      ]);
      if (!choice || choice === "status") return;
      enabled = choice === "Enable";
      if (!enabled) stickyRemaining = 0;
      ctx.ui.setStatus("autorouter", ctx.ui.theme.fg("accent", enabled ? `⟳ autorouter` : `⟳ autorouter (off)`));
      ctx.ui.notify(`Autorouter ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });

  // ── Session start ───────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    enabled = true;
    stickyRemaining = 0;
    stickyRoute = null;
    stickyModel = undefined;
    stickyThinking = undefined;
    if (config) {
      ctx.ui.setStatus("autorouter", ctx.ui.theme.fg("accent", `⟳ autorouter`));
    } else {
      ctx.ui.setStatus("autorouter", undefined);
    }
  });

  // ── Input: strip autorouter: token before passing to agent ─────────────
  pi.on("input", async (event, ctx) => {
    if (!enabled || !config) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };

    const token = parseToken(event.text);
    if (token) {
      // Validate the route exists
      if (!(token.route in config.routes) && !(token.route === config.classifier.fallback)) {
        ctx.ui.notify(
          `[autorouter] Unknown route "${token.route}". Using classifier.`,
          "warning",
        );
        return { action: "continue" };
      }
      ctx.ui.notify(`[autorouter] Token override → ${token.route}`, "info");
      return { action: "transform", text: token.cleaned };
    }

    return { action: "continue" };
  });

  // ── Before agent turn: route + switch model ────────────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled || !config) return;

    const prevModel = ctx.model;
    const prevThinking = pi.getThinkingLevel();
    activeRoute = null;

    // Check for autorouter: token (already stripped in input, but store it here
    // by checking the event prompt for "autorouter:" for safety)
    const token = parseToken(event.prompt);
    let routeKey: string | null = null;

    if (token) {
      routeKey = token.route;
    } else if (stickyRemaining > 0 && stickyRoute && stickyModel) {
      // Reuse sticky route — decrement counter
      stickyRemaining--;
      activeRoute = `🔒 ${stickyRoute} (${stickyRemaining} left)`;
      await pi.setModel(stickyModel);
      if (stickyThinking) pi.setThinkingLevel(stickyThinking);
      return;
    } else {
      // Classify
      routeKey = await classify(config, event.prompt);
    }

    const route =
      config.routes[routeKey!] ??
      config.routes[config.classifier.fallback] ??
      config.defaultModel;

    const model = ctx.modelRegistry.find(route.provider, route.model);
    if (!model) {
      console.warn(`[autorouter] Model ${route.provider}/${route.model} not found`);
      return;
    }

    await pi.setModel(model);

    // Save state for restoration only on non-sticky (we keep sticky state separately)
    savedModel = prevModel;
    savedThinking = prevThinking;

    // Set sticky state
    const stickyTurns = config.stickyTurns ?? 0;
    if (stickyTurns > 0) {
      stickyRoute = routeKey!;
      stickyModel = model;
      stickyThinking = route.thinking
        ? (route.thinking as ReturnType<ExtensionAPI["getThinkingLevel"]>)
        : prevThinking;
      stickyRemaining = stickyTurns;
      activeRoute = `${routeKey} → ${model.id} (${stickyRemaining} sticky)`;
    } else {
      activeRoute = `${routeKey} → ${model.id}`;
    }

    if (route.thinking) {
      pi.setThinkingLevel(route.thinking);
    }
  });

  // ── After agent turn: restore non-sticky model ─────────────────────────
  pi.on("agent_end", async () => {
    // Only restore if not in sticky mode
    if (stickyRemaining === 0 && savedModel) {
      await pi.setModel(savedModel);
      savedModel = undefined;
    }
    if (stickyRemaining === 0 && savedThinking !== undefined) {
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