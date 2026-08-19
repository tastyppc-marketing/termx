/**
 * The chat surface (chat-view spec §4).
 *
 * It renders OVER a pane's terminal, which keeps running underneath: the chat
 * reads a transcript and writes keystrokes, and it never touches the PTY's
 * output path. Everything it can send — the header's Esc and Ctrl+C, the input
 * box — goes through the one `sendKeys` prop, so there is exactly one place
 * where this view can produce input.
 *
 * It draws no terminal pixels and offers no way to (chat v3 spec §0): the
 * full terminal is reachable only through the header's Terminal button.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatBubble } from "./ChatBubble";
import { ChatInput } from "./ChatInput";
import { CHAT_DENSITIES } from "./chatDefaults";
import { isExpandedByDefault } from "./density";
import type { ChatFeed } from "./feed";
import type { ChatDensity, ChatEntry } from "./types";
import "./ChatView.css";

/** Rows kept in the DOM. Older ones are one button away, not gone. */
export const RENDER_WINDOW = 500;

/** How close to the bottom still counts as "following the conversation". */
const PINNED_SLACK_PX = 40;

/** Interrupt, then stop — the two keys a running agent understands. */
export const ESC_KEY = "\x1b";
export const CTRL_C_KEY = "\x03";

export interface ChatHeaderProps {
  title: string;
  /** Model label, when the session names one. */
  model?: string;
  onFlipToTerminal(): void;
  /** Opens the "Link conversation…" picker; absent hides the button. */
  onOpenLinkPicker?: () => void;
}

export interface ChatViewProps {
  feed: ChatFeed;
  density: ChatDensity;
  onDensityChange(density: ChatDensity): void;
  /**
   * Whether reasoning rows start open. Deliberately independent of `density`:
   * the thoughts are worth reading even while every tool stays a chip.
   */
  showThinking: boolean;
  onShowThinkingChange(showThinking: boolean): void;
  /** Raw PTY write. The ONLY way this view produces input. */
  sendKeys(data: string): void;
  header: ChatHeaderProps;
  /** Extra rows between the feed and the bottom (the input box). */
  children?: React.ReactNode;
}

export function ChatView({
  feed,
  density,
  onDensityChange,
  showThinking,
  onShowThinkingChange,
  sendKeys,
  header,
  children,
}: ChatViewProps) {
  const [, setVersion] = useState(0);
  const [stale, setStale] = useState(feed.stale);
  const [limit, setLimit] = useState(RENDER_WINDOW);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [pinned, setPinned] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setVersion((current) => current + 1);
    const stopUpdate = feed.onUpdate(() => setVersion((current) => current + 1));
    const stopStale = feed.onStale(setStale);
    setStale(feed.stale);
    return () => {
      stopUpdate();
      stopStale();
    };
  }, [feed]);

  const entries = feed.entries;
  const start = Math.max(0, entries.length - limit);
  const visible = entries.slice(start);

  // Following the conversation means staying at the bottom as it grows; a user
  // who scrolled up is reading, and must not be yanked away from it.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && pinned) {
      element.scrollTop = element.scrollHeight;
    }
  }, [entries.length, pinned]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setPinned(distance <= PINNED_SLACK_PX);
  }, []);

  const jumpToLatest = () => {
    const element = scrollRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
    setPinned(true);
  };

  const defaultExpanded = (entry: ChatEntry) => {
    if (entry.kind === "tool") {
      return isExpandedByDefault(entry, density);
    }
    return entry.kind === "thinking" ? showThinking : false;
  };

  const toggleEntry = (id: string) => {
    setOverrides((current) => {
      const entry = entries.find((candidate) => candidate.id === id);
      const fallback = entry ? defaultExpanded(entry) : false;
      return { ...current, [id]: !(current[id] ?? fallback) };
    });
  };

  const isExpanded = (entry: ChatEntry) =>
    entry.kind === "tool" || entry.kind === "thinking"
      ? (overrides[entry.id] ?? defaultExpanded(entry))
      : false;

  // Flipping the header preference speaks for EVERY row again: per-row
  // overrides on thinking are cleared so the change is visible immediately.
  const toggleShowThinking = () => {
    onShowThinkingChange(!showThinking);
    setOverrides((current) => {
      const next: Record<string, boolean> = {};
      for (const [id, value] of Object.entries(current)) {
        const entry = entries.find((candidate) => candidate.id === id);
        if (entry?.kind !== "thinking") {
          next[id] = value;
        }
      }
      return next;
    });
  };

  return (
    <section className="chat-view" data-testid="chat-view" aria-label="Session chat">
      <header className="chat-header">
        <span className="chat-header__title" title={header.title}>
          {header.title}
        </span>
        {header.model ? (
          <span className="chat-header__model">{header.model}</span>
        ) : null}
        <div className="chat-header__density" role="group" aria-label="Detail density">
          {CHAT_DENSITIES.map((value) => (
            <button
              key={value}
              type="button"
              className="chat-header__density-option"
              aria-pressed={value === density}
              onClick={() => onDensityChange(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="chat-header__button"
          aria-pressed={showThinking}
          title="Keep the reasoning open in every row"
          onClick={toggleShowThinking}
        >
          Thoughts
        </button>
        {header.onOpenLinkPicker ? (
          <button
            type="button"
            className="chat-header__button"
            onClick={header.onOpenLinkPicker}
          >
            Link conversation…
          </button>
        ) : null}
        <button
          type="button"
          className="chat-header__button"
          title="Send Escape to the session"
          onClick={() => sendKeys(ESC_KEY)}
        >
          Esc
        </button>
        <button
          type="button"
          className="chat-header__button"
          title="Send Ctrl+C to the session"
          onClick={() => sendKeys(CTRL_C_KEY)}
        >
          Ctrl+C
        </button>
        <button
          type="button"
          className="chat-header__button chat-header__button--flip"
          onClick={header.onFlipToTerminal}
        >
          Terminal
        </button>
      </header>

      {stale ? (
        <div className="chat-stale" role="status" data-testid="chat-stale">
          The transcript stopped responding. Still retrying.
        </div>
      ) : null}

      <div
        className="chat-scroll"
        data-testid="chat-scroll"
        ref={scrollRef}
        onScroll={onScroll}
      >
        {start > 0 ? (
          <button
            type="button"
            className="chat-earlier"
            onClick={() => setLimit((current) => current + RENDER_WINDOW)}
          >
            Show earlier
          </button>
        ) : null}
        {visible.map((entry) => (
          <ChatBubble
            key={entry.id}
            entry={entry}
            expanded={isExpanded(entry)}
            onToggle={toggleEntry}
          />
        ))}
      </div>

      {!pinned ? (
        <button
          type="button"
          className="chat-jump"
          data-testid="chat-jump"
          onClick={jumpToLatest}
        >
          Jump to latest
        </button>
      ) : null}

      <div className="chat-input-row">
        <ChatInput sendKeys={sendKeys} />
      </div>

      {children}
    </section>
  );
}
