import { describe, expect, it } from "vitest";
import {
  parseConversations,
  parseSessionRecords,
  serializeConversations,
  conversationsFileIo,
  CONVERSATIONS_FILE,
} from "../storage";
import type { ConversationsV1 } from "../types";

describe("parseConversations", () => {
  it("returns empty state for a missing file", () => {
    expect(parseConversations(null)).toEqual({
      version: 1,
      folders: [],
      assignments: {},
      generated: {},
    });
  });

  it("returns empty state for malformed JSON and non-objects", () => {
    for (const text of ["{oops", "[]", "null", '"text"', "7"]) {
      expect(parseConversations(text)).toEqual({
        version: 1,
        folders: [],
        assignments: {},
        generated: {},
      });
    }
  });

  it("drops junk folders, blank names, and duplicate ids", () => {
    const parsed = parseConversations(
      JSON.stringify({
        version: 1,
        folders: [
          { id: "f1", name: "  Work  " },
          { id: "f1", name: "Duplicate" },
          { id: "", name: "No id" },
          { id: "f2", name: "   " },
          "nonsense",
          { id: "f3", name: "Keep" },
        ],
      }),
    );
    expect(parsed.folders).toEqual([
      { id: "f1", name: "Work" },
      { id: "f3", name: "Keep" },
    ]);
  });

  it("drops assignments pointing at unknown folders", () => {
    const parsed = parseConversations(
      JSON.stringify({
        folders: [{ id: "f1", name: "Work" }],
        assignments: {
          "claude:a": "f1",
          "claude:b": "gone",
          "claude:c": 7,
        },
      }),
    );
    expect(parsed.assignments).toEqual({ "claude:a": "f1" });
  });

  it("repairs generated entries field by field", () => {
    const parsed = parseConversations(
      JSON.stringify({
        generated: {
          "claude:a": { summary: "one", recap: null, generatedAtMs: 5, sourceMtimeMs: 9 },
          "claude:b": { summary: 42, recap: "", generatedAtMs: "x", sourceMtimeMs: -3 },
          "claude:c": "nope",
        },
      }),
    );
    expect(parsed.generated).toEqual({
      "claude:a": { summary: "one", recap: null, generatedAtMs: 5, sourceMtimeMs: 9 },
      "claude:b": { summary: null, recap: null, generatedAtMs: 0, sourceMtimeMs: 0 },
    });
  });

  it("keeps artifacts when parseable and omits the field otherwise", () => {
    const withArtifacts = parseConversations(
      JSON.stringify({
        artifacts: {
          "claude:a": {
            sourceMtimeMs: 12,
            files: [
              { path: "C:\\a.ts", kind: "created", exists: true },
              { path: "C:\\b.ts", kind: "bogus", exists: false },
              { kind: "created" },
            ],
          },
        },
      }),
    );
    expect(withArtifacts.artifacts).toEqual({
      "claude:a": {
        sourceMtimeMs: 12,
        files: [
          { path: "C:\\a.ts", kind: "created", exists: true },
          { path: "C:\\b.ts", kind: "edited", exists: false },
        ],
      },
    });
    expect(parseConversations(JSON.stringify({ artifacts: 5 }))).not.toHaveProperty(
      "artifacts",
    );
  });

  it("round-trips through serialize", () => {
    const value: ConversationsV1 = {
      version: 1,
      folders: [{ id: "f1", name: "Work" }],
      assignments: { "codex:x": "f1" },
      generated: {
        "codex:x": { summary: "s", recap: "r", generatedAtMs: 1, sourceMtimeMs: 2 },
      },
      artifacts: {
        "codex:x": {
          sourceMtimeMs: 2,
          files: [{ path: "C:\\a.ts", kind: "edited", exists: true }],
        },
      },
    };
    expect(parseConversations(serializeConversations(value))).toEqual(value);
  });

  it("always serializes version 1 with a trailing newline", () => {
    const text = serializeConversations({
      version: 1,
      folders: [],
      assignments: {},
      generated: {},
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).version).toBe(1);
  });
});

describe("parseSessionRecords", () => {
  it("keeps well-formed rows and skips broken ones", () => {
    const records = parseSessionRecords([
      {
        provider: "claude",
        id: "abc",
        title: "Fix the parser",
        cwd: "C:\\Dev\\TermX",
        filePath: "C:\\t.jsonl",
        updatedAtMs: 10,
        summary: "did things",
        recap: null,
      },
      { provider: "gemini", id: "no" },
      { provider: "codex", id: "" },
      "nope",
      { provider: "codex", id: "z", title: "", cwd: null, filePath: "", updatedAtMs: "x" },
    ]);
    expect(records).toEqual([
      {
        provider: "claude",
        id: "abc",
        title: "Fix the parser",
        cwd: "C:\\Dev\\TermX",
        filePath: "C:\\t.jsonl",
        updatedAtMs: 10,
        summary: "did things",
        recap: null,
      },
      {
        provider: "codex",
        id: "z",
        title: "z",
        cwd: null,
        filePath: "",
        updatedAtMs: 0,
        summary: null,
        recap: null,
      },
    ]);
  });

  it("returns an empty list for a non-array payload", () => {
    expect(parseSessionRecords(null)).toEqual([]);
    expect(parseSessionRecords({ nope: true })).toEqual([]);
  });
});

describe("conversationsFileIo", () => {
  it("names the allowlisted file for the injected store", async () => {
    const reads: string[] = [];
    const writes: [string, string][] = [];
    const io = conversationsFileIo({
      read: async (name) => {
        reads.push(name);
        return null;
      },
      write: async (name, contents) => {
        writes.push([name, contents]);
      },
    });
    await io.read();
    await io.write("body");
    expect(reads).toEqual([CONVERSATIONS_FILE]);
    expect(writes).toEqual([[CONVERSATIONS_FILE, "body"]]);
  });
});
