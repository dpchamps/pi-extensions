import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
import {
  parseTaskLimit,
  type ParsedTaskArgs,
  type TaskKind,
} from "./arguments.js";
import type { GoalCheckerConfig, ReviewerModel } from "./goal-checker.js";

export interface TaskRequest extends ParsedTaskArgs {
  reviewer?: Pick<GoalCheckerConfig, "model" | "thinkingLevel">;
}

const TASK_DESCRIPTIONS = {
  oracle: "Keep working until a command passes (e.g. npm test)",
  focus:
    "Keep exploring and iterating until you stop it or it reaches a run limit",
  goal: "Keep working until a separate reviewer verifies the result",
} satisfies Record<TaskKind, string>;

const THINKING_DESCRIPTIONS = {
  off: "No reasoning",
  minimal: "Very brief reasoning",
  low: "Light reasoning",
  medium: "Moderate reasoning",
  high: "Deep reasoning",
  xhigh: "Extra-high reasoning",
  max: "Maximum reasoning",
} satisfies Record<ModelThinkingLevel, string>;

async function selectDescribed<T extends string>(
  ui: ExtensionContext["ui"],
  title: string,
  values: readonly T[],
  descriptions: Record<T, string>,
): Promise<T | undefined> {
  const options = new Map(
    values.map((value) => [`${value} — ${descriptions[value]}`, value]),
  );
  const selected = await ui.select(title, [...options.keys()]);
  return selected === undefined ? undefined : options.get(selected);
}

export function modelLabel(model: ReviewerModel): string {
  return `${model.provider}/${model.id}`;
}

function pickModel(ctx: ExtensionContext, choices: string[]) {
  if (ctx.mode !== "tui") return ctx.ui.select("Goal reviewer model", choices);

  return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
    const search = new Input({ prompt: "/ ", placeholder: "Search models" });
    const listTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: () => theme.fg("muted", "  No matching models"),
    };
    const items = choices.map((value) => ({ value, label: value }));
    const makeList = (query: string) => {
      const list = new SelectList(
        items.filter(({ value }) => value.toLowerCase().includes(query)),
        Math.max(1, Math.min(10, tui.terminal.rows - 6)),
        listTheme,
      );
      list.onSelect = ({ value }) => done(value);
      list.onCancel = () => done(undefined);
      return list;
    };
    let list = makeList("");
    return {
      get focused() {
        return search.focused;
      },
      set focused(focused: boolean) {
        search.focused = focused;
      },
      invalidate() {
        search.invalidate();
        list.invalidate();
      },
      render(width: number) {
        return [
          theme.fg("accent", "Goal reviewer model"),
          ...search.render(width),
          ...list.render(width),
          theme.fg("dim", "↑/↓ select · Enter accept · Esc cancel"),
        ].map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        if (
          keys.matches(data, "tui.select.up") ||
          keys.matches(data, "tui.select.down") ||
          keys.matches(data, "tui.select.confirm") ||
          keys.matches(data, "tui.select.cancel")
        ) {
          list.handleInput(data);
        } else {
          const before = search.getValue();
          search.handleInput(data);
          if (search.getValue() !== before)
            list = makeList(search.getValue().trim().toLowerCase());
        }
        tui.requestRender();
      },
    };
  });
}

export async function configureTask(
  ctx: ExtensionContext,
): Promise<TaskRequest | undefined> {
  const { ui } = ctx;
  const kind = await selectDescribed(
    ui,
    "Task type",
    ["oracle", "focus", "goal"],
    TASK_DESCRIPTIONS,
  );
  let reviewer: TaskRequest["reviewer"];
  let reviewerLabel: string | undefined;
  let verify: string | undefined;
  let limit: number | undefined;

  if (kind === "goal") {
    if (!ctx.model) {
      ui.notify("Task goal: no active model is available", "error");
      return;
    }
    const current = modelLabel(ctx.model);
    const sessionModel = `Same as session (${current})`;
    const candidates = new Map<string, typeof ctx.model>();
    for (const model of ctx.modelRegistry.getAvailable()) {
      const label = modelLabel(model);
      if (label !== current) candidates.set(label, model);
    }
    const choice = await pickModel(ctx, [
      sessionModel,
      ...[...candidates.keys()].sort(),
    ]);
    if (choice === undefined) return;
    const model = choice === sessionModel ? ctx.model : candidates.get(choice);
    if (!model) return;

    const preferred = clampThinkingLevel(model, ctx.thinkingLevel ?? "off");
    const levels = [
      preferred,
      ...getSupportedThinkingLevels(model).filter(
        (level) => level !== preferred,
      ),
    ];
    const thinkingLevel = await selectDescribed(
      ui,
      "Goal reviewer thinking level",
      levels,
      THINKING_DESCRIPTIONS,
    );
    if (thinkingLevel === undefined) return;
    reviewer = {
      model: { provider: model.provider, id: model.id },
      thinkingLevel,
    };
    reviewerLabel = choice;
  } else if (kind === "oracle") {
    verify = (
      await ui.input("Oracle verification command", "e.g. npm test")
    )?.trim();
    if (verify === undefined) return;
    if (!verify) {
      ui.notify("Task oracle: a verification command is required", "warning");
      return;
    }
  } else if (kind === "focus") {
    const value = await ui.input(
      "Focus run limit (optional)",
      "Blank for unlimited",
    );
    if (value === undefined) return;
    if (value.trim()) {
      limit = parseTaskLimit(value.trim());
      if (limit === undefined) {
        ui.notify(
          "Task focus: the run limit must be a positive integer",
          "warning",
        );
        return;
      }
    }
  } else {
    return;
  }

  const prompt = (await ui.editor("Baseline prompt"))?.trim();
  if (prompt === undefined) return;
  if (!prompt) {
    ui.notify("Task: a baseline prompt is required", "warning");
    return;
  }
  const summary = [`Type: ${kind}`];
  if (reviewer && reviewerLabel)
    summary.push(
      `Reviewer: ${reviewerLabel}`,
      `Thinking level: ${reviewer.thinkingLevel}`,
    );
  if (verify) summary.push(`Verify: ${verify}`);
  if (kind === "focus") summary.push(`Run limit: ${limit ?? "none"}`);
  if (
    !(await ui.confirm("Start this task?", [...summary, "", prompt].join("\n")))
  )
    return;
  return { kind, prompt, verify, limit, reviewer };
}
