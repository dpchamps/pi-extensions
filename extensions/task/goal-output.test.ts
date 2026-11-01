import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoalStreamDisplay, GoalOutputPane } from "./goal-output.js";

function paneHarness() {
  const requestRender = vi.fn();
  const tui = { terminal: { rows: 24 }, requestRender } as unknown as TUI;
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  const pane = new GoalOutputPane(tui, theme);
  return { pane, tui, theme, requestRender };
}

const up = "\x1b[1;3A";
const down = "\x1b[1;3B";
const home = "\x1b[1;3H";
const end = "\x1b[1;3F";

afterEach(() => vi.useRealTimers());

describe("goal output pane", () => {
  it("auto-follows live output while retaining all earlier lines for scrolling", () => {
    const { pane } = paneHarness();
    pane.update({
      phase: "planning",
      type: "text",
      text: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"),
    });
    let output = pane.render(100).join("\n");
    expect(output).toContain("line 99");
    expect(output).not.toContain("line 0");
    expect(output).toContain("(live)");

    expect(pane.handleInput(home)).toBe(true);
    output = pane.render(100).join("\n");
    expect(output).toContain("line 0");
    expect(output).toContain("(paused)");
    pane.update({ phase: "planning", type: "text", text: "\nnew output" });
    expect(pane.render(100).join("\n")).toContain("line 0");
    expect(pane.render(100).join("\n")).not.toContain("new output");

    pane.handleInput(down);
    expect(pane.render(100).join("\n")).toContain("line 8");
    pane.handleInput(up);
    expect(pane.render(100).join("\n")).toContain("line 0");
    pane.handleInput("\x1b[6;3~");
    expect(pane.render(100).join("\n")).toContain("line 15");
    pane.handleInput("\x1b[5;3~");
    expect(pane.render(100).join("\n")).toContain("line 0");
    pane.handleInput(end);
    output = pane.render(100).join("\n");
    expect(output).toContain("new output");
    expect(output).toContain("(live)");
    expect(pane.handleInput("ordinary chat")).toBe(false);
    expect(pane.handleInput("\x1b")).toBe(false);
  });

  it("appends checklists and phases instead of replacing the history", () => {
    const { pane } = paneHarness();
    pane.update({ phase: "planning", type: "thinking", text: "First thought" });
    pane.update({ phase: "planning", type: "thinking", text: " continues" });
    pane.update({ phase: "planning", type: "checklist", text: "- [ ] Check" });
    pane.update({ phase: "evaluation", type: "status", text: "Starting" });
    pane.update({
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
    const { pane } = paneHarness();
    pane.update({
      phase: "planning",
      type: "tool_output",
      id: "1",
      text: "partial",
    });
    pane.update({
      phase: "planning",
      type: "tool_output",
      id: "1",
      text: "partial and final",
    });
    let output = pane.render(100).join("\n");
    expect(output.match(/partial/g)).toHaveLength(1);
    pane.update({ phase: "evaluation", type: "status", text: "Starting" });
    pane.update({
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
    const { pane, tui } = paneHarness();
    pane.update({
      phase: "planning",
      type: "tool",
      text: "界🙂e\u0301".repeat(100) + " END",
    });
    for (const width of [100, 25, 8, 4, 3, 1]) {
      const lines = pane.render(width);
      expect(lines.length).toBeLessThanOrEqual(11);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(pane.render(25).join("\n")).toContain("END");
    Object.defineProperty(tui.terminal, "rows", { value: 9 });
    expect(pane.render(25)).toHaveLength(6);
  });

  it("rebuilds themed output when invalidated", () => {
    const { pane, theme } = paneHarness();
    pane.update({ phase: "planning", type: "text", text: "hello" });
    pane.render(80);
    theme.fg = (_color, text) => text.toUpperCase();
    pane.invalidate();
    expect(pane.render(80).join("\n")).toContain("HELLO");
  });
});

describe("goal stream display", () => {
  it("batches redraws, leaves chat keys alone, and cleans up on cancellation", () => {
    vi.useFakeTimers();
    const { tui, theme, requestRender } = paneHarness();
    let input: (data: string) => unknown = () => {};
    const unsubscribe = vi.fn();
    const setWidget = vi.fn((_key, factory) => factory?.(tui, theme));
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        setWidget,
        onTerminalInput: (handler: typeof input) => {
          input = handler;
          return unsubscribe;
        },
      },
    } as unknown as ExtensionContext;
    const display = createGoalStreamDisplay(ctx);
    display.update({ phase: "planning", type: "text", text: "hello" });
    display.update({ phase: "planning", type: "text", text: " world" });
    expect(requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(requestRender).toHaveBeenCalledOnce();
    expect(input("chat")).toBeUndefined();
    expect(input(up)).toEqual({ consume: true });
    display.update({ phase: "planning", type: "text", text: "pending" });
    display.clear();
    display.clear();
    requestRender.mockClear();
    display.update({ phase: "evaluation", type: "text", text: "late update" });
    display.flush();
    vi.runAllTimers();
    expect(requestRender).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(setWidget).toHaveBeenLastCalledWith("task-goal-stream", undefined);
  });

  it.each(["rpc", "print", "json"])(
    "does not mount terminal UI in %s mode",
    (mode) => {
      const setWidget = vi.fn();
      const display = createGoalStreamDisplay({
        hasUI: true,
        mode,
        ui: { setWidget },
      } as unknown as ExtensionContext);
      display.update({ phase: "planning", type: "text", text: "no terminal" });
      display.flush();
      display.clear();
      expect(setWidget).not.toHaveBeenCalled();
    },
  );
});
