/**
 * One conversation, one record (`SessionKey` is documented as "stable identity
 * across rescans" in types.ts).
 *
 * The scanner walks FILES: claude copies a transcript into every project folder
 * a conversation was given access to, so one conversation can sit on disk under
 * several `~/.claude/projects/<slug>/` directories with the SAME id and the same
 * mtime. Those copies used to reach the renderer as separate records, and every
 * consumer that treats `provider:id` as an identity — the rail, `findRecord`,
 * and above all the pane→conversation linkage the save dialog runs on — saw
 * phantom ambiguity: two "different" sessions in one folder, equally recent, so
 * the linkage refused to pick and the pin silently wrote a FOLDER-ONLY save.
 *
 * Verified against the live index on this machine (1339 file rows / 1272 ids;
 * 7 directories resolved to no linkage at all, every one of them a same-id
 * pair) — including `C:\Users\mjfos`, the folder of the saved entry that
 * "just opens the directory".
 */

import { describe, expect, it, vi } from "vitest";
import { resolveLinkage } from "../../chat/linkage";
import { ConversationsStore, dedupeSessions } from "../store";
import type { LlmSessionRecord, SessionLister } from "../types";

function record(overrides: Partial<LlmSessionRecord> = {}): LlmSessionRecord {
  return {
    provider: "claude",
    id: "9fca5e44",
    title: "Home session",
    cwd: "C:\\Users\\mjfos",
    filePath: "C:\\Users\\mjfos\\.claude\\projects\\C--Users-mjfos\\9fca5e44.jsonl",
    updatedAtMs: 1_786_967_273_195,
    summary: null,
    recap: null,
    ...overrides,
  };
}

/** The same conversation, copied into another project's folder. */
function copyOf(base: LlmSessionRecord, slug: string): LlmSessionRecord {
  return {
    ...base,
    filePath: `C:\\Users\\mjfos\\.claude\\projects\\${slug}\\${base.id}.jsonl`,
  };
}

describe("dedupeSessions", () => {
  it("collapses copies of one conversation into a single record", () => {
    const canonical = record();
    const copy = copyOf(canonical, "C--Users-mjfos-OneDrive-Desktop-Clients-Amy");

    expect(dedupeSessions([copy, canonical])).toEqual([canonical]);
  });

  it("keeps the copy that lives in the conversation's own project folder", () => {
    const canonical = record();
    const copy = copyOf(canonical, "C--Users-mjfos-OneDrive-Desktop-Clients-Amy");

    // Whichever order the scan produced them in.
    expect(dedupeSessions([canonical, copy])[0]?.filePath).toBe(canonical.filePath);
    expect(dedupeSessions([copy, canonical])[0]?.filePath).toBe(canonical.filePath);
  });

  it("keeps the newest when the copies differ in mtime", () => {
    // The canonical copy is the STALE one here, so recency has to win over it.
    const older = copyOf(record({ updatedAtMs: 1_000 }), "C--Users-mjfos");
    const newer = copyOf(record({ updatedAtMs: 2_000 }), "C--Elsewhere");

    expect(dedupeSessions([older, newer])).toEqual([newer]);
  });

  it("prefers a record with a transcript over one without", () => {
    const withFile = record();
    const withoutFile = record({ filePath: "" });

    expect(dedupeSessions([withoutFile, withFile])).toEqual([withFile]);
  });

  it("leaves distinct sessions alone, in scan order", () => {
    const a = record({ id: "a" });
    const b = record({ id: "b" });
    const codex = record({ id: "a", provider: "codex" }); // same id, other provider

    expect(dedupeSessions([a, b, codex])).toEqual([a, b, codex]);
  });
});

describe("ConversationsStore.refresh", () => {
  it("publishes one record per conversation even when the scan lists copies", async () => {
    const canonical = record();
    const list = vi.fn<SessionLister>(async () => [
      copyOf(canonical, "C--Users-mjfos-OneDrive-Desktop-Clients-Amy"),
      canonical,
      record({ id: "other", updatedAtMs: 10 }),
    ]);
    const store = new ConversationsStore({ list, debounceMs: 0 });

    await store.refresh(true);

    const records = store.getSnapshot().records;
    expect(records.map((entry) => entry.id)).toEqual(["9fca5e44", "other"]);
    expect(records[0]?.filePath).toBe(canonical.filePath);
  });
});

describe("the pin that wrote a folder-only save", () => {
  it("links the pane's conversation once the copies are collapsed", async () => {
    const canonical = record();
    const copy = copyOf(canonical, "C--Users-mjfos-OneDrive-Desktop-Clients-Amy");
    const store = new ConversationsStore({
      list: async () => [copy, canonical],
      debounceMs: 0,
    });

    // Raw scan output: two rows, same id, same mtime — the tie-break gives up
    // and the pane looks conversation-less. This is the bug, kept as the
    // baseline the fix has to beat.
    expect(
      resolveLinkage({ paneCwd: "C:\\Users\\mjfos", candidates: [copy, canonical] }),
    ).toBeNull();

    await store.refresh(true);
    const link = resolveLinkage({
      paneCwd: "C:\\Users\\mjfos",
      candidates: store.getSnapshot().records,
    });

    expect(link?.record.id).toBe("9fca5e44");
  });
});
