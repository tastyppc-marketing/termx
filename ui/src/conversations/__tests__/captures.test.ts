/**
 * Conversation captures (plugin-phase1 Task C): the per-pane pairing the
 * Claude Code SessionStart hook appends, and the record the dead pane resumes.
 *
 * The parser is the trust boundary — the file is written by a hook process
 * TermX does not control, one line at a time, and a torn or hand-edited line
 * must never poison the rest.
 */

import { describe, expect, it } from "vitest";
import type { LlmSessionRecord } from "../types";
import { capturedRecord, parseCaptures, type ConversationCapture } from "../captures";

const ID_A = "7d9e2f10-3a4b-4c5d-8e6f-102938475650";
const ID_B = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

function line(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    termxSessionId: 3,
    provider: "claude",
    id: ID_A,
    cwd: "C:\\work\\project-3",
    atMs: 1000,
    ...overrides,
  });
}

describe("parseCaptures", () => {
  it("reads one capture per TermX session id", () => {
    const captures = parseCaptures([line(), line({ termxSessionId: 4, id: ID_B })].join("\n"));

    expect(captures.get(3)).toEqual({
      termxSessionId: 3,
      provider: "claude",
      id: ID_A,
      cwd: "C:\\work\\project-3",
      atMs: 1000,
    } satisfies ConversationCapture);
    expect(captures.get(4)?.id).toBe(ID_B);
  });

  it("treats a missing file as no captures", () => {
    expect(parseCaptures(null).size).toBe(0);
    expect(parseCaptures("").size).toBe(0);
  });

  it("keeps the newest capture for a session and ignores an older late line", () => {
    const captures = parseCaptures(
      [
        line({ atMs: 5000, id: ID_B }),
        line({ atMs: 1000 }),
      ].join("\n"),
    );

    expect(captures.get(3)?.id).toBe(ID_B);
    expect(captures.get(3)?.atMs).toBe(5000);
  });

  it("skips garbage lines without losing the good ones around them", () => {
    const captures = parseCaptures(
      [
        "not json at all",
        "",
        "   ",
        "[1,2,3]",
        "null",
        line(),
        "{\"v\":1,", // torn write: the hook died mid-append
      ].join("\n"),
    );

    expect([...captures.keys()]).toEqual([3]);
  });

  it("drops a line whose id would not be safe on a command line", () => {
    const captures = parseCaptures(
      [
        line({ id: "not a; valid id" }),
        line({ termxSessionId: 4, id: "" }),
        line({ termxSessionId: 5, id: 42 }),
      ].join("\n"),
    );

    expect(captures.size).toBe(0);
  });

  it("drops a line with an unknown provider or an unusable session id", () => {
    const captures = parseCaptures(
      [
        line({ provider: "gemini" }),
        line({ termxSessionId: "3" }),
        line({ termxSessionId: 3.5 }),
        line({ termxSessionId: -1 }),
      ].join("\n"),
    );

    expect(captures.size).toBe(0);
  });

  it("ignores a line from a future capture format", () => {
    expect(parseCaptures(line({ v: 2 })).size).toBe(0);
  });

  it("reads a capture with no cwd, and tolerates \\r\\n line endings", () => {
    const captures = parseCaptures(`${line({ cwd: null })}\r\n${line({ termxSessionId: 4 })}\r\n`);

    expect(captures.get(3)?.cwd).toBeNull();
    expect(captures.get(4)?.cwd).toBe("C:\\work\\project-3");
  });
});

describe("the hook's own output", () => {
  /**
   * Copied verbatim from a real run of tools/claude-hooks/termx-capture.py
   * (`TERMX_SESSION_ID=3`, a Claude SessionStart payload on stdin). The hook
   * and this parser are two languages either side of a file: only a byte-exact
   * fixture proves they still agree.
   */
  const GOLDEN = String
    .raw`{"v":1,"termxSessionId":3,"provider":"claude","id":"7d9e2f10-3a4b-4c5d-8e6f-102938475650","cwd":"C:\\Dev\\TermX","atMs":1788162586470}`;

  it("parses a line the hook actually wrote", () => {
    expect(parseCaptures(`${GOLDEN}\n`).get(3)).toEqual({
      termxSessionId: 3,
      provider: "claude",
      id: ID_A,
      cwd: "C:\\Dev\\TermX",
      atMs: 1788162586470,
    } satisfies ConversationCapture);
  });
});

describe("capturedRecord", () => {
  const capture: ConversationCapture = {
    termxSessionId: 3,
    provider: "claude",
    id: ID_A,
    cwd: "C:\\work\\project-3",
    atMs: 1000,
  };

  it("synthesizes a resumable record when the index has not scanned the session yet", () => {
    expect(capturedRecord(capture, null)).toEqual({
      provider: "claude",
      id: ID_A,
      title: "Captured conversation",
      cwd: "C:\\work\\project-3",
      filePath: "",
      updatedAtMs: 1000,
      summary: null,
      recap: null,
      titleSource: "derived",
    } satisfies LlmSessionRecord);
  });

  it("prefers the indexed record's title and transcript when there is one", () => {
    const indexed: LlmSessionRecord = {
      provider: "claude",
      id: ID_A,
      title: "Daemon work",
      cwd: "C:\\work\\elsewhere",
      filePath: "C:\\transcripts\\a.jsonl",
      updatedAtMs: 9000,
      summary: "s",
      recap: "r",
      titleSource: "named",
    };

    expect(capturedRecord(capture, indexed)).toMatchObject({
      title: "Daemon work",
      filePath: "C:\\transcripts\\a.jsonl",
      updatedAtMs: 9000,
      // The pane's own folder wins: the hook recorded where the pane was, and
      // that is the folder a restart must land in.
      cwd: "C:\\work\\project-3",
    });
  });

  it("falls back to the indexed cwd when the capture has none", () => {
    const indexed: LlmSessionRecord = {
      provider: "claude",
      id: ID_A,
      title: "Daemon work",
      cwd: "C:\\work\\elsewhere",
      filePath: "",
      updatedAtMs: 9000,
      summary: null,
      recap: null,
    };

    expect(capturedRecord({ ...capture, cwd: null }, indexed).cwd).toBe("C:\\work\\elsewhere");
  });
});
