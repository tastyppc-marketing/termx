import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  readTranscriptWindow,
  searchTranscript,
} from "../../../native/transcript";

describe("transcript invoke wrappers", () => {
  beforeEach(() => invoke.mockReset());

  it("passes the exact window command and camelCase arguments", async () => {
    invoke.mockResolvedValue({ lines: ["one"], nextBeforeOffset: 42 });

    await expect(readTranscriptWindow("C:\\sessions\\one.jsonl", 81, 262_144)).resolves.toEqual({
      lines: ["one"],
      nextBeforeOffset: 42,
    });
    expect(invoke).toHaveBeenCalledWith("read_transcript_window", {
      filePath: "C:\\sessions\\one.jsonl",
      beforeOffset: 81,
      maxBytes: 262_144,
    });
  });

  it("passes search mode, filter, and result cap unchanged", async () => {
    invoke.mockResolvedValue({
      matches: [{ offset: 17, snippet: "needle" }],
      truncated: false,
    });

    await expect(
      searchTranscript(
        "C:\\sessions\\one.jsonl",
        "n.*e",
        "regex",
        "user",
        200,
      ),
    ).resolves.toMatchObject({ matches: [{ offset: 17 }], truncated: false });
    expect(invoke).toHaveBeenCalledWith("search_transcript", {
      filePath: "C:\\sessions\\one.jsonl",
      query: "n.*e",
      mode: "regex",
      filter: "user",
      maxResults: 200,
    });
  });
});
