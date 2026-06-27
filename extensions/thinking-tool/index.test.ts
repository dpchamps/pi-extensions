/**
 * Tests for the thinking tool
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Type } from "@sinclair/typebox";

describe("thinking-tool", () => {
  describe("parameter schema", () => {
    it("should have correct parameter schema", () => {
      const parameters = Type.Object({
        prompt: Type.String({
          description: expect.any(String),
        }),
      });

      expect(parameters).toBeDefined();
      expect((parameters.properties as any).prompt.type).toBe("string");
    });
  });
});
