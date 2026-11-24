import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  ScrollView,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { GoalCheckerUpdate } from "./goal-checker.js";

export const REVIEWER_SHORTCUT = "ctrl+alt+r";
export const REVIEWER_KEY_HINT = "Ctrl+Alt+R";

export interface GoalStreamDisplay {
  update(update: GoalCheckerUpdate): void;
  toggle(): Promise<void>;
  clear(): void;
}

interface OutputPart {
  type: GoalCheckerUpdate["type"];
  text: string;
  lines?: string[];
}

/** The task retains the log even when there is no attached view. */
export class GoalOutputLog {
  phase: GoalCheckerUpdate["phase"] = "planning";
  private parts: OutputPart[] = [];
  private toolOutputs = new Map<string, OutputPart>();
  private width?: number;

  update(update: GoalCheckerUpdate): void {
    this.phase = update.phase;
    if (update.type === "status" && update.text === "Starting")
      this.toolOutputs.clear();

    if (update.type === "tool_output" && update.id) {
      const existing = this.toolOutputs.get(update.id);
      if (existing) {
        existing.text = update.text;
        existing.lines = undefined;
        return;
      }
      const part: OutputPart = { type: update.type, text: update.text };
      this.toolOutputs.set(update.id, part);
      this.parts.push(part);
      return;
    }

    const last = this.parts.at(-1);
    if (
      (update.type === "text" || update.type === "thinking") &&
      last?.type === update.type
    ) {
      last.text += update.text;
      last.lines = undefined;
    } else {
      const text =
        update.type === "tool"
          ? `→ ${update.text}`
          : update.type === "checklist"
            ? `Checklist:\n${update.text}`
            : update.type === "status"
              ? `${update.phase === "planning" ? "Planner" : "Evaluator"}: ${update.text}`
              : update.text;
      this.parts.push({ type: update.type, text });
    }
  }

  invalidate(): void {
    for (const part of this.parts) part.lines = undefined;
  }

  render(width: number, theme: Theme): string[] {
    if (this.width !== width) {
      this.width = width;
      this.invalidate();
    }
    return this.parts.flatMap((part) => {
      if (!part.lines) {
        const color =
          part.type === "thinking" || part.type === "tool"
            ? "muted"
            : part.type === "status"
              ? "accent"
              : "toolOutput";
        part.lines = wrapTextWithAnsi(part.text, width).map((line) =>
          theme.fg(color, line),
        );
      }
      return part.lines;
    });
  }
}

export class GoalOutputPane implements Component {
  private scroll = new ScrollView(
    {
      render: (width) => this.log.render(width, this.theme),
      invalidate: () => this.invalidate(),
    },
    { follow: "end" },
  );

  constructor(
    private tui: TUI,
    private theme: Theme,
    private log: GoalOutputLog,
    private detach: () => void,
  ) {
    this.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, REVIEWER_SHORTCUT)) {
      this.detach();
      return;
    }
    if (matchesKey(data, "up")) this.scroll.scrollBy(-1);
    else if (matchesKey(data, "down")) this.scroll.scrollBy(1);
    else if (matchesKey(data, "pageUp"))
      this.scroll.scrollBy(-this.scroll.viewportHeight);
    else if (matchesKey(data, "pageDown"))
      this.scroll.scrollBy(this.scroll.viewportHeight);
    else if (matchesKey(data, "home")) this.scroll.scrollToStart();
    else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
    else return;
    this.tui.requestRender();
  }

  invalidate(): void {
    this.log.invalidate();
  }

  render(width: number): string[] {
    if (width < 4) return [truncateToWidth("Goal", width, "")];
    const innerWidth = width - 2;
    const lines = this.scroll.render(innerWidth);
    const height = Math.max(
      1,
      Math.min(24, Math.floor(this.tui.terminal.rows * 0.7) - 3),
    );
    this.scroll.updateLayout(lines.length, height, () =>
      this.tui.requestRender(),
    );
    const start = this.scroll.scrollTop;
    const visible = lines.slice(start, start + height);
    const title = ` ${this.log.phase === "planning" ? "Goal planner" : "Goal evaluator"} (${this.scroll.isFollowingEnd ? "following" : "paused"}) `;
    const border = (text: string) => this.theme.fg("border", text);
    const row = (text: string) =>
      border("│") + truncateToWidth(text, innerWidth, "", true) + border("│");
    const heading = truncateToWidth(title, innerWidth, "");
    return [
      border("╭") +
        this.theme.fg("accent", heading) +
        border(`${"─".repeat(innerWidth - visibleWidth(heading))}╮`),
      ...visible.map(row),
      ...Array.from({ length: height - visible.length }, () => row("")),
      row(
        this.theme.fg(
          "dim",
          `Esc detach · ↑/↓ PgUp/PgDn scroll · Home/End · ${lines.length ? start + 1 : 0}–${Math.min(start + height, lines.length)}/${lines.length}`,
        ),
      ),
      border(`╰${"─".repeat(innerWidth)}╯`),
    ];
  }
}

export function createGoalStreamDisplay(
  ctx: ExtensionContext,
): GoalStreamDisplay {
  if (!ctx.hasUI || ctx.mode !== "tui")
    return { update() {}, async toggle() {}, clear() {} };

  const log = new GoalOutputLog();
  let detach: (() => void) | undefined;
  let requestRender: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleared = false;
  const flush = () => {
    timer = undefined;
    requestRender?.();
  };
  return {
    update(update) {
      if (cleared) return;
      log.update(update);
      if (requestRender && !timer) timer = setTimeout(flush, 40).unref();
    },
    async toggle() {
      if (cleared) return;
      if (detach) return detach();
      try {
        await ctx.ui.custom<void>(
          (tui, theme, _keys, done) => {
            detach = () => {
              clearTimeout(timer);
              timer = undefined;
              requestRender = undefined;
              done();
            };
            requestRender = () => tui.requestRender();
            return new GoalOutputPane(tui, theme, log, detach);
          },
          { overlay: true, overlayOptions: { width: "85%" } },
        );
      } finally {
        detach = undefined;
        requestRender = undefined;
        clearTimeout(timer);
        timer = undefined;
      }
    },
    clear() {
      cleared = true;
      detach?.();
    },
  };
}
