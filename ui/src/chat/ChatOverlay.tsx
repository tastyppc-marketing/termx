/**
 * The chat view plus the feed that fills it (chat-view spec §1/§3).
 *
 * A pane owns a terminal; this owns the transcript tail. Keeping them apart is
 * what lets the terminal stay mounted and attached underneath while the chat
 * is on screen — flipping views opens and closes a feed, and touches nothing
 * about the session itself.
 *
 * It also owns everything that talks to the hidden claude on the chat's behalf
 * (chat v3 spec §2/§3/§4): the prompt controller, the slash choreography, and
 * the resume boot card. They live here rather than in the view because each
 * one needs the transcript-idle signal this component already tracks.
 */

import { useEffect, useRef, useState } from "react";
import { SLASH } from "./ChatInput";
import { ChatView, type ChatHeaderProps } from "./ChatView";
import { openChatFeed, type ChatFeed } from "./feed";
import { isIdleScreen } from "./idleDetector";
import { KEY_ESC } from "./PromptCard";
import { KEY_ENTER } from "./promptDetector";
import {
  createPromptController,
  type PromptCardState,
  type PromptController,
  type ScheduleFn,
} from "./promptWatcher";
import { createSlashLearner, type SlashCommand } from "./slashCommands";
import type { ChatDensity } from "./types";

/** Spec §5: the transcript counts as quiet after this long without an entry. */
export const TRANSCRIPT_IDLE_MS = 2_000;

/** How often the boot card re-checks whether claude has finished starting. */
export const AUTO_HIDE_POLL_MS = 500;

/** A boot card never outlives this, however wedged the boot is (spec §4). */
export const BOOT_CARD_MAX_MS = 60_000;

