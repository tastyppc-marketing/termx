/**
 * Chat view domain types (chat-view spec §3).
 *
 * `ChatEntry` is the exact wire shape of the Rust `chat_feed_*` commands
 * (`ui/src-tauri/src/chat_feed.rs`): a `kind` discriminator plus that kind's
 * fields. One renderer, and — once a Codex-native adapter exists — more than
 * one source feeding it.
 */

/** How much of a tool's body the chat opens by itself (spec §4). */
export type ChatDensity = "chips" | "smart" | "full";

/** Which surface a pane is showing (spec §1). */
export type ChatViewMode = "terminal" | "chat";

/** Where a tool call stands. `running` has no result yet. */
export type ToolStatus = "running" | "ok" | "error";

export type ChatEntry =
  | { kind: "user"; id: string; ts: number; text: string }
  | { kind: "assistant"; id: string; ts: number; markdown: string }
  | { kind: "thinking"; id: string; ts: number; text: string }
  | {
      kind: "tool";
      id: string;
      ts: number;
      name: string;
      /** The chip's action line: "Edited App.tsx". */
      title: string;
      /** The chip's right-hand detail: "+12 −3". Often empty. */
      summary: string;
      status: ToolStatus;
      /** The expandable body. */
      detail: string;
    }
  | { kind: "system"; id: string; ts: number; text: string };

/** One window of the feed, as `chat_feed_open`/`chat_feed_poll` return it. */
export interface FeedWindow {
  feedId: number;
  entries: ChatEntry[];
  offset: number;
  /**
   * The transcript was replaced or truncated (a compaction rewrite). Whatever
   * the renderer holds is stale and these entries are the whole new tail.
   */
  reset: boolean;
}

/** A tool entry, narrowed — the shape the density policy and chip consume. */
export type ToolEntry = Extract<ChatEntry, { kind: "tool" }>;
