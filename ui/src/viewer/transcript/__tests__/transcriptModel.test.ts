import { describe, expect, it } from "vitest";
import {
  enforceTranscriptMemoryGuard,
  flattenTranscriptLines,
  mergeTranscriptChunk,
  parseTranscriptWindow,
} from "../transcriptModel";

const user = (text: string) =>
  JSON.stringify({ type: "user", message: { content: text } });
const assistant = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });

describe("transcript window model", () => {
  it("reconstructs ordered turns while pages arrive newest first", () => {
    const newer = parseTranscriptWindow(
      "end",
      null,
      { lines: [assistant("new answer")], nextBeforeOffset: 100 },
      "claude",
    );
    const older = parseTranscriptWindow(
      "before:100",
      100,
      { lines: [user("old question")], nextBeforeOffset: null },
      "claude",
    );

    const chunks = mergeTranscriptChunk(
      mergeTranscriptChunk([], newer),
      older,
    );

    expect(flattenTranscriptLines(chunks).map((line) => line.entries[0])).toMatchObject([
      { kind: "message", role: "user", text: "old question" },
      { kind: "message", role: "assistant", text: "new answer" },
    ]);
    expect(chunks.map((chunk) => chunk.startOffset)).toEqual([0, 100]);
  });

  it("routes Claude text and tools into renderable entries and skips broken lines", () => {
    const lines = [
      user("# plain user text"),
      assistant("# rendered assistant text"),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Write",
              input: { file_path: "ui/src/App.tsx", content: "large body" },
            },
          ],
        },
      }),
      "{broken",
    ];

    const chunk = parseTranscriptWindow(
      "start",
      null,
      { lines, nextBeforeOffset: null },
      "claude",
    );
    const entries = flattenTranscriptLines([chunk]).flatMap((line) => line.entries);

    expect(entries).toMatchObject([
      { kind: "message", role: "user", text: "# plain user text" },
      { kind: "message", role: "assistant", text: "# rendered assistant text" },
      {
        kind: "tool",
        phase: "call",
        name: "Write",
        summary: "ui/src/App.tsx",
      },
    ]);
    expect(chunk.lines).toHaveLength(3);
  });

  it("correlates tool results with the preceding call name", () => {
    const chunk = parseTranscriptWindow(
      "tools",
      null,
      {
        lines: [
          JSON.stringify({
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tool-1",
                  name: "Write",
                  input: { file_path: "ui/src/App.tsx" },
                },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-1",
                  content: "updated",
                },
              ],
            },
          }),
        ],
        nextBeforeOffset: null,
      },
      "claude",
    );

    expect(flattenTranscriptLines([chunk]).flatMap((line) => line.entries)).toMatchObject([
      { kind: "tool", phase: "call", name: "Write" },
      { kind: "tool", phase: "result", name: "Write" },
    ]);
  });

  it("understands Codex response items without rendering session metadata", () => {
    const chunk = parseTranscriptWindow(
      "codex",
      null,
      {
        lines: [
          JSON.stringify({ type: "session_meta", payload: { cwd: "C:\\work" } }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "inspect it" }],
            },
          }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "local_shell_call",
              action: { type: "exec", command: "npm run build" },
              call_id: "call-2",
            },
          }),
        ],
        nextBeforeOffset: null,
      },
      "codex",
    );

    expect(flattenTranscriptLines([chunk]).flatMap((line) => line.entries)).toMatchObject([
      { kind: "message", role: "user", text: "inspect it" },
      { kind: "tool", phase: "call", name: "shell", summary: "npm run build" },
    ]);
  });

  it("retains the requested window size for exact section reloads", () => {
    const chunk = parseTranscriptWindow(
      "match:0",
      4_194_303,
      { lines: [user("target")], nextBeforeOffset: 0 },
      "claude",
      4_194_304,
    );

    expect(chunk.requestMaxBytes).toBe(4_194_304);
  });

  it("evicts the loaded chunk farthest from the viewport but retains its reload cursor", () => {
    const first = parseTranscriptWindow(
      "before:100",
      100,
      { lines: [user("a".repeat(80))], nextBeforeOffset: null },
      "claude",
    );
    const middle = parseTranscriptWindow(
      "before:200",
      200,
      { lines: [user("b".repeat(80))], nextBeforeOffset: 100 },
      "claude",
    );
    const last = parseTranscriptWindow(
      "end",
      null,
      { lines: [assistant("c".repeat(80))], nextBeforeOffset: 200 },
      "claude",
    );

    const guarded = enforceTranscriptMemoryGuard(
      [first, middle, last],
      middle.byteSize + last.byteSize,
      250,
    );

    expect(guarded.find((chunk) => chunk.key === "before:100")).toMatchObject({
      requestBeforeOffset: 100,
      lines: null,
    });
    expect(guarded.filter((chunk) => chunk.lines !== null)).toHaveLength(2);

    const reloaded = mergeTranscriptChunk(
      guarded,
      parseTranscriptWindow(
        "before:100",
        100,
        { lines: [user("restored")], nextBeforeOffset: null },
        "claude",
      ),
    );
    expect(reloaded.find((chunk) => chunk.key === "before:100")?.lines?.[0]?.entries[0]).toMatchObject({
      kind: "message",
      text: "restored",
    });
  });
});
