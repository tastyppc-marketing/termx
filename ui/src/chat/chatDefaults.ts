/**
 * Chat view defaults.
 *
 * SETTINGS-INTEGRATION. The companion settings spec adds two user settings —
 * the default view for agent panes and the default density. They land in a
 * parallel lane, so every default is read through this module and nowhere
 * else: wiring the settings means changing these two functions to consult the
 * settings snapshot, and nothing else in `ui/src/chat/` moves.
 */

import type { ChatDensity, ChatViewMode } from "./types";

/**
 * A pane opens on the terminal. Chat is a deliberate flip, not something a
 * user finds themselves in after a restart.
 */
export const DEFAULT_CHAT_VIEW_MODE: ChatViewMode = "terminal";

/** `smart` opens what usually matters (errors, edits, test runs) and no more. */
export const DEFAULT_CHAT_DENSITY: ChatDensity = "smart";

export const CHAT_DENSITIES: readonly ChatDensity[] = ["chips", "smart", "full"];

/** SETTINGS-INTEGRATION: replace the body with the settings lookup. */
export function defaultChatViewMode(): ChatViewMode {
  return DEFAULT_CHAT_VIEW_MODE;
}

/** SETTINGS-INTEGRATION: replace the body with the settings lookup. */
export function defaultChatDensity(): ChatDensity {
  return DEFAULT_CHAT_DENSITY;
}

/** Tolerant parse for a persisted value; anything unknown falls back. */
export function parseChatDensity(value: unknown): ChatDensity | undefined {
  return CHAT_DENSITIES.includes(value as ChatDensity)
    ? (value as ChatDensity)
    : undefined;
}

/** Tolerant parse for a persisted view mode. */
export function parseChatViewMode(value: unknown): ChatViewMode | undefined {
  return value === "terminal" || value === "chat" ? value : undefined;
}
