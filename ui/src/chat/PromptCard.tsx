/**
 * An interactive TUI prompt, rendered inside the chat (chat-view spec §5).
 *
 * Every button here corresponds to one deliberate click. Nothing on this card
 * sends anything on its own, and the fallback form — the last dozen lines of
 * the screen plus a free-text box — exists so that even a prompt nobody
 * recognized stays answerable without flipping to the terminal.
 */

import { useState } from "react";
import type { PromptCardState } from "./promptWatcher";

export interface PromptCardProps {
  state: PromptCardState;
  onAnswerMenu(targetIndex: number): void;
  onAnswerConfirm(affirmative: boolean): void;
  onSendText(text: string): void;
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
