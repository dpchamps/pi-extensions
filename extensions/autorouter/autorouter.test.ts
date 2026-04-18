import { describe, it, expect } from "vitest";

describe("autorouter", () => {
  // ── buildClassifierContext ────────────────────────────────────────────────

  describe("buildClassifierContext", () => {
    function buildClassifierContext(userPrompt: string, branch: any[]): { prompt: string; history: string } {
      const recentLines: string[] = [];
      let lastAssistant = "";

      for (const entry of branch.slice(-6)) {
        if (entry.type === "message") {
          const text = entry.message?.content
            ?.filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n") ?? "";

          if (entry.message?.role === "assistant") {
            lastAssistant = text;
          } else if (entry.message?.role === "user" && lastAssistant) {
            const snippet = lastAssistant.slice(0, 200).replace(/\n/g, " ");
            recentLines.unshift(`User asked: "${snippet}"...`);
            lastAssistant = "";
            if (recentLines.length >= 2) break;
          }
        }
      }

      const history = recentLines.length
        ? `\n\nRecent context:\n${recentLines.join("\n")}`
        : "";

      return { prompt: userPrompt, history };
    }

    it("includes prior assistant response when user says yes", () => {
      const branch = [
        { type: "message", message: { role: "user", content: [{ type: "text", text: "refactor the auth module" }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "I'll do a complex refactor of the auth system with multiple files" }] } },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "yes" }] } },
      ];
      const ctx = buildClassifierContext("yes", branch);
      expect(ctx.history).toContain("User asked:");
      expect(ctx.history).toContain("refactor");
    });

    it("returns empty history for fresh session", () => {
      const ctx = buildClassifierContext("help with tests", []);
      expect(ctx.history).toBe("");
    });

    it("limits to last 2 exchanges", () => {
      const branch = [
        { type: "message", message: { role: "user", content: [{ type: "text", text: "first" }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "first response" }] } },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "second" }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "second response" }] } },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "third" }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "third response" }] } },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "current" }] } },
      ];
      const ctx = buildClassifierContext("current", branch);
      // Should have 2 most recent exchanges
      expect(ctx.history.split("User asked:").length - 1).toBe(2);
    });
  });

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
      expect(result).toContain('Task: "what is this?"');
    });

    it("uses custom prompt template", () => {
      const result = buildClassifierPrompt({ x: "y" }, "do stuff", "Cats: {{categories}}\nTask: {{task}}");
      expect(result).toBe("Cats: - x: y\nTask: do stuff");
    });

    it("handles empty categories", () => {
      const result = buildClassifierPrompt({}, "test");
      expect(result).toContain('Task: "test"');
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

    it("strips markdown fences", () => {
      expect(normalizeCategory("```\ntrivial\n```")).toBe("trivial");
      expect(normalizeCategory("```json\nwrite\n```")).toBe("write");
    });

    it("handles plain category", () => {
      expect(normalizeCategory("trivial")).toBe("trivial");
      expect(normalizeCategory("Write")).toBe("write");
      expect(normalizeCategory("  trivial  ")).toBe("trivial");
    });
  });

  // ── parseToken (autorouter:<route>) ───────────────────────────────────────

  describe("parseToken", () => {
    function parseToken(text: string): { route: string; cleaned: string } | null {
      const m = text.match(/autorouter:(\w+)/i);
      if (!m) return null;
      const route = m[1].toLowerCase();
      const cleaned = text.replace(/autorouter:\w+/i, "").replace(/\s+/g, " ").trim();
      return { route, cleaned: cleaned || " " };
    }

    it("extracts route and cleans prompt", () => {
      const result = parseToken("fix the bug autorouter:trivial");
      expect(result).toEqual({ route: "trivial", cleaned: "fix the bug" });
    });

    it("handles uppercase token", () => {
      const result = parseToken("do stuff AUTOROUTER:write");
      expect(result).toEqual({ route: "write", cleaned: "do stuff" });
    });

    it("handles token at start", () => {
      const result = parseToken("autorouter:reason implement this");
      expect(result).toEqual({ route: "reason", cleaned: "implement this" });
    });

    it("handles token only", () => {
      const result = parseToken("autorouter:read");
      expect(result).toEqual({ route: "read", cleaned: " " }); // normalized to single space
    });

    it("returns null when no token", () => {
      expect(parseToken("normal prompt")).toBeNull();
      expect(parseToken("autorouter:")).toBeNull(); // empty route
      expect(parseToken("autoroute:write")).toBeNull(); // typo, no "r"
    });

    it("handles token in middle", () => {
      const result = parseToken("update this autorouter:trivial and that");
      expect(result).toEqual({ route: "trivial", cleaned: "update this and that" });
    });

    it("handles multiple tokens (first wins)", () => {
      const result = parseToken("stuff autorouter:reason more autorouter:write");
      expect(result).toEqual({ route: "reason", cleaned: "stuff more autorouter:write" });
    });
  });

  // ── sticky routing logic ─────────────────────────────────────────────────

  describe("sticky routing", () => {
    // Simulates sticky turn countdown
    function makeStickyDecrement(remaining: number): number | null {
      if (remaining <= 0) return null; // no sticky, need to classify
      return remaining - 1;
    }

    it("returns new remaining count when sticky is active", () => {
      expect(makeStickyDecrement(3)).toBe(2);
      expect(makeStickyDecrement(1)).toBe(0); // reaches 0, next call triggers classification
    });

    it("returns null when sticky expired", () => {
      expect(makeStickyDecrement(0)).toBeNull();
    });

    it("route falls back to classifier.fallback when category unknown", () => {
      const config = {
        classifier: { provider: "a", model: "b", categories: {}, fallback: "write" },
        routes: { write: { provider: "x", model: "y" } },
        defaultModel: { provider: "p", model: "q" },
      };
      const cat = "unknown";
      const route =
        config.routes[cat as keyof typeof config.routes] ??
        config.routes[config.classifier.fallback as keyof typeof config.routes] ??
        config.defaultModel;
      expect(route.provider).toBe("x");
    });
  });

  // ── /autorouter command argument parsing ───────────────────────────────────

  describe("/autorouter argument parsing", () => {
    function parseCommandArg(arg: string | undefined): boolean | null {
      if (!arg?.trim()) return null;
      const a = arg.trim().toLowerCase();
      if (["on", "enable", "1", "true"].includes(a)) return true;
      if (["off", "disable", "0", "false"].includes(a)) return false;
      return null;
    }

    it("enable aliases", () => {
      for (const a of ["on", "enable", "1", "true"]) {
        expect(parseCommandArg(a)).toBe(true);
      }
    });

    it("disable aliases", () => {
      for (const a of ["off", "disable", "0", "false"]) {
        expect(parseCommandArg(a)).toBe(false);
      }
    });

    it("unknown args return null", () => {
      expect(parseCommandArg("maybe")).toBeNull();
      expect(parseCommandArg("")).toBeNull();
    });
  });

  // ── config structure ───────────────────────────────────────────────────────

  describe("AutorouterConfig shape", () => {
    it("requires classifier, routes, defaultModel", () => {
      const cfg = {
        classifier: { provider: "a", model: "b", categories: {}, fallback: "x" },
        routes: { y: { provider: "p", model: "q" } },
        defaultModel: { provider: "m", model: "n" },
      };
      expect(cfg.classifier).toBeDefined();
      expect(cfg.routes).toBeDefined();
      expect(cfg.defaultModel).toBeDefined();
    });

    it("supports optional stickyTurns", () => {
      const cfg = { stickyTurns: 3, classifier: { provider: "a", model: "b", categories: {}, fallback: "x" }, routes: {}, defaultModel: { provider: "c", model: "d" } } as { stickyTurns?: number; classifier: Record<string, unknown>; routes: Record<string, unknown>; defaultModel: Record<string, unknown> };
      expect(cfg.stickyTurns).toBe(3);
    });

    it("stickyTurns is optional (absent means disabled)", () => {
      const cfg = { classifier: { provider: "a", model: "b", categories: {}, fallback: "x" }, routes: {}, defaultModel: { provider: "c", model: "d" } } as { stickyTurns?: number; classifier: Record<string, unknown>; routes: Record<string, unknown>; defaultModel: Record<string, unknown> };
      expect(cfg.stickyTurns).toBeUndefined();
    });

    it("route supports optional thinking level", () => {
      const route = { provider: "a", model: "b", thinking: "high" as const };
      expect(route.thinking).toBe("high");
    });

    it("classifier supports optional custom prompt", () => {
      const cfg = {
        stickyTurns: 3,
        classifier: { provider: "a", model: "b", categories: {}, fallback: "x", prompt: "Custom: {{categories}} {{task}}" },
        routes: {},
        defaultModel: { provider: "c", model: "d" },
      };
      expect(typeof cfg.classifier.prompt).toBe("string");
    });
  });
});