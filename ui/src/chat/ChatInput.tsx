/**
 * The chat's input box (chat-view spec §6).
 *
 * Enter sends the text to the PTY exactly as typed. A multiline send is
 * wrapped in bracketed paste so the TUI on the other end receives it as ONE
 * block rather than a burst of lines it would each treat as a submit — the
 * same thing a real paste does.
 *
 * A "/" typed into an EMPTY box is not text: it is a request for claude's own
 * command menu, so it goes straight to the PTY and the live terminal opens
 * under the chat. The box never shows the character (spec §3).
 *
 * The box stays enabled while the live terminal has the keyboard — it only
 * mutes. Disabling the one escape hatch is how a user gets stuck.
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

/** The one character that means "open claude's menu" rather than "type this". */
export const SLASH = "/";

export interface ChatInputProps {
  /** Raw PTY write. */
  sendKeys(data: string): void;
  /** The user opened the command menu; absent leaves "/" as ordinary text. */
  onSlash?: () => void;
  /** The live terminal has the keyboard: the box dims but stays usable. */
  muted?: boolean;
}

/** What goes down the wire for `text` — the Enter follows as its own write. */
export function payloadForMessage(text: string): string {
  return text.includes("\n") ? `${PASTE_START}${text}${PASTE_END}` : text;
}

export function ChatInput({ sendKeys, onSlash, muted = false }: ChatInputProps) {
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

  /**
   * A lone "/" on an empty box belongs to claude, not to this box. It is
   * caught in the CHANGE handler so a pasted or IME-composed slash behaves the
   * same as a typed one — and the DOM value is cleared by hand, because the
   * controlled value is already "" and React would therefore not re-render to
   * take the character back off the screen.
   */
  const onChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.currentTarget.value;
    if (onSlash && text.length === 0 && next === SLASH) {
      event.currentTarget.value = "";
      onSlash();
      return;
    }
    cursor.current = -1;
    setText(next);
  };

  return (
    <div
      className={`chat-input${muted ? " chat-input--muted" : ""}`}
      data-testid="chat-input"
    >
      <textarea
        ref={boxRef}
        className="chat-input__box"
        aria-label="Message the session"
        placeholder="Message the session — Enter to send, Shift+Enter for a new line"
        rows={2}
        value={text}
        {...(muted ? { "aria-disabled": true } : {})}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
