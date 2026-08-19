/**
 * When does the live terminal show? (chat v2 auto-reveal spec §2)
 *
 * The dock is a window onto the pane's REAL xterm, so this module decides one
 * thing only: whether that window is open, and what opened it. It is pure —
 * timers arrive through `schedule`, the screen through `snapshot` — which is
 * what makes every trigger and every hide path testable without a terminal.
 *
 * Two rules carry most of the behaviour:
 *
 * - A reveal is STICKY. The first cause keeps the reason, because a prompt
 *   arriving inside a slash menu is still the same open dock, and re-reporting
 *   it would make the pane re-render the frame for nothing.
 * - A `manual` reveal only ever closes manually. The user asked for the
 *   terminal; the idle detector does not get to overrule that.
 */

import { isIdleScreen } from "./idleDetector";
import type { ScheduleFn } from "./promptWatcher";

/** How often a revealed dock re-checks whether claude has gone quiet. */
export const AUTO_HIDE_POLL_MS = 500;

export type RevealReason = "slash" | "prompt" | "boot" | "manual";

export interface RevealState {
  readonly revealed: boolean;
  readonly reason: RevealReason | null;
}

export interface RevealControllerOptions {
  /** The pane's visible terminal lines, newest sample each call. */
  snapshot(): string[];
  /** False while the transcript is still producing entries. */
  isTranscriptIdle(): boolean;
  /** Every transition, including the initial boot reveal. */
  onChange(state: RevealState): void;
  /** Injected timer; production uses setTimeout. */
  schedule?: ScheduleFn;
}

export interface RevealController {
  state(): RevealState;
  /** The user typed "/" into the empty chat box. */
  userTypedSlash(): void;
  /** The prompt detector says claude is asking something. */
  notePromptDetected(): void;
  manualToggle(): void;
  manualHide(): void;
  dispose(): void;
}

const defaultSchedule: ScheduleFn = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

const HIDDEN: RevealState = { revealed: false, reason: null };

export function createRevealController(
  options: RevealControllerOptions,
  initial?: { boot?: boolean },
): RevealController {
  const schedule = options.schedule ?? defaultSchedule;
  let state: RevealState = HIDDEN;
  let cancelPoll: (() => void) | null = null;
  let disposed = false;

  const stopPolling = () => {
    cancelPoll?.();
    cancelPoll = null;
  };

  const publish = (next: RevealState) => {
    state = next;
    options.onChange(next);
  };

  /** Both halves of "claude has nothing to say": the feed and the screen. */
  const settled = () =>
    options.isTranscriptIdle() && isIdleScreen(options.snapshot());

  const armPoll = () => {
    if (disposed) {
      return;
    }
    cancelPoll = schedule(() => {
      cancelPoll = null;
      if (state.revealed && state.reason !== "manual" && settled()) {
        publish(HIDDEN);
      }
      if (state.revealed && state.reason !== "manual") {
        armPoll();
      }
    }, AUTO_HIDE_POLL_MS);
  };

  const reveal = (reason: RevealReason) => {
    if (state.revealed) {
      return;
    }
    publish({ revealed: true, reason });
    if (reason !== "manual") {
      armPoll();
    }
  };

  const hide = () => {
    stopPolling();
    if (!state.revealed) {
      return;
    }
    publish(HIDDEN);
  };

  if (initial?.boot === true) {
    reveal("boot");
  }

  return {
    state: () => state,
    userTypedSlash: () => reveal("slash"),
    notePromptDetected: () => reveal("prompt"),
    manualToggle: () => (state.revealed ? hide() : reveal("manual")),
    manualHide: hide,
    dispose() {
      disposed = true;
      stopPolling();
    },
  };
}
