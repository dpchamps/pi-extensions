import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  resolveCacheLifetime,
  compactionDelayMs,
  type CacheLifetime,
} from "./cache.js";

const STATE = "autocompact-enabled";
const STATUS = "autocompact";
const MAX_TIMEOUT = 2 ** 31 - 1;

interface RequestClock {
  provider: string;
  model: string;
  startedAt: number;
  ttlMs: number;
  source: CacheLifetime["source"];
  usable: boolean;
}

/** Idle, cache-expiry compaction; independent of Pi's context-size auto-compaction. */
export default function autocompact(pi: ExtensionAPI): void {
  let enabled = false;
  let sessionId: string | undefined;
  let context: ExtensionContext | undefined;
  let request: RequestClock | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dispatchWatchdog: ReturnType<typeof setTimeout> | undefined;
  let activeRun = false;
  let compacting = false;
  let prompts = 0;
  let epoch = 0;
  let note = "waiting for a fresh model request";

  function clearTimer(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  function clearWatchdog(): void {
    clearTimeout(dispatchWatchdog);
    dispatchWatchdog = undefined;
  }

  function invalidate(reason: string): void {
    clearTimer();
    request = undefined;
    note = reason;
  }

  function isCurrent(ctx: ExtensionContext, capturedEpoch: number): boolean {
    if (epoch !== capturedEpoch) return false;
    try {
      return ctx.sessionManager.getSessionId() === sessionId;
    } catch {
      // An SDK host can dispose without emitting session_shutdown.
      invalidate("session disposed");
      clearWatchdog();
      return false;
    }
  }

  function status(): string {
    if (!enabled)
      return "Autocompact off. Enable for this session with /autocompact on.";
    const command = pi
      .getCommands()
      .some(
        (command) =>
          command.source === "extension" && command.name === "clm-compact",
      )
      ? "/clm-compact"
      : "/compact";
    if (compacting) return `Autocompact on · ${command} requested.`;
    if (!request?.usable) return `Autocompact on · ${note}.`;
    const due = request.startedAt + compactionDelayMs(request.ttlMs)!;
    const seconds = Math.max(0, Math.ceil((due - Date.now()) / 1000));
    return `Autocompact on · ${command} in ${seconds}s, once idle (cache TTL ${request.ttlMs / 1000}s; ${request.source}).`;
  }

  function update(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      STATUS,
      enabled
        ? status().replace("Autocompact on · ", "autocompact: ")
        : undefined,
    );
  }

  function schedule(ctx: ExtensionContext): void {
    context = ctx;
    clearTimer();
    if (!enabled || !request?.usable || compacting || activeRun) {
      update(ctx);
      return;
    }
    const clock = request;
    if (
      ctx.model?.provider !== clock.provider ||
      ctx.model.id !== clock.model
    ) {
      invalidate("model changed; waiting for a fresh model request");
      update(ctx);
      return;
    }
    const expiresAt = clock.startedAt + clock.ttlMs;
    if (Date.now() >= expiresAt) {
      invalidate("cache already expired; waiting for a fresh model request");
      update(ctx);
      return;
    }
    const due = clock.startedAt + compactionDelayMs(clock.ttlMs)!;
    const blocked = !ctx.isIdle() || ctx.hasPendingMessages() || prompts > 0;
    const delay =
      blocked && Date.now() >= due
        ? Math.min(1000, expiresAt - Date.now())
        : Math.max(0, due - Date.now());
    const scheduledEpoch = epoch;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (!isCurrent(ctx, scheduledEpoch) || request !== clock || !enabled)
          return;
        if (
          ctx.model?.provider !== clock.provider ||
          ctx.model.id !== clock.model
        ) {
          invalidate("model changed; waiting for a fresh model request");
          update(ctx);
          return;
        }
        if (
          Date.now() < due ||
          !ctx.isIdle() ||
          ctx.hasPendingMessages() ||
          prompts > 0
        ) {
          schedule(ctx);
          return;
        }
        if (Date.now() >= expiresAt) {
          invalidate(
            "cache already expired; waiting for a fresh model request",
          );
          update(ctx);
          return;
        }
        compact(ctx);
      },
      Math.min(MAX_TIMEOUT, delay),
    );
    timer.unref();
    update(ctx);
  }

  function compact(ctx: ExtensionContext): void {
    // Consume this idle period before dispatch: CLM's own model/tool turns must
    // never arm another compaction while the user is still away.
    invalidate("compaction attempted; waiting for a fresh model request");
    compacting = true;
    const operationEpoch = epoch;
    const finish = (error?: Error) => {
      if (!isCurrent(ctx, operationEpoch)) return;
      compacting = false;
      clearWatchdog();
      if (error)
        ctx.ui.notify(`Autocompact failed: ${error.message}`, "warning");
      update(ctx);
    };
    try {
      const clm = pi
        .getCommands()
        .some(
          (command) =>
            command.source === "extension" && command.name === "clm-compact",
        );
      ctx.ui.notify(
        `Autocompact: cache nearing expiry; running ${clm ? "/clm-compact" : "/compact"}.`,
        "info",
      );
      if (clm) {
        // Only extension commands can be dispatched this way. Built-in /compact
        // is a TUI command, so the fallback below uses its public session API.
        pi.sendUserMessage("/clm-compact", { expandPromptTemplates: true });
        dispatchWatchdog = setTimeout(() => {
          if (
            isCurrent(ctx, operationEpoch) &&
            compacting &&
            !activeRun &&
            ctx.isIdle()
          ) {
            finish(
              new Error(
                "/clm-compact did not start a model run (is CLM enabled?).",
              ),
            );
          }
        }, 30_000);
        dispatchWatchdog.unref();
      } else {
        ctx.compact({ onComplete: () => finish(), onError: finish });
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
    update(ctx);
  }

  pi.registerCommand("autocompact", {
    description:
      "Compact once while idle before the prompt cache expires: on, off, status",
    getArgumentCompletions: (prefix) =>
      ["on", "off", "status"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action !== "on" && action !== "off" && action !== "status") {
        ctx.ui.notify("Usage: /autocompact [on|off|status]", "warning");
        return;
      }
      if (action !== "status") {
        // Persist first: failure must not silently change consent. Session IDs
        // prevent a fork from inheriting another session's explicit opt-in.
        const next = action === "on";
        pi.appendEntry(STATE, {
          sessionId: ctx.sessionManager.getSessionId(),
          enabled: next,
        });
        enabled = next;
        schedule(ctx);
      }
      ctx.ui.notify(status(), "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    epoch++;
    clearTimer();
    clearWatchdog();
    context = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    activeRun = false;
    compacting = false;
    prompts = 0;
    invalidate("waiting for a fresh model request");
    const config = (pi.getSettings() as unknown as { autocompact?: unknown })
      .autocompact;
    enabled = config === true;
    if (config && typeof config === "object" && !Array.isArray(config)) {
      enabled = (config as { enabled?: unknown }).enabled === true;
    }
    // Consent is session-wide, not branch-local. Navigating /tree must not
    // resurrect an earlier "on" after the user explicitly turned it off.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== STATE) continue;
      const data = entry.data as
        | { sessionId?: unknown; enabled?: unknown }
        | undefined;
      if (data?.sessionId === sessionId && typeof data.enabled === "boolean")
        enabled = data.enabled;
    }
    update(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    context = ctx;
    activeRun = true;
    clearTimer();
    clearWatchdog();
    request = undefined;
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!activeRun || compacting || !ctx.model) return;
    const lifetime = resolveCacheLifetime(ctx.model, event.payload);
    if (
      lifetime === undefined ||
      compactionDelayMs(lifetime.ttlMs) === undefined
    ) {
      invalidate(
        "no usable cache lifetime for this request; configure a promptCache model override",
      );
      return;
    }
    request = {
      provider: ctx.model.provider,
      model: ctx.model.id,
      startedAt: Date.now(),
      ...lifetime,
      usable: false,
    };
  });

  pi.on("message_end", (event) => {
    if (!request || event.message.role !== "assistant") return;
    const message = event.message;
    request.usable =
      message.provider === request.provider &&
      message.model === request.model &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted";
  });

  pi.on("agent_settled", (_event, ctx) => {
    activeRun = false;
    if (compacting) {
      compacting = false;
      clearWatchdog();
      request = undefined;
    }
    schedule(ctx);
  });

  pi.on("input", (event, ctx) => {
    // CLM submits its compaction prompt through this same input pipeline.
    if (compacting && event.source === "extension") return;
    // Also disarm on preflight/input failures that never reach agent_start.
    invalidate("new input; waiting for a fresh model request");
    if (compacting && !activeRun && ctx.isIdle()) {
      compacting = false;
      clearWatchdog();
    }
    update(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    invalidate("model changed; waiting for a fresh model request");
    update(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    invalidate("branch changed; waiting for a fresh model request");
    update(ctx);
  });
  pi.on("session_before_compact", () => {
    invalidate("compaction started; waiting for a fresh model request");
  });
  pi.on("session_compact", (_event, ctx) => {
    invalidate("compacted; waiting for a fresh model request");
    update(ctx);
  });
  pi.on("ui_prompt_start", () => {
    prompts++;
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    prompts = Math.max(0, prompts - 1);
    schedule(ctx);
  });
  pi.on("cache_warming_decision", (_event, ctx) => {
    // Idle warming would otherwise race compaction or perpetually postpone it.
    if (enabled && ctx.isIdle()) return { action: "stop" };
  });
  pi.on("session_shutdown", () => {
    epoch++;
    clearTimer();
    clearWatchdog();
    context?.ui.setStatus(STATUS, undefined);
    context = undefined;
    request = undefined;
    sessionId = undefined;
  });
}
