/**
 * An interactive TUI prompt, rendered inside the chat (chat v3 spec §3).
 *
 * Every button here corresponds to one deliberate click. Nothing on this card
 * sends anything on its own, and the fallback form combines all three escape
 * hatches in one place — the last dozen lines of the screen, a free-text box
 * AND a row of raw keys — so that even a prompt nobody recognized stays
 * answerable without ever showing the terminal.
 */

import { useState } from "react";
import { KEY_DOWN, KEY_ENTER, KEY_UP } from "./promptDetector";
import type { PromptCardState } from "./promptWatcher";

/** Cancel, as the TUI on the far side reads it. */
export const KEY_ESC = "\x1b";

/** The raw keys the fallback card offers, in the order they are drawn. */
const KEY_ROW: readonly { label: string; data: string }[] = [
  { label: "↑", data: KEY_UP },
  { label: "↓", data: KEY_DOWN },
  { label: "Enter", data: KEY_ENTER },
  { label: "Esc", data: KEY_ESC },
];

export interface PromptCardProps {
  state: PromptCardState;
  onAnswerMenu(targetIndex: number): void;
  onAnswerConfirm(affirmative: boolean): void;
  onSendText(text: string): void;
  /** One raw keypress, exactly as clicked. */
  onSendKey(data: string): void;
  onOpenTerminal(): void;
}

function FreeText({ onSend }: { onSend(text: string): void }) {
  const [text, setText] = useState("");
  return (
    <input
      className="chat-card__input"
      aria-label="Send keystrokes to the session"
      placeholder="Type a reply and press Enter"
      value={text}
      onChange={(event) => setText(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onSend(text);
          setText("");
        }
      }}
    />
  );
}

export function PromptCard({
  state,
  onAnswerMenu,
  onAnswerConfirm,
  onSendText,
  onSendKey,
  onOpenTerminal,
}: PromptCardProps) {
  if (state.status === "answered") {
    return (
      <div className="chat-card chat-card--answered" data-testid="prompt-answered" role="note">
        Answered: {state.answeredLabel}
      </div>
    );
  }
  const prompt = state.prompt;
  if (!prompt) {
    return null;
  }
  const busy = state.status === "answering";

  return (
    <div className="chat-card" data-testid="prompt-card" data-kind={prompt.kind}>
      {prompt.kind === "menu" ? (
        <>
          <p className="chat-card__question">{prompt.question}</p>
          <div className="chat-card__options">
            {prompt.options.map((option) => (
              <button
                key={option.index}
                type="button"
                className="chat-card__option"
                disabled={busy}
                aria-current={option.index === prompt.selectedIndex}
                onClick={() => onAnswerMenu(option.index)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {prompt.kind === "confirm" ? (
        <>
          <p className="chat-card__question">{prompt.question}</p>
          <div className="chat-card__options">
            <button
              type="button"
              className="chat-card__option"
              disabled={busy}
              onClick={() => onAnswerConfirm(true)}
            >
              Yes
            </button>
            <button
              type="button"
              className="chat-card__option"
              disabled={busy}
              onClick={() => onAnswerConfirm(false)}
            >
              No
            </button>
          </div>
        </>
      ) : null}

      {prompt.kind === "unknown" ? (
        <>
          <p className="chat-card__question">
            The session is waiting for something this view could not read.
          </p>
          <pre className="chat-card__screen" data-testid="prompt-screen">
            {prompt.raw.join("\n")}
          </pre>
          <FreeText onSend={onSendText} />
          <div className="chat-card__keys" role="group" aria-label="Send a keypress">
            {KEY_ROW.map(({ label, data }) => (
              <button
                key={label}
                type="button"
                className="chat-card__option"
                title={`Send ${label} to the session`}
                onClick={() => onSendKey(data)}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className="chat-card__footer">
        {busy ? <span className="chat-card__busy">Sending…</span> : null}
        <button type="button" className="chat-card__link" onClick={onOpenTerminal}>
          Open terminal
        </button>
      </div>
    </div>
  );
}
