import { describe, expect, it } from "vitest";
import type { LlmSessionRecord } from "../../conversations/types";
import { resolveLinkage, successorRecord } from "../linkage";

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

describe("successorRecord", () => {
  const original = record({ id: "original", updatedAtMs: 5000 });

  it("adopts a newer record from the same folder", () => {
    const successor = record({ id: "successor", updatedAtMs: 6000 });
    expect(
      successorRecord({
        original,
        resumedAtMs: 5500,
        candidates: [original, successor],
      })?.id,
    ).toBe("successor");
  });

  it("never adopts the record the pane resumed", () => {
    expect(
      successorRecord({
        original,
        resumedAtMs: 5500,
        // The resumed transcript itself keeps growing; it is not a successor.
        candidates: [record({ id: "original", updatedAtMs: 9000 })],
      }),
    ).toBeNull();
  });

  it("ignores records from another folder, case- and slash-blind", () => {
    expect(
      successorRecord({
        original,
        resumedAtMs: 5500,
        candidates: [record({ id: "elsewhere", cwd: "C:\\Other", updatedAtMs: 6000 })],
      }),
    ).toBeNull();
    expect(
      successorRecord({
        original,
        resumedAtMs: 5500,
        candidates: [record({ id: "same", cwd: "c:/dev/termx/", updatedAtMs: 6000 })],
      })?.id,
    ).toBe("same");
  });

  it("ignores records that have not moved since the resume", () => {
    expect(
      successorRecord({
        original,
        resumedAtMs: 5500,
        candidates: [
          record({ id: "older", updatedAtMs: 5000 }),
          record({ id: "exactly-then", updatedAtMs: 5500 }),
        ],
      }),
    ).toBeNull();
  });

  it("ignores a record with no transcript to tail", () => {
    expect(
      successorRecord({
        original,
        resumedAtMs: 5500,
        candidates: [record({ id: "no-file", filePath: "", updatedAtMs: 6000 })],
      }),
    ).toBeNull();
  });

  it("takes the newest when several qualify", () => {
    expect(
      successorRecord({
        original,
        resumedAtMs: 5500,
        candidates: [
          record({ id: "newer", updatedAtMs: 6000 }),
          record({ id: "newest", updatedAtMs: 7000 }),
        ],
      })?.id,
    ).toBe("newest");
  });

  it("adopts nothing for a record with no folder of its own", () => {
    expect(
      successorRecord({
        original: record({ id: "rootless", cwd: null }),
        resumedAtMs: 5500,
        candidates: [record({ id: "any", updatedAtMs: 6000 })],
      }),
    ).toBeNull();
  });

  it("adopts nothing when nothing qualifies", () => {
    expect(
      successorRecord({ original, resumedAtMs: 5500, candidates: [] }),
    ).toBeNull();
  });
});
