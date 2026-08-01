import { describe, expect, it } from "vitest";
import { groupArtifacts, needsFetch, parentDirOf } from "../artifacts";
import type { SessionArtifactFile, SessionArtifacts } from "../types";

function file(overrides: Partial<SessionArtifactFile> = {}): SessionArtifactFile {
  return { path: "C:\\a\\b.md", kind: "edited", exists: true, ...overrides };
}

describe("needsFetch", () => {
  it("is true when nothing is cached yet", () => {
    expect(needsFetch(undefined, { updatedAtMs: 100 })).toBe(true);
  });

  it("is true when the record moved since the cache was built", () => {
    const cached: SessionArtifacts = { sourceMtimeMs: 100, files: [] };
    expect(needsFetch(cached, { updatedAtMs: 200 })).toBe(true);
  });

  it("is false when the cache is at least as new as the record", () => {
    const exact: SessionArtifacts = { sourceMtimeMs: 100, files: [] };
    expect(needsFetch(exact, { updatedAtMs: 100 })).toBe(false);
    const newer: SessionArtifacts = { sourceMtimeMs: 150, files: [] };
    expect(needsFetch(newer, { updatedAtMs: 100 })).toBe(false);
  });
});

describe("groupArtifacts", () => {
  it("partitions created/edited, preserving order within each group", () => {
    const files = [
      file({ path: "a", kind: "edited" }),
      file({ path: "b", kind: "created" }),
      file({ path: "c", kind: "edited" }),
      file({ path: "d", kind: "created" }),
    ];
    expect(groupArtifacts(files)).toEqual({
      created: [file({ path: "b", kind: "created" }), file({ path: "d", kind: "created" })],
      edited: [file({ path: "a", kind: "edited" }), file({ path: "c", kind: "edited" })],
    });
  });

  it("returns empty groups for an empty harvest", () => {
    expect(groupArtifacts([])).toEqual({ created: [], edited: [] });
  });
});

describe("parentDirOf", () => {
  it("derives the parent for a backslash path", () => {
    expect(parentDirOf("C:\\a\\b.md")).toBe("C:\\a");
  });

  it("derives the parent for a forward-slash path", () => {
    expect(parentDirOf("C:/a/b.md")).toBe("C:/a");
  });

  it("keeps the trailing separator at a drive root (backslash)", () => {
    expect(parentDirOf("C:\\b.md")).toBe("C:\\");
  });

  it("keeps the trailing separator at a drive root (forward slash)", () => {
    expect(parentDirOf("C:/b.md")).toBe("C:/");
  });

  it("handles a deeper nested path", () => {
    expect(parentDirOf("C:\\Dev\\TermX\\ui\\src\\App.tsx")).toBe("C:\\Dev\\TermX\\ui\\src");
  });

  it("returns the path unchanged when there is no separator to strip", () => {
    expect(parentDirOf("b.md")).toBe("b.md");
  });
});
