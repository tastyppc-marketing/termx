import { describe, expect, it } from "vitest";
import {
  assignSession,
  createFolder,
  deleteFolder,
  filterRecords,
  folderIdFor,
  groupSessions,
  matchesQuery,
  relativeTime,
  renameFolder,
  shortenCwd,
} from "../folderOps";
import type { ConversationsV1, LlmSessionRecord } from "../types";

function base(): ConversationsV1 {
  return { version: 1, folders: [], assignments: {}, generated: {} };
}

function record(overrides: Partial<LlmSessionRecord> = {}): LlmSessionRecord {
  return {
    provider: "claude",
    id: "a",
    title: "Session A",
    cwd: "C:\\Dev\\TermX",
    filePath: "C:\\a.jsonl",
    updatedAtMs: 100,
    summary: null,
    recap: null,
    ...overrides,
  };
}

describe("folder mutations", () => {
  it("creates a folder with a trimmed name and refuses blanks", () => {
    const created = createFolder(base(), "  Work  ", "f1");
    expect(created.folders).toEqual([{ id: "f1", name: "Work" }]);
    const blank = createFolder(created, "   ", "f2");
    expect(blank).toBe(created);
    const duplicate = createFolder(created, "Other", "f1");
    expect(duplicate).toBe(created);
  });

  it("renames a folder and no-ops on unknown id, blank, or unchanged name", () => {
    const data = createFolder(base(), "Work", "f1");
    expect(renameFolder(data, "f1", "Client").folders).toEqual([
      { id: "f1", name: "Client" },
    ]);
    expect(renameFolder(data, "nope", "Client")).toBe(data);
    expect(renameFolder(data, "f1", "  ")).toBe(data);
    expect(renameFolder(data, "f1", "Work")).toBe(data);
  });

  it("deleting a folder unfiles its sessions and leaves others alone", () => {
    let data = createFolder(base(), "Work", "f1");
    data = createFolder(data, "Play", "f2");
    data = assignSession(data, "claude:a", "f1");
    data = assignSession(data, "claude:b", "f1");
    data = assignSession(data, "codex:c", "f2");

    const after = deleteFolder(data, "f1");
    expect(after.folders).toEqual([{ id: "f2", name: "Play" }]);
    expect(after.assignments).toEqual({ "codex:c": "f2" });
    expect(deleteFolder(after, "f1")).toBe(after);
  });

  it("assigns, re-assigns, unfiles, and refuses unknown folders", () => {
    let data = createFolder(base(), "Work", "f1");
    data = createFolder(data, "Play", "f2");

    const filed = assignSession(data, "claude:a", "f1");
    expect(folderIdFor(filed, "claude:a")).toBe("f1");
    expect(assignSession(filed, "claude:a", "f1")).toBe(filed);

    const moved = assignSession(filed, "claude:a", "f2");
    expect(folderIdFor(moved, "claude:a")).toBe("f2");

    const unfiled = assignSession(moved, "claude:a", null);
    expect(unfiled.assignments).toEqual({});
    expect(assignSession(unfiled, "claude:a", null)).toBe(unfiled);
    expect(assignSession(unfiled, "claude:a", "ghost")).toBe(unfiled);
  });
});

describe("query and grouping", () => {
  it("matches title, cwd, summary, and recap case-insensitively", () => {
    const row = record({ title: "Parser work", cwd: "C:\\Dev\\TermX" });
    const note = { summary: "Fixed the tokenizer", recap: "Long RECAP text" };
    expect(matchesQuery("", row, note)).toBe(true);
    expect(matchesQuery("parser", row, note)).toBe(true);
    expect(matchesQuery("termx", row, note)).toBe(true);
    expect(matchesQuery("tokenizer", row, note)).toBe(true);
    expect(matchesQuery("recap", row, note)).toBe(true);
    expect(matchesQuery("nothing here", row, note)).toBe(false);
  });

  it("filters by provider and query together", () => {
    const rows = [
      record({ id: "a", title: "Alpha" }),
      record({ id: "b", provider: "codex", title: "Beta" }),
      record({ id: "c", provider: "codex", title: "Gamma" }),
    ];
    const noteFor = () => ({ summary: null, recap: null });
    expect(
      filterRecords(rows, { provider: "codex", query: "", noteFor }).map((r) => r.id),
    ).toEqual(["b", "c"]);
    expect(
      filterRecords(rows, { provider: "all", query: "gam", noteFor }).map((r) => r.id),
    ).toEqual(["c"]);
  });

  it("groups into folders in order with Unfiled last, keeping empty folders", () => {
    let data = createFolder(base(), "Work", "f1");
    data = createFolder(data, "Empty", "f2");
    data = assignSession(data, "claude:a", "f1");

    const sections = groupSessions(
      [record({ id: "a" }), record({ id: "b" })],
      data,
    );
    expect(sections.map((section) => [section.id, section.records.length])).toEqual([
      ["f1", 1],
      ["f2", 0],
      [null, 1],
    ]);
    expect(sections[2]!.name).toBe("Unfiled");
  });
});

describe("display helpers", () => {
  it("shortens long paths leaf-first", () => {
    expect(shortenCwd(null)).toBe("");
    expect(shortenCwd("C:\\Dev\\TermX")).toBe("C:\\Dev\\TermX");
    expect(shortenCwd("C:\\Users\\mjfos\\code\\seo-service-builder\\output")).toBe(
      "…\\seo-service-builder\\output",
    );
    expect(
      shortenCwd("C:\\Users\\mjfos\\code\\a-very-long-project-directory\\output", 20),
    ).toBe("…\\output");
  });

  it("formats relative times", () => {
    const now = 10_000_000_000;
    expect(relativeTime(now - 5_000, now)).toBe("just now");
    expect(relativeTime(now - 3 * 60_000, now)).toBe("3m ago");
    expect(relativeTime(now - 5 * 3_600_000, now)).toBe("5h ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(relativeTime(now - 90 * 86_400_000, now)).toBe("3mo ago");
  });
});
