/**
 * Chat view defaults. Every default is read through this module and nowhere
 * else: callers pass the settings snapshot and the user's
 * `agentPaneDefaultView` / `chatDefaultDensity` choices win, with the
 * constants below as the fallback when no settings are supplied.
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

/**
 * Reasoning starts OPEN, independently of the tool density: the thoughts are
 * the part worth reading while bash noise stays collapsed, and the body is a
 * capped scroll box so an open row never swallows the conversation.
 */
export const DEFAULT_CHAT_SHOW_THINKING = true;

/** Tolerant parse for the persisted thinking preference. */
export function parseChatShowThinking(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * The user's `agentPaneDefaultView` setting when given one, else the built-in
 * default. Structural parameter — `TermxSettings` satisfies it without this
 * module importing the settings layer.
 */
export function defaultChatViewMode(settings?: {
  readonly agentPaneDefaultView: ChatViewMode;
}): ChatViewMode {
  return settings?.agentPaneDefaultView ?? DEFAULT_CHAT_VIEW_MODE;
}

/** The user's `chatDefaultDensity` setting when given one, else the default. */
export function defaultChatDensity(settings?: {
  readonly chatDefaultDensity: ChatDensity;
}): ChatDensity {
  return settings?.chatDefaultDensity ?? DEFAULT_CHAT_DENSITY;
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
