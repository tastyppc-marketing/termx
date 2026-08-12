/**
 * The prompt card's controller (chat-view spec §5).
 *
 * It watches the pane's visible terminal lines, and when the screen has
 * STOPPED changing and the transcript has nothing new to say, it asks the
 * detector what is on it. Two signals, both required: a moving screen is an
 * agent working, and a moving transcript is an agent talking — neither is a
 * question waiting for an answer.
 *
 * **It never answers anything.** `sendKeys` is reached only from `answerMenu`,
 * `answerConfirm` and `sendText`, each of which is a user action. The watching
 * half of this module has no path to it at all.
 *
 * After an answer is sent the card waits ~800 ms and looks again: the prompt
 * gone means it worked, the same prompt still there earns exactly one
 * re-derived retry, and a prompt that survives that degrades to the fallback
 * card so the user is never stuck arguing with a button.
 */

import { ENTER_DELAY_MS, ENTER_KEY } from "./ChatInput";
import { detectPrompt, keysForMenuAnswer, type DetectedPrompt } from "./promptDetector";

/** How often the screen is sampled; also the debounce, since a card needs two
 *  identical samples before it appears. */
export const DETECT_INTERVAL_MS = 300;

/** Spec §5: how long an answer is given before it is re-derived and retried. */
export const PROMPT_RETRY_MS = 800;

/** A one-shot timer returning its own canceller; injected for tests. */
export type ScheduleFn = (callback: () => void, delayMs: number) => () => void;

export interface PromptCardState {
  prompt: DetectedPrompt | null;
  status: "asking" | "answering" | "answered";
  /** What the user chose, for the collapsed chip. */
  answeredLabel: string;
}

export interface PromptControllerOptions {
  /** The pane's visible terminal lines, newest sample each call. */
  snapshot(): string[];
  /** Raw PTY write. */
  sendKeys(data: string): void;
  /** False while the transcript is still producing entries. */
  isIdle(): boolean;
  /** Called whenever `state()` would return something new. */
  onChange(): void;
  schedule?: ScheduleFn;
}

export interface PromptController {
  state(): PromptCardState;
  answerMenu(targetIndex: number): void;
  answerConfirm(affirmative: boolean): void;
  sendText(text: string): void;
  /** Drop the card without sending anything. */
  dismiss(): void;
  dispose(): void;
}

const defaultSchedule: ScheduleFn = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

const IDLE_STATE: PromptCardState = {
  prompt: null,
  status: "asking",
  answeredLabel: "",
};

function sameLines(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((line, index) => line === right[index])
  );
}

/** Two detections describe the same screen when their raw tails match. */
function samePrompt(left: DetectedPrompt | null, right: DetectedPrompt | null): boolean {
  if (!left || !right) {
    return false;
  }
  return left.kind === right.kind && sameLines(left.raw, right.raw);
}

export function createPromptController(
  options: PromptControllerOptions,
): PromptController {
  const schedule = options.schedule ?? defaultSchedule;
  let state: PromptCardState = IDLE_STATE;
  let previousSample: string[] = [];
  let target = 0;
  let retried = false;
  let disposed = false;
  let cancelWatch: (() => void) | null = null;
  let cancelRetry: (() => void) | null = null;

  /** Same card in the same phase: nothing for the view to redraw. */
  const publish = (next: PromptCardState) => {
    const sameCard =
      (next.prompt === null && state.prompt === null) ||
      samePrompt(next.prompt, state.prompt);
    if (
      sameCard &&
      next.status === state.status &&
      next.answeredLabel === state.answeredLabel
    ) {
      return;
    }
    state = next;
    options.onChange();
  };

  const armWatch = () => {
    if (disposed) {
      return;
    }
    cancelWatch = schedule(() => {
      cancelWatch = null;
      watch();
      armWatch();
    }, DETECT_INTERVAL_MS);
  };

  const watch = () => {
    const sample = options.snapshot();
    const settled = sameLines(sample, previousSample);
    previousSample = sample;
    if (state.status === "answering") {
      return; // the retry timer owns this phase
    }
    if (!settled || !options.isIdle()) {
      return;
    }
    const detected = detectPrompt(sample);
    if (detected === null) {
      if (state.status === "asking" && state.prompt !== null) {
        publish(IDLE_STATE);
      }
      return;
    }
    if (samePrompt(detected, state.prompt)) {
      return;
    }
    publish({ prompt: detected, status: "asking", answeredLabel: "" });
  };

  const armRetry = () => {
    cancelRetry = schedule(() => {
      cancelRetry = null;
      settle();
    }, PROMPT_RETRY_MS);
  };

  /** Did the answer take? Look at the screen and decide. */
  const settle = () => {
    const sample = options.snapshot();
    previousSample = sample;
    const again = detectPrompt(sample);
    if (!samePrompt(again, state.prompt)) {
      publish({ prompt: null, status: "answered", answeredLabel: state.answeredLabel });
      return;
    }
    if (!retried && again) {
      retried = true;
      // Re-derive from what is on screen NOW: the selector may have moved even
      // though the dialog did not close.
      if (again.kind === "menu") {
        sendSplittingEnter(keysForMenuAnswer(again, target));
      }
      state = { ...state, prompt: again };
      armRetry();
      return;
    }
    publish({
      prompt: again ? { kind: "unknown", raw: again.raw } : null,
      status: "asking",
      answeredLabel: "",
    });
  };

  /**
   * Write `keys`, but a trailing Enter goes as its own write a beat later —
   * a TUI that gets "answer\r" in one chunk reads it as a paste and does not
   * submit (see `ENTER_DELAY_MS`).
   */
  const sendSplittingEnter = (keys: string) => {
    const body = keys.endsWith(ENTER_KEY) ? keys.slice(0, -1) : keys;
    if (body.length > 0) {
      options.sendKeys(body);
    }
    if (body.length === keys.length) {
      return;
    }
    schedule(() => options.sendKeys(ENTER_KEY), ENTER_DELAY_MS);
  };

  const beginAnswer = (label: string, keys: string) => {
    if (state.prompt === null || state.status === "answering") {
      return;
    }
    sendSplittingEnter(keys);
    retried = false;
    publish({ prompt: state.prompt, status: "answering", answeredLabel: label });
    armRetry();
  };

  armWatch();

  return {
    state: () => state,
    answerMenu(targetIndex) {
      const prompt = state.prompt;
      if (prompt?.kind !== "menu") {
        return;
      }
      target = targetIndex;
      beginAnswer(
        prompt.options[targetIndex]?.label ?? "",
        keysForMenuAnswer(prompt, targetIndex),
      );
    },
    answerConfirm(affirmative) {
      if (state.prompt?.kind !== "confirm") {
        return;
      }
      beginAnswer(affirmative ? "Yes" : "No", `${affirmative ? "y" : "n"}\r`);
    },
    sendText(text) {
      if (text.length === 0) {
        return;
      }
      sendSplittingEnter(`${text}${ENTER_KEY}`);
      publish({ prompt: null, status: "answered", answeredLabel: text });
    },
    dismiss() {
      cancelRetry?.();
      cancelRetry = null;
      publish(IDLE_STATE);
    },
    dispose() {
      disposed = true;
      cancelWatch?.();
      cancelWatch = null;
      cancelRetry?.();
      cancelRetry = null;
    },
  };
}
