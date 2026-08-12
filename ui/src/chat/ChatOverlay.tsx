/**
 * The chat view plus the feed that fills it (chat-view spec §1/§3).
 *
 * A pane owns a terminal; this owns the transcript tail. Keeping them apart is
 * what lets the terminal stay mounted and attached underneath while the chat
 * is on screen — flipping views opens and closes a feed, and touches nothing
 * about the session itself.
 */

import { useEffect, useState } from "react";
import { ChatView, type ChatHeaderProps } from "./ChatView";
import { openChatFeed, type ChatFeed } from "./feed";
import type { ChatDensity } from "./types";

/** Spec §5: the transcript counts as quiet after this long without an entry. */
export const TRANSCRIPT_IDLE_MS = 2_000;

export interface ChatOverlayProps {
  /** Absolute path of the linked transcript. */
  filePath: string;
  header: ChatHeaderProps;
  density: ChatDensity;
  onDensityChange(density: ChatDensity): void;
  /** Whether reasoning rows start open (independent of `density`). */
  showThinking: boolean;
  onShowThinkingChange(showThinking: boolean): void;
  sendKeys(data: string): void;
  terminalSnapshot?: () => string[];
  /** Injected feed opener; production uses the tauri commands. */
  openFeed?: typeof openChatFeed;
}

export function ChatOverlay({
  filePath,
  header,
  density,
  onDensityChange,
  showThinking,
  onShowThinkingChange,
  sendKeys,
  terminalSnapshot,
  openFeed = openChatFeed,
}: ChatOverlayProps) {
  const [feed, setFeed] = useState<ChatFeed | null>(null);
  const [failed, setFailed] = useState(false);
  const [idle, setIdle] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let opened: ChatFeed | null = null;
    setFeed(null);
    setFailed(false);
    void openFeed(filePath).then(
      (next) => {
        opened = next;
        if (cancelled) {
          next.dispose();
          return;
        }
        setFeed(next);
      },
      () => {
        if (!cancelled) {
          setFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
      opened?.dispose();
    };
  }, [filePath, openFeed]);

  // "Idle" means the agent has stopped writing. A prompt card may only appear
  // then — mid-answer, the thing on screen is output, not a question.
  useEffect(() => {
    if (!feed) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const quietDown = () => {
      timer = setTimeout(() => setIdle(true), TRANSCRIPT_IDLE_MS);
    };
    const stop = feed.onUpdate(() => {
      setIdle(false);
      clearTimeout(timer);
      quietDown();
    });
    quietDown();
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [feed]);

  if (failed) {
    return (
      <section className="chat-view" data-testid="chat-unavailable" aria-label="Session chat">
        <div className="chat-stale" role="status">
          This session's transcript could not be read.
        </div>
        <button
          type="button"
          className="chat-header__button"
          onClick={header.onFlipToTerminal}
        >
          Terminal
        </button>
      </section>
    );
  }

  if (!feed) {
    return (
      <section className="chat-view" data-testid="chat-loading" aria-label="Session chat">
        <div className="chat-stale" role="status">
          Reading the transcript…
        </div>
      </section>
    );
  }

  return (
    <ChatView
      feed={feed}
      density={density}
      onDensityChange={onDensityChange}
      showThinking={showThinking}
      onShowThinkingChange={onShowThinkingChange}
      sendKeys={sendKeys}
      header={header}
      transcriptIdle={idle}
      {...(terminalSnapshot ? { terminalSnapshot } : {})}
    />
  );
}
