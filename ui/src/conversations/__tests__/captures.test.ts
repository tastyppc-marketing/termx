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
import {
  capturedRecord,
  compactCaptures,
  parseCaptures,
  type ConversationCapture,
} from "../captures";

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

  /**
   * The torn write that actually happens. A hook killed mid-append leaves a
   * fragment with NO trailing newline, so the NEXT capture is appended straight
   * onto the stump and one physical line holds a stump plus a whole record.
   * A fragment at the END of the file is the easy case; this is the one that
   * eats a real capture if the parser ever tries to be clever.
   */
  it("drops a torn line glued mid-file to the complete line after it", () => {
    const swallowed = line({ termxSessionId: 9, id: ID_B, atMs: 7000 });
    const captures = parseCaptures(
      [
        line({ termxSessionId: 3, atMs: 1000 }),
        `{"v":1,"termxSessionId":3,"pro${swallowed}`,
        line({ termxSessionId: 4, id: ID_B, atMs: 8000 }),
      ].join("\n"),
    );

    // The glued line is unparseable JSON: it is dropped WHOLE. Session 9 was
    // written but never lands — the loss is the hook's, not the parser's.
    expect([...captures.keys()].sort((a, b) => a - b)).toEqual([3, 4]);
    expect(captures.get(9)).toBeUndefined();
    // Both intact lines around it survive, including the one BEFORE the tear.
    expect(captures.get(3)?.atMs).toBe(1000);
    expect(captures.get(4)?.id).toBe(ID_B);
  });

  it("reads a capture with no cwd, and tolerates \\r\\n line endings", () => {
    const captures = parseCaptures(`${line({ cwd: null })}\r\n${line({ termxSessionId: 4 })}\r\n`);

    expect(captures.get(3)?.cwd).toBeNull();
    expect(captures.get(4)?.cwd).toBe("C:\\work\\project-3");
  });
});

describe("compactCaptures", () => {
  const KIB = 1024;

  /** A capture log of `count` appended lines cycling through `panes` panes. */
  function log(count: number, panes: number): string {
    const lines: string[] = [];
    for (let index = 0; index < count; index += 1) {
      lines.push(line({ termxSessionId: index % panes, atMs: 1000 + index }));
    }
    return `${lines.join("\n")}\n`;
  }

  it("leaves a log under 512 KiB alone even when it has duplicates", () => {
    const text = log(200, 5);

    // Guard the premise: this test means nothing if the log is already huge.
    expect(text.length).toBeLessThan(512 * KIB);
    expect(compactCaptures(text)).toBeNull();
  });

  it("compacts a log past 512 KiB to the newest line per pane", () => {
    const text = log(6000, 50);
    expect(text.length).toBeGreaterThan(512 * KIB);

    const compacted = compactCaptures(text);

    expect(compacted).not.toBeNull();
    const result = compacted as string;
    expect(result.length).toBeLessThan(text.length);
    expect(result.endsWith("\n")).toBe(true);
    expect(result.trimEnd().split("\n")).toHaveLength(50);
    // The whole point: compaction must not change a single resume decision.
    expect(parseCaptures(result)).toEqual(parseCaptures(text));
  });

  it("keeps the winning line's original bytes rather than re-serializing it", () => {
    const text = log(6000, 50);
    const survivors = text.trimEnd().split("\n");
    const newestForPane7 = survivors.filter(
      (candidate) => (JSON.parse(candidate) as { termxSessionId: number }).termxSessionId === 7,
    );

    const result = compactCaptures(text) as string;

    expect(result.split("\n")).toContain(newestForPane7[newestForPane7.length - 1]);
  });

  it("orders the compacted log oldest-first, the way the hook appends", () => {
    const result = compactCaptures(log(6000, 50)) as string;

    const stamps = result
      .trimEnd()
      .split("\n")
      .map((candidate) => (JSON.parse(candidate) as { atMs: number }).atMs);

    expect(stamps).toEqual([...stamps].sort((left, right) => left - right));
  });

  it("drops torn and hostile lines instead of carrying them forever", () => {
    const text = `${log(6000, 50).trimEnd()}\n{"v":1,"termxSes\nnot json at all\n\n`;

    const result = compactCaptures(text) as string;

    expect(result.trimEnd().split("\n")).toHaveLength(50);
    expect(result).not.toContain("not json at all");
    expect(result).not.toContain("termxSes\n");
  });

  /**
   * The caller writes back whenever this returns non-null, so "already compact"
   * MUST come back null — otherwise every boot rewrites a file it did not
   * change, racing the hook's appends for nothing.
   */
  it("is idempotent: a log that is already compact needs no second pass", () => {
    const once = compactCaptures(log(10000, 5000));

    expect(once).not.toBeNull();
    const result = once as string;
    // Still over the threshold, so the second call really does re-run the
    // whole compaction rather than short-circuiting on size.
    expect(result.length).toBeGreaterThan(512 * KIB);
    expect(compactCaptures(result)).toBeNull();
  });

  /**
   * Host session ids are monotonic and never reused, so a capture naming a
   * pane that is gone from the layout can never be resumed by anything. That
   * is the only truly unbounded axis: newest-per-pane still grows one line per
   * pane forever, and a long-lived install opens a lot of panes.
   */
  describe("with a keep set", () => {
    it("drops captures for panes the layout no longer has", () => {
      const text = log(6000, 50);

      const result = compactCaptures(text, new Set([1, 2, 3])) as string;

      expect(result).not.toBeNull();
      expect(result.trimEnd().split("\n")).toHaveLength(3);
      expect([...parseCaptures(result).keys()].sort((left, right) => left - right))
        .toEqual([1, 2, 3]);
      // The lines that survive are still the newest-per-pane ones, unchanged.
      expect(parseCaptures(result).get(3)).toEqual(parseCaptures(text).get(3));
    });

    it("ignores ids in the keep set that the log never captured", () => {
      const result = compactCaptures(log(6000, 50), new Set([1, 999, 1000])) as string;

      expect([...parseCaptures(result).keys()]).toEqual([1]);
    });

    it("keeps every pane when no keep set is given", () => {
      const text = log(6000, 50);

      expect(compactCaptures(text, undefined)).toBe(compactCaptures(text));
      expect((compactCaptures(text) as string).trimEnd().split("\n")).toHaveLength(50);
    });

    it("returns null when the keep set would change nothing", () => {
      const already = compactCaptures(log(10000, 5000)) as string;
      const everyPane = new Set(Array.from({ length: 5000 }, (_, index) => index));

      expect(compactCaptures(already, everyPane)).toBeNull();
    });

    it("does not lower the threshold: a small log is still left alone", () => {
      // The keep set prunes; it does not decide WHEN to prune. A small log is
      // not worth racing the hook's appends for, however stale it looks.
      expect(compactCaptures(log(200, 5), new Set([1]))).toBeNull();
    });

    it("an empty keep set clears the log, because nothing is resumable", () => {
      // Pinned deliberately: this is the sharp edge for the caller. An empty
      // set means "no pane in the layout", and every capture really is dead.
      expect(compactCaptures(log(6000, 50), new Set())).toBe("");
    });
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
