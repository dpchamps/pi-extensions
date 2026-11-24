import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGoalStreamDisplay,
  GoalOutputLog,
  GoalOutputPane,
} from "./goal-output.js";

function paneHarness() {
  const requestRender = vi.fn();
  const tui = { terminal: { rows: 24 }, requestRender } as unknown as TUI;
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  const log = new GoalOutputLog();
  const detach = vi.fn();
  const pane = new GoalOutputPane(tui, theme, log, detach);
  return { pane, log, tui, theme, requestRender, detach };
}

const up = "\x1b[A";
const down = "\x1b[B";
const home = "\x1b[H";
const end = "\x1b[F";

afterEach(() => vi.useRealTimers());

describe("goal output pane", () => {
  it("auto-follows live output while retaining all earlier lines for scrolling", () => {
    const { pane, log, detach } = paneHarness();
    log.update({
      phase: "planning",
      type: "text",
      text: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"),
    });
    let output = pane.render(100).join("\n");
    expect(output).toContain("line 99");
    expect(output).not.toContain("line 0");
    expect(output).toContain("(following)");

    pane.handleInput(home);
    output = pane.render(100).join("\n");
    expect(output).toContain("line 0");
    expect(output).toContain("(paused)");
    log.update({ phase: "planning", type: "text", text: "\nnew output" });
    expect(pane.render(100).join("\n")).toContain("line 0");
    expect(pane.render(100).join("\n")).not.toContain("new output");

    pane.handleInput(down);
    expect(pane.render(100).join("\n")).toContain("line 13");
    pane.handleInput(up);
    expect(pane.render(100).join("\n")).toContain("line 0");
    pane.handleInput("\x1b[6~");
    expect(pane.render(100).join("\n")).toContain("line 25");
    pane.handleInput("\x1b[5~");
    expect(pane.render(100).join("\n")).toContain("line 0");
    pane.handleInput(end);
    output = pane.render(100).join("\n");
    expect(output).toContain("new output");
    expect(output).toContain("(following)");
    pane.handleInput("\x1b");
    expect(detach).toHaveBeenCalledOnce();
  });

  it("appends checklists and phases instead of replacing the history", () => {
    const { pane, log } = paneHarness();
    log.update({ phase: "planning", type: "thinking", text: "First thought" });
    log.update({ phase: "planning", type: "thinking", text: " continues" });
    log.update({ phase: "planning", type: "checklist", text: "- [ ] Check" });
    log.update({ phase: "evaluation", type: "status", text: "Starting" });
    log.update({
      phase: "evaluation",
      type: "checklist",
      text: "- [x] Check",
    });
    const output = pane.render(100).join("\n");
    expect(output).toContain("Goal evaluator");
    expect(output).toContain("First thought continues");
    expect(output).toContain("- [ ] Check");
    expect(output).toContain("- [x] Check");
  });

  it("replaces cumulative tool snapshots without duplicating output or losing previous runs", () => {
    const { pane, log } = paneHarness();
    log.update({
      phase: "planning",
      type: "tool_output",
      id: "1",
      text: "partial",
    });
    log.update({
      phase: "planning",
      type: "tool_output",
      id: "1",
      text: "partial and final",
    });
    let output = pane.render(100).join("\n");
    expect(output.match(/partial/g)).toHaveLength(1);
    log.update({ phase: "evaluation", type: "status", text: "Starting" });
    log.update({
      phase: "evaluation",
      type: "tool_output",
      id: "1",
      text: "next run",
    });
    output = pane.render(100).join("\n");
    expect(output).toContain("partial and final");
    expect(output).toContain("next run");
  });

  it("wraps long and wide-character lines within a bounded, resize-aware window", () => {
    const { pane, log, tui } = paneHarness();
    log.update({
      phase: "planning",
      type: "tool",
      text: "界🙂e\u0301".repeat(100) + " END",
    });
    for (const width of [100, 25, 8, 4, 3, 1]) {
      const lines = pane.render(width);
      expect(lines.length).toBeLessThanOrEqual(16);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(pane.render(25).join("\n")).toContain("END");
    Object.defineProperty(tui.terminal, "rows", { value: 9 });
    expect(pane.render(25)).toHaveLength(6);
  });

  it("rebuilds themed output when invalidated", () => {
    const { pane, log, theme } = paneHarness();
    log.update({ phase: "planning", type: "text", text: "hello" });
    pane.render(80);
    theme.fg = (_color, text) => text.toUpperCase();
    pane.invalidate();
    expect(pane.render(80).join("\n")).toContain("HELLO");
  });
});

describe("goal stream display", () => {
  it("opens on demand, streams only when attached, and retains detached output", async () => {
    vi.useFakeTimers();
    const { tui, theme, requestRender } = paneHarness();
    let pane!: GoalOutputPane;
    const custom = vi.fn(
      (factory) =>
        new Promise<void>((done) => {
          pane = factory(tui, theme, undefined, done);
        }),
    );
    const display = createGoalStreamDisplay({
      hasUI: true,
      mode: "tui",
      ui: { custom },
    } as unknown as ExtensionContext);
    const stream = (text: string) =>
      display.update({ phase: "planning", type: "text", text });
    stream("hello");
    expect(custom).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();

    const first = display.toggle();
    expect(custom).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ overlay: true }),
    );
    expect(pane.render(80).join("\n")).toContain("hello");
    requestRender.mockClear();
    stream(" world");
    stream("!");
    expect(requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(requestRender).toHaveBeenCalledOnce();
    pane.handleInput("\x1b");
    await first;

    requestRender.mockClear();
    stream(" Detached update");
    vi.runAllTimers();
    expect(requestRender).not.toHaveBeenCalled();
    const second = display.toggle();
    expect(pane.render(80).join("\n")).toContain(
      "hello world! Detached update",
    );
    requestRender.mockClear();
    stream(" pending");
    display.clear();
    await second;
    stream(" late update");
    vi.runAllTimers();
    expect(requestRender).not.toHaveBeenCalled();
    await display.toggle();
    expect(custom).toHaveBeenCalledTimes(2);
  });

  it.each(["rpc", "print", "json"])(
    "does not mount terminal UI in %s mode",
    (mode) => {
      const custom = vi.fn();
      const display = createGoalStreamDisplay({
        hasUI: true,
        mode,
        ui: { custom },
      } as unknown as ExtensionContext);
      display.update({ phase: "planning", type: "text", text: "no terminal" });
      void display.toggle();
      display.clear();
      expect(custom).not.toHaveBeenCalled();
    },
  );
});
