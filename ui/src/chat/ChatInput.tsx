/**
 * The chat's input box (chat-view spec §6).
 *
 * Enter sends the text to the PTY exactly as typed. A multiline send is
 * wrapped in bracketed paste so the TUI on the other end receives it as ONE
 * block rather than a burst of lines it would each treat as a submit — the
 * same thing a real paste does.
 *
 * The box stays enabled while a prompt card is waiting: a card the detector
 * misread is answered by typing, and disabling the only escape hatch is how a
 * user gets stuck. It just says where to look.
 */

import { useRef, useState } from "react";

/** Spec §6: input history is per pane, capped, and not persisted. */
export const HISTORY_CAP = 50;

/** Bracketed paste, as a terminal expects it. */
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/**
 * Enter is ALWAYS its own write, a beat after the text. A TUI that receives
 * "text\r" as one chunk reads it as a paste — the \r becomes a newline in the
 * input box and nothing submits. Two writes with a gap is what real typing
 * looks like, and it is the same trick tmux's send-keys uses.
 */
export const ENTER_KEY = "\r";
export const ENTER_DELAY_MS = 40;

export interface ChatInputProps {
  /** Raw PTY write. */
  sendKeys(data: string): void;
  /** A prompt card is on screen waiting for an answer. */
  promptActive?: boolean;
}

/** What goes down the wire for `text` — the Enter follows as its own write. */
export function payloadForMessage(text: string): string {
  return text.includes("\n") ? `${PASTE_START}${text}${PASTE_END}` : text;
}

export function ChatInput({ sendKeys, promptActive = false }: ChatInputProps) {
  const [text, setText] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  // -1 means "editing, not walking history".
  const cursor = useRef(-1);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  const send = () => {
    const message = text.trim().length === 0 ? "" : text;
    if (message.length === 0) {
      return;
    }
    sendKeys(payloadForMessage(message));
    window.setTimeout(() => sendKeys(ENTER_KEY), ENTER_DELAY_MS);
    setHistory((current) => [message, ...current].slice(0, HISTORY_CAP));
    cursor.current = -1;
    setText("");
  };

  const walk = (delta: number) => {
    const next = cursor.current + delta;
    if (next < -1 || next >= history.length) {
      return;
    }
    cursor.current = next;
    setText(next === -1 ? "" : (history[next] ?? ""));
    // Recalling a message puts the caret after it, the way a shell does — and
    // it is what makes the next Down key mean "forward" rather than "move".
    queueMicrotask(() => {
      const box = boxRef.current;
      if (box) {
        box.selectionStart = box.value.length;
        box.selectionEnd = box.value.length;
      }
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
      return;
    }
    const box = boxRef.current;
    const caret = box?.selectionStart ?? 0;
    if (event.key === "ArrowUp" && caret === 0) {
      event.preventDefault();
      walk(1);
      return;
    }
    // While a recalled message is showing, Down always means "forward"; on a
    // message being typed it only does so from the very end.
    if (event.key === "ArrowDown" && (cursor.current >= 0 || caret === text.length)) {
      event.preventDefault();
      walk(-1);
    }
  };

  return (
    <div className="chat-input" data-testid="chat-input">
      {promptActive ? (
        <p className="chat-input__hint" role="note">
          The session is waiting on the card above — answer it there, or type
          here if it read the screen wrong.
        </p>
      ) : null}
      <textarea
        ref={boxRef}
        className="chat-input__box"
        aria-label="Message the session"
        placeholder="Message the session — Enter to send, Shift+Enter for a new line"
        rows={2}
        value={text}
        onChange={(event) => {
          cursor.current = -1;
          setText(event.currentTarget.value);
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