/** Nothing to answer. Also what the view is handed while a card is suppressed. */
const NO_CARD: PromptCardState = { prompt: null, status: "asking", answeredLabel: "" };

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
  /** The cached command list the palette draws from. */
  slashCommands: readonly SlashCommand[];
  /** A parse of claude's own menu; the caller merges it into the cache. */
  onCommandsLearned(commands: SlashCommand[]): void;
  /** Injected timer for every controller here (tests). */
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
  slashCommands,
  onCommandsLearned,
  schedule,
}: ChatOverlayProps) {
  const [feed, setFeed] = useState<ChatFeed | null>(null);
  const [failed, setFailed] = useState(false);
  const [idle, setIdle] = useState(true);
  const [card, setCard] = useState<PromptCardState>(NO_CARD);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [booting, setBooting] = useState(bootReveal === true);
  const promptRef = useRef<PromptController | null>(null);
  const learnerRef = useRef<ReturnType<typeof createSlashLearner> | null>(null);

  // Everything the controllers read goes through a ref: a parent re-render
  // hands down new callback identities, and no controller may restart.
  const snapshotRef = useRef(terminalSnapshot);
  snapshotRef.current = terminalSnapshot;
  const idleRef = useRef(idle);
  idleRef.current = idle;
  const sendRef = useRef(sendKeys);
  sendRef.current = sendKeys;
  const learnedRef = useRef(onCommandsLearned);
  learnedRef.current = onCommandsLearned;
  // A pane boots once. Latched, so re-asserting the prop cannot raise the card
  // again after it has been cleared.
  const bootedRef = useRef(bootReveal === true);
  const hasTerminal = terminalSnapshot !== undefined;

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

  // The detector, and the one place that answers what it finds. The card is
  // the ONLY route back to the PTY for a prompt now — chat mode never shows
  // claude's own dialog, so a question it cannot render is a question the user
  // cannot answer (v3 §3).
  useEffect(() => {
    if (!hasTerminal) {
      return; // no live terminal to read
    }
    let controller: PromptController | null = null;
    controller = createPromptController({
      snapshot: () => snapshotRef.current?.() ?? [],
      isIdle: () => idleRef.current,
      sendKeys: (data) => sendRef.current(data),
      onChange: () => {
        const next = controller?.state() ?? NO_CARD;
        setCard(next);
        if (next.prompt) {
          // A real question takes over the story from the boot card (§4).
          setBooting(false);
        }
      },
      ...(schedule ? { schedule } : {}),
    });
    promptRef.current = controller;
    return () => {
      controller?.dispose();
      promptRef.current = null;
      setCard(NO_CARD);
    };
  }, [hasTerminal, schedule]);

  // The learner outlives any single palette open — start/stop bracket the
  // sample window, and only unmount disposes it (spec §2).
  useEffect(() => {
    if (!hasTerminal) {
      return;
    }
    const learner = createSlashLearner({
      snapshot: () => snapshotRef.current?.() ?? [],
      onLearned: (commands) => learnedRef.current(commands),
      ...(schedule ? { schedule } : {}),
    });
    learnerRef.current = learner;
    return () => {
      learner.dispose();
      learnerRef.current = null;
    };
  }, [hasTerminal, schedule]);

  // A real resume announces its boot AFTER this overlay mounts: the pane links
  // (and this mounts) when the tab opens, while the signal only arrives once
  // the resume command is typed. So the boot is honoured as a rising EDGE too.
  useEffect(() => {
    if (bootReveal === true && !bootedRef.current) {
      bootedRef.current = true;
      setBooting(true);
    }
  }, [bootReveal]);

  // The boot card's three exits (spec §4). Polling rather than a single timer
  // because "claude has finished starting" is two signals, both of which can
  // become true at any moment: a quiet screen AND a quiet transcript.
  useEffect(() => {
    if (!booting) {
      return;
    }
    const tick: ScheduleFn = schedule ?? ((callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      return () => clearTimeout(handle);
    });
    let stopped = false;
    const cancels: (() => void)[] = [];
    const settled = () => idleRef.current && isIdleScreen(snapshotRef.current?.() ?? []);
    const poll = () => {
      cancels.push(
        tick(() => {
          if (stopped) {
            return;
          }
          if (settled()) {
            setBooting(false);
            return;
          }
          poll();
        }, AUTO_HIDE_POLL_MS),
      );
    };
    poll();
    cancels.push(tick(() => setBooting(false), BOOT_CARD_MAX_MS));
    return () => {
      stopped = true;
      for (const cancel of cancels) {
        cancel();
      }
    };
  }, [booting, schedule]);

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

  /**
   * Every way the palette closes ends the same: claude is no longer holding a
   * bare "/", so the learner has nothing left to read.
   */
  const closePalette = () => {
    setPaletteOpen(false);
    learnerRef.current?.stop();
  };

  /** claude's box already holds the "/" we sent — send only what follows it. */
  const completeCommand = (line: string) => {
    const body = line.startsWith(SLASH) ? line.slice(1) : line;
    sendKeys(`${body}${KEY_ENTER}`);
  };

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
      booting={booting}
      // claude's own slash menu is on the screen the detector reads, and it
      // looks exactly like a prompt. Suppressing the card — rather than the
      // controller — keeps the detection running underneath (§3).
      promptCard={paletteOpen ? NO_CARD : card}
      onAnswerMenu={(targetIndex) =>
        paletteOpen ? undefined : promptRef.current?.answerMenu(targetIndex)
      }
      onAnswerConfirm={(affirmative) =>
        paletteOpen ? undefined : promptRef.current?.answerConfirm(affirmative)
      }
      onSendText={(text) => (paletteOpen ? undefined : promptRef.current?.sendText(text))}
      onSendKey={(data) => (paletteOpen ? undefined : sendKeys(data))}
      slashCommands={slashCommands}
      onSlashOpen={() => {
        setPaletteOpen(true);
        // The unfiltered menu claude draws for a bare "/" is the best learning
        // sample there is, and it costs one keystroke nobody sees (§2).
        sendKeys(SLASH);
        learnerRef.current?.start();
      }}
      onSlashPick={(name) => {
        closePalette();
        completeCommand(name);
      }}
      onSlashCancel={() => {
        closePalette();
        sendKeys(KEY_ESC);
      }}
      onSlashPassthrough={(line) => {
        closePalette();
        completeCommand(line);
      }}
    />
  );
}
