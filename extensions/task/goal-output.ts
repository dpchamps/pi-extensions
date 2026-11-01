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

export interface GoalStreamDisplay {
  update(update: GoalCheckerUpdate): void;
  flush(): void;
  clear(): void;
}

interface OutputPart {
  type: GoalCheckerUpdate["type"];
  text: string;
  lines?: string[];
}

/** A bounded viewport, not a bounded log: scrolling never discards old output. */
export class GoalOutputPane implements Component {
  private phase: GoalCheckerUpdate["phase"] = "planning";
  private parts: OutputPart[] = [];
  private toolOutputs = new Map<string, OutputPart>();
  private width?: number;
  private scroll = new ScrollView(
    {
      render: (width) => this.renderOutput(width),
      invalidate: () => this.invalidate(),
    },
    { follow: "end" },
  );

  constructor(
    private tui: TUI,
    private theme: Theme,
  ) {}

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

  handleInput(data: string): boolean {
    if (matchesKey(data, "alt+up")) this.scroll.scrollBy(-1);
    else if (matchesKey(data, "alt+down")) this.scroll.scrollBy(1);
    else if (matchesKey(data, "alt+pageUp"))
      this.scroll.scrollBy(-this.scroll.viewportHeight);
    else if (matchesKey(data, "alt+pageDown"))
      this.scroll.scrollBy(this.scroll.viewportHeight);
    else if (matchesKey(data, "alt+home")) this.scroll.scrollToStart();
    else if (matchesKey(data, "alt+end")) this.scroll.scrollToEnd();
    else return false;
    this.tui.requestRender();
    return true;
  }

  invalidate(): void {
    for (const part of this.parts) part.lines = undefined;
  }

  private renderOutput(width: number): string[] {
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
          this.theme.fg(color, line),
        );
      }
      return part.lines;
    });
  }

  render(width: number): string[] {
    if (width < 4) return [truncateToWidth("Goal", width, "")];
    const innerWidth = width - 2;
    const lines = this.scroll.render(innerWidth);
    const height = Math.max(
      1,
      Math.min(10, Math.floor(this.tui.terminal.rows / 3)),
    );
    // Explicit clipping also works in regular mode, where terminal scrollback
    // owns the outer viewport rather than the fullscreen layout engine.
    this.scroll.updateLayout(lines.length, height, () =>
      this.tui.requestRender(),
    );
    const start = this.scroll.scrollTop;
    const visible = lines.slice(start, start + height);
    const title = `${this.phase === "planning" ? "Goal planner" : "Goal evaluator"} (${this.scroll.isFollowingEnd ? "live" : "paused"})`;
    const border = (text: string) => this.theme.fg("border", text);
    const row = (text: string) =>
      border("│") + truncateToWidth(text, innerWidth, "", true) + border("│");
    const heading = truncateToWidth(` ${title} `, innerWidth, "");
    return [
      border("╭") +
        this.theme.fg("accent", heading) +
        border(`${"─".repeat(innerWidth - visibleWidth(heading))}╮`),
      ...visible.map(row),
      ...Array.from({ length: height - visible.length }, () => row("")),
      row(
        this.theme.fg(
          "dim",
          `${lines.length ? start + 1 : 0}–${Math.min(start + height, lines.length)}/${lines.length} · Alt+↑/↓ scroll · Alt+Home start · Alt+End live`,
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
    return { update() {}, flush() {}, clear() {} };

  const key = "task-goal-stream";
  let pane: GoalOutputPane;
  let requestRender: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleared = false;
  ctx.ui.setWidget(key, (tui, theme) => {
    pane = new GoalOutputPane(tui, theme);
    requestRender = () => tui.requestRender();
    return pane;
  });
  const unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (!cleared && pane.handleInput(data)) return { consume: true };
    return undefined;
  });
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!cleared) requestRender();
  };
  return {
    update(update) {
      if (cleared) return;
      pane.update(update);
      if (!timer) {
        timer = setTimeout(flush, 40);
        timer.unref?.();
      }
    },
    flush,
    clear() {
      if (cleared) return;
      cleared = true;
      clearTimeout(timer);
      timer = undefined;
      unsubscribe();
      ctx.ui.setWidget(key, undefined);
    },
  };
}
