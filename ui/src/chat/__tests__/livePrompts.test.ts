/**
 * Regression fixtures captured VERBATIM from a live claude session
 * (2026-08-19, gate pass 5) — every row of the visible viewport, blanks
 * included, exactly as `visibleLines()` hands them to the detector. The
 * hand-written fixtures elsewhere are readable; these are true.
 */

import { describe, expect, it } from "vitest";
import { detectPrompt } from "../promptDetector";
import rows from "./fixtures/prompts/live-model-picker-raw.json";

describe("live captures", () => {
  it("classifies the /model picker exactly as the screen held it", () => {
    const prompt = detectPrompt(rows as string[]);
    expect(prompt?.kind).toBe("menu");
    if (prompt?.kind !== "menu") {
      return;
    }
    expect(prompt.options).toHaveLength(5);
    expect(prompt.selectedIndex).toBe(1);
    expect(prompt.options[1]?.label).toContain("Opus (1M context)");
    expect(prompt.options[4]?.label).toContain("Haiku");
  });
});
