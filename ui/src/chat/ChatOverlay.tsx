/**
 * The chat view plus the feed that fills it (chat-view spec §1/§3).
 *
 * A pane owns a terminal; this owns the transcript tail. Keeping them apart is
 * what lets the terminal stay mounted and attached underneath while the chat
 * is on screen — flipping views opens and closes a feed, and touches nothing
 * about the session itself.
 *
 * It also owns the prompt controller (chat v3 spec §3): the detector needs the
 * transcript-idle signal this component already tracks, and the cards it feeds
 * are drawn by the view below.
 */

import { useEffect, useRef, useState } from "react";
import { ChatView, type ChatHeaderProps } from "./ChatView";
import { openChatFeed, type ChatFeed } from "./feed";
import {
  createPromptController,
  type PromptController,
  type ScheduleFn,
} from "./promptWatcher";
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
  /** The pane was opened by a resume: show the boot happening (spec §4). */
  bootReveal?: boolean;
  /** Injected timer for both controllers (tests). */
  schedule?: ScheduleFn;
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
  bootReveal,
  schedule,
}: ChatOverlayProps) {
  const [feed, setFeed] = useState<ChatFeed | null>(null);
  const [failed, setFailed] = useState(false);
  const [idle, setIdle] = useState(true);

  // Everything the controllers read goes through a ref: a parent re-render
  // hands down new callback identities, and no controller may restart.
  const snapshotRef = useRef(terminalSnapshot);
  snapshotRef.current = terminalSnapshot;
  const idleRef = useRef(idle);
  idleRef.current = idle;
  const hasTerminal = terminalSnapshot !== undefined;
  void bootReveal; // A3 turns this into the boot status card (spec §4).

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

  // Notice claude asking something. A2 wires its state to the cards.
  useEffect(() => {
    if (!hasTerminal) {
      return; // no live terminal to read
    }
    let controller: PromptController | null = null;
    controller = createPromptController({
      snapshot: () => snapshotRef.current?.() ?? [],
      isIdle: () => idleRef.current,
      sendKeys: () => undefined,
      onChange: () => undefined,
      ...(schedule ? { schedule } : {}),
    });
    return () => controller?.dispose();
  }, [hasTerminal, schedule]);

  // "Idle" means the agent has stopped writing. A card may only appear then —
  // mid-answer, the thing on screen is output, not a settled question.
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
    />
  );
}
