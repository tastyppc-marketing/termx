import { describe, expect, it } from "vitest";
import { isEditTool, isExpandedByDefault, isTestRun } from "../density";
import type { ToolEntry } from "../types";

function tool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    kind: "tool",
    id: "call_1",
    ts: 1,
    name: "Read",
    title: "Read App.tsx",
    summary: "",
    status: "ok",
    detail: "the file",
    ...overrides,
  };
}

describe("isExpandedByDefault", () => {
  it("opens everything on full and nothing on chips", () => {
    for (const entry of [
      tool(),
      tool({ status: "error" }),
      tool({ name: "Edit", title: "Edited App.tsx" }),
    ]) {
      expect(isExpandedByDefault(entry, "full")).toBe(true);
      expect(isExpandedByDefault(entry, "chips")).toBe(false);
    }
  });

  it("smart opens failures, edits and test runs — and leaves the rest closed", () => {
    expect(isExpandedByDefault(tool(), "smart")).toBe(false);
    expect(isExpandedByDefault(tool({ status: "error" }), "smart")).toBe(true);
    expect(isExpandedByDefault(tool({ status: "running" }), "smart")).toBe(false);
    expect(
      isExpandedByDefault(tool({ name: "Edit", title: "Edited App.tsx" }), "smart"),
    ).toBe(true);
    expect(
      isExpandedByDefault(tool({ name: "Write", title: "Wrote App.tsx" }), "smart"),
    ).toBe(true);
    expect(
      isExpandedByDefault(
        tool({ name: "Bash", title: "npx vitest run --reporter=dot" }),
        "smart",
      ),
    ).toBe(true);
    expect(
      isExpandedByDefault(
        tool({ name: "Bash", title: "git status", detail: "nothing to commit" }),
        "smart",
      ),
    ).toBe(false);
  });

  it("recognizes a test report by its output, whoever produced it", () => {
    expect(isTestRun(tool({ name: "Task", detail: "914 passed" }))).toBe(true);
    expect(isTestRun(tool({ name: "Task", detail: "1 failed" }))).toBe(true);
    expect(isTestRun(tool({ name: "Task", detail: "all quiet" }))).toBe(false);
  });

  it("knows which tools produce a diff", () => {
    expect(isEditTool("Edit")).toBe(true);
    expect(isEditTool("Write")).toBe(true);
    expect(isEditTool("NotebookEdit")).toBe(true);
    expect(isEditTool("Read")).toBe(false);
  });
});
