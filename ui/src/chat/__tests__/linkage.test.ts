import { describe, expect, it } from "vitest";
import type { LlmSessionRecord } from "../../conversations/types";
import { resolveLinkage } from "../linkage";

function record(overrides: Partial<LlmSessionRecord> = {}): LlmSessionRecord {
  return {
    provider: "claude",
    id: "a",
    title: "A session",
    cwd: "C:\\Dev\\TermX",
    filePath: "C:\\Users\\me\\.claude\\projects\\C--Dev-TermX\\a.jsonl",
    updatedAtMs: 1000,
    summary: null,
    recap: null,
    ...overrides,
  };
}

describe("resolveLinkage", () => {
  it("prefers the session the pane was resumed from", () => {
    const resumed = record({ id: "resumed", cwd: "C:\\Elsewhere" });
    const link = resolveLinkage({
      explicitKey: "claude:resumed",
      paneCwd: "C:\\Dev\\TermX",
      candidates: [record({ id: "by-cwd" }), resumed],
    });
    expect(link?.record.id).toBe("resumed");
    expect(link?.reason).toBe("explicit");
  });

  it("falls back to the session recorded in the pane's directory", () => {
    const link = resolveLinkage({
      paneCwd: "c:/dev/termx/",
      candidates: [record({ id: "here" }), record({ id: "there", cwd: "C:\\Other" })],
    });
    expect(link?.record.id).toBe("here");
    expect(link?.reason).toBe("cwd");
  });

  it("takes the most recently touched of several in one directory", () => {
    const link = resolveLinkage({
      paneCwd: "C:\\Dev\\TermX",
      candidates: [
        record({ id: "older", updatedAtMs: 1000 }),
        record({ id: "newer", updatedAtMs: 2000 }),
      ],
    });
    expect(link?.record.id).toBe("newer");
  });

  it("refuses to guess between two equally recent sessions", () => {
    expect(
      resolveLinkage({
        paneCwd: "C:\\Dev\\TermX",
        candidates: [
          record({ id: "one", updatedAtMs: 2000 }),
          record({ id: "two", updatedAtMs: 2000 }),
        ],
      }),
    ).toBeNull();
  });

  it("links nothing without a directory or a match", () => {
    expect(resolveLinkage({ candidates: [record()] })).toBeNull();
    expect(resolveLinkage({ paneCwd: "", candidates: [record()] })).toBeNull();
    expect(
      resolveLinkage({ paneCwd: "C:\\Nowhere", candidates: [record()] }),
    ).toBeNull();
    expect(resolveLinkage({ paneCwd: "C:\\Dev\\TermX", candidates: [] })).toBeNull();
  });

  it("ignores a session with no transcript to read", () => {
    expect(
      resolveLinkage({
        explicitKey: "claude:a",
        paneCwd: "C:\\Dev\\TermX",
        candidates: [record({ filePath: "" })],
      }),
    ).toBeNull();
  });

  it("falls through to the directory when the explicit key is stale", () => {
    const link = resolveLinkage({
      explicitKey: "claude:gone",
      paneCwd: "C:\\Dev\\TermX",
      candidates: [record({ id: "still-here" })],
    });
    expect(link?.record.id).toBe("still-here");
    expect(link?.reason).toBe("cwd");
  });
});
