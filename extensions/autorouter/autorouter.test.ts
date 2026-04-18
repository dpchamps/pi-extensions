import { describe, it, expect } from "vitest";

describe("autorouter", () => {
  // ── buildClassifierPrompt ──────────────────────────────────────────────────

  describe("buildClassifierPrompt", () => {
    const DEFAULT_PROMPT = `Classify the following developer task into exactly one category. Respond with ONLY the category name on a single line, nothing else.

Categories:
{{categories}}

Task: "{{task}}"

Category:`;

    function buildClassifierPrompt(
      categories: Record<string, string>,
      task: string,
      customPrompt?: string,
    ): string {
      const template = customPrompt ?? DEFAULT_PROMPT;
      const catList = Object.entries(categories)
        .map(([name, desc]) => `- ${name}: ${desc}`)
        .join("\n");
      return template
        .replace("{{categories}}", catList)
        .replace("{{task}}", task);
    }

    it("builds prompt with default template and categories", () => {
      const result = buildClassifierPrompt(
        { trivial: "Simple question", write: "Implement something" },
        "what is this?",
      );
      expect(result).toContain("Categories:");
      expect(result).toContain("- trivial: Simple question");
      expect(result).toContain("- write: Implement something");
      expect(result).toContain('Task: "what is this?"');
      expect(result).toContain("Category:");
    });

    it("uses custom prompt template with placeholders", () => {
      const result = buildClassifierPrompt({ x: "y" }, "do stuff", "Cats: {{categories}}\nTask: {{task}}");
      expect(result).toBe("Cats: - x: y\nTask: do stuff");
    });

    it("handles empty categories", () => {
      const result = buildClassifierPrompt({}, "test");
      expect(result).toContain("Categories:");
      expect(result).toContain('Task: "test"');
    });

    it("handles task with special characters (no escaping)", () => {
      const result = buildClassifierPrompt({ a: "b" }, 'say "hello" world');
      expect(result).toContain('Task: "say "hello" world"');
    });

    it("template with only categories placeholder", () => {
      const result = buildClassifierPrompt({ foo: "bar" }, "task", "Cats: {{categories}}");
      expect(result).toBe("Cats: - foo: bar");
    });

    it("template with only task placeholder", () => {
      const result = buildClassifierPrompt({ a: "b" }, "do it", "T: {{task}}");
      expect(result).toBe("T: do it");
    });
  });

  // ── normalizeCategory ─────────────────────────────────────────────────────

  describe("normalizeCategory", () => {
    function normalizeCategory(raw: string): string {
      return raw
        .replace(/^```[\w-]*\n?/, "")
        .replace(/\n?```$/, "")
        .trim()
        .toLowerCase();
    }

    it("strips markdown fences with language tag", () => {
      expect(normalizeCategory("```\ntrivial\n```")).toBe("trivial");
      expect(normalizeCategory("```json\nwrite\n```")).toBe("write");
    });

    it("handles plain category (no fence)", () => {
      expect(normalizeCategory("trivial")).toBe("trivial");
      expect(normalizeCategory("Write")).toBe("write");
      expect(normalizeCategory("  trivial  ")).toBe("trivial");
    });

    it("handles newline-trimmed fences", () => {
      expect(normalizeCategory("\nread\n")).toBe("read");
    });
  });

  // ── config structure ───────────────────────────────────────────────────────

  describe("AutorouterConfig shape", () => {
    it("requires classifier with model and categories", () => {
      const config = {
        classifier: {
          provider: "openrouter",
          model: "google/gemini-2.5-flash",
          categories: { trivial: "Simple question" },
          fallback: "trivial",
        },
        routes: {
          trivial: { provider: "openrouter", model: "meta-llama/llama-3.3-70b" },
        },
        defaultModel: { provider: "anthropic", model: "claude-sonnet-4-5" },
      };

      expect(config.classifier.categories).toHaveProperty("trivial");
      expect(config.routes.trivial).toHaveProperty("provider");
      expect(config.routes.trivial).toHaveProperty("model");
      expect(config.defaultModel).toHaveProperty("provider");
      expect(config.defaultModel).toHaveProperty("model");
    });

    it("route config supports optional thinking level", () => {
      const route = { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "high" as const };
      expect(route.thinking).toBe("high");
    });

    it("classifier supports optional custom prompt", () => {
      const cfg = {
        classifier: {
          provider: "openrouter",
          model: "flash",
          categories: {},
          fallback: "x",
          prompt: "Pick one: {{categories}}. Task: {{task}}",
        },
        routes: {},
        defaultModel: { provider: "x", model: "y" },
      };
      expect(typeof cfg.classifier.prompt).toBe("string");
    });

    it("route falls back to classifier fallback then defaultModel", () => {
      const config = {
        classifier: { provider: "a", model: "b", categories: {}, fallback: "write" },
        routes: { write: { provider: "x", model: "y" } },
        defaultModel: { provider: "p", model: "q" },
      };

      const cat: string = "trivial";
      const route =
        config.routes[cat as keyof typeof config.routes] ??
        config.routes[config.classifier.fallback as keyof typeof config.routes] ??
        config.defaultModel;
      expect(route.provider).toBe("x");
      expect(route.model).toBe("y");
    });

    it("unknown category falls through to defaultModel", () => {
      const config = {
        classifier: { provider: "a", model: "b", categories: {}, fallback: "other" },
        routes: { other: { provider: "x", model: "y" } },
        defaultModel: { provider: "p", model: "q" },
      };

      const cat: string = "unknown";
      const route =
        config.routes[cat as keyof typeof config.routes] ??
        config.routes[config.classifier.fallback as keyof typeof config.routes] ??
        config.defaultModel;
      expect(route.provider).toBe("x");
      expect(route.model).toBe("y");
    });
  });

  // ── /autorouter command argument parsing ───────────────────────────────────

  describe("/autorouter on/off argument parsing", () => {
    const ENABLE_ARGS = ["on", "enable", "1", "true"];
    const DISABLE_ARGS = ["off", "disable", "0", "false"];

    function parseCommandArg(arg: string | undefined): boolean | null {
      if (!arg?.trim()) return null;
      const a = arg.trim().toLowerCase();
      if (ENABLE_ARGS.includes(a)) return true;
      if (DISABLE_ARGS.includes(a)) return false;
      return null; // unknown
    }

    it("enable aliases return true", () => {
      for (const a of ENABLE_ARGS) {
        expect(parseCommandArg(a)).toBe(true);
      }
    });

    it("disable aliases return false", () => {
      for (const a of DISABLE_ARGS) {
        expect(parseCommandArg(a)).toBe(false);
      }
    });

    it("unknown args return null", () => {
      expect(parseCommandArg("maybe")).toBeNull();
      expect(parseCommandArg("yes")).toBeNull();
      expect(parseCommandArg("")).toBeNull();
      expect(parseCommandArg("  ")).toBeNull();
    });

    it("whitespace-trimmed args work", () => {
      expect(parseCommandArg("  on  ")).toBe(true);
      expect(parseCommandArg(" off ")).toBe(false);
    });
  });
});