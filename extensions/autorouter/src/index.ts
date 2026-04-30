import type { ExtensionAPI, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";
import { loadConfig } from "./config";
import { classify } from "./classifier";
import { parseToken } from "./token-parser";
import { AutorouterState } from "./state";
import { AutorouterConfig, ThinkingLevel } from "./types";

const NS = "[autorouter]";

export default function (pi: ExtensionAPI) {
  const state = new AutorouterState();

  const updateModelStatus = (ctx: any) => {
    const id = ctx.model?.id;
    if (id) {
      ctx.ui.setStatus("model", ctx.ui.theme.fg("accent", id));
    }
  };

  pi.registerCommand("autorouter", {
    description: "Toggle or check autorouter status",
    getArgumentCompletions: () => [
      { value: "on", label: "on" },
      { value: "off", label: "off" },
    ],
    async handler(args, ctx) {
      await ctx.waitForIdle();
      if (!state.config) {
        ctx.ui.notify("No autorouter.json found", "warning");
        return;
      }

      if (args?.trim()) {
        const arg = args.trim().toLowerCase();
        if (["on", "enable", "1", "true"].includes(arg)) {
          state.enabled = true;
          ctx.ui.setStatus("autorouter", ctx.ui.theme.fg("accent", `⟳ autorouter`));
          ctx.ui.notify("Autorouter enabled", "info");
        } else if (["off", "disable", "0", "false"].includes(arg)) {
          state.enabled = false;
          state.tokenRoute = null;
          state.resetSticky();
          ctx.ui.setStatus("autorouter", ctx.ui.theme.fg("accent", `⟳ autorouter (off)`));
          ctx.ui.notify("Autorouter disabled", "info");
        } else {
          ctx.ui.notify(`Unknown: "${args.trim()}". Use /autorouter on|off`, "warning");
        }
        return;
      }

      const choice = await ctx.ui.select("Autorouter", [
        `Currently: ${state.enabled ? "enabled" : "disabled"}`,
        "Enable",
        "Disable",
      ]);
      if (!choice || choice === "status") return;
      state.enabled = choice === "Enable";
      if (!state.enabled) {
        state.tokenRoute = null;
        state.resetSticky();
      }
      ctx.ui.setStatus("autorouter", ctx.ui.theme.fg("accent", state.enabled ? `⟳ autorouter` : `⟳ autorouter (off)`));
      ctx.ui.notify(`Autorouter ${state.enabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    state.config = loadConfig(ctx.cwd);
    state.enabled = state.config?.enabled ?? true;
    state.tokenRoute = null;
    state.resetSticky();
    if (state.config) {
      ctx.ui.setStatus(
        "autorouter",
        ctx.ui.theme.fg("accent", state.enabled ? `⟳ autorouter` : `⟳ autorouter (off)`),
      );
      updateModelStatus(ctx);
    } else {
      ctx.ui.setStatus("autorouter", undefined);
    }
  });

  pi.on("input", async (event, ctx) => {
    if (!state.enabled || !state.config) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };

    const token = parseToken(event.text);
    if (token) {
      if (!(token.route in state.config.routes)) {
        ctx.ui.notify(`[autorouter] Unknown route "${token.route}"`, "warning");
        return { action: "continue" };
      }
      state.tokenRoute = token.route;
      return { action: "transform", text: token.cleaned };
    }

    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!state.enabled || !state.config) return;

    const prevModel = ctx.model;
    const prevThinking = pi.getThinkingLevel();
    state.activeRoute = null;

    let routeKey: string | null = null;

    if (state.tokenRoute) {
      routeKey = state.tokenRoute;
      state.tokenRoute = null;
      state.resetSticky();
    } else if (state.stickyRemaining > 0 && state.stickyRoute && state.stickyModel) {
      state.stickyRemaining--;
      await pi.setModel(state.stickyModel);
      if (state.stickyThinking) pi.setThinkingLevel(state.stickyThinking);
      state.activeRoute = `${state.stickyRoute} → ${state.stickyModel.id}`;
      state.activeModelId = state.stickyModel.id;
      return;
    } else {
      routeKey = await classify(state.config, event.prompt, ctx.modelRegistry, ctx.sessionManager.getBranch());
    }

    const route =
      state.config.routes[routeKey!] ??
      state.config.routes[state.config.classifier.fallback] ??
      state.config.defaultModel;

    const model = ctx.modelRegistry.find(route.provider, route.model);
    if (!model) return;

    await pi.setModel(model);

    state.savedModel = prevModel;
    state.savedThinking = prevThinking;

    const stickyTurns = state.config.stickyTurns ?? 0;
    if (stickyTurns > 0) {
      state.stickyRoute = routeKey!;
      state.stickyModel = model;
      state.stickyThinking = route.thinking
        ? (route.thinking as ThinkingLevel)
        : prevThinking;
      state.stickyRemaining = stickyTurns;
    }

    state.activeRoute = `${routeKey} → ${model.id}`;
    state.activeModelId = model.id;

    if (route.thinking) {
      pi.setThinkingLevel(route.thinking);
    }
  });

  pi.on("agent_end", async () => {
    if (state.savedModel && state.stickyRemaining === 0) {
      const restoredModel = state.savedModel;
      await pi.setModel(restoredModel);
      state.savedModel = undefined;
      state.activeModelId = restoredModel.id;
    }
    if (state.savedThinking !== undefined && state.stickyRemaining === 0) {
      pi.setThinkingLevel(state.savedThinking as any);
      state.savedThinking = undefined;
    }
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (state.activeRoute) {
      ctx.ui.setStatus("autorouter", ctx.ui.theme.fg("accent", `⟳ ${state.activeRoute}`));
    }
    if (state.activeModelId) {
      ctx.ui.setStatus("model", ctx.ui.theme.fg("accent", state.activeModelId));
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    state.activeRoute = null;
    state.activeModelId = ctx.model?.id ?? null;
    if (state.activeModelId) {
      ctx.ui.setStatus("model", ctx.ui.theme.fg("accent", state.activeModelId));
    }
  });
}
