/**
 * The chat's input box (chat-view spec §6, chat v3 spec §2).
 *
 * Enter sends the text to the PTY exactly as typed. A multiline send is
 * wrapped in bracketed paste so the TUI on the other end receives it as ONE
 * block rather than a burst of lines it would each treat as a submit — the
 * same thing a real paste does.
 *
 * A "/" typed into an EMPTY box opens TermX's own command palette instead of
 * being sent as text. The palette is drawn from a cached list, so it appears
 * on the keystroke; the overlay above sends the "/" to the hidden claude in
 * parallel, which is what makes the eventual pick executable — and what lets
 * claude's own menu teach the cache while ours is up.
 *
 * The box is never disabled and never muted: in chat mode it always owns the
 * keyboard (v3 §6).
 */

import { useRef, useState } from "react";
import { SlashPalette } from "./SlashPalette";
import { filterCommands, type SlashCommand } from "./slashCommands";

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

/** The one character that means "open the command palette" rather than "type this". */
export const SLASH = "/";

export interface ChatInputProps {
  /** Raw PTY write. */
  sendKeys(data: string): void;
  /** The cached command list the palette draws from. */
  slashCommands: readonly SlashCommand[];
  /** The palette opened: the overlay owes claude a "/". */
  onSlashOpen(): void;
  /** A row was chosen, as the full "/name". */
  onSlashPick(name: string): void;
  /** The palette was abandoned; claude's "/" needs taking back. */
  onSlashCancel(): void;
  /** A full "/cmd args" line was submitted. */
  onSlashPassthrough(line: string): void;
}

/** What goes down the wire for `text` — the Enter follows as its own write. */
export function payloadForMessage(text: string): string {
  return text.includes("\n") ? `${PASTE_START}${text}${PASTE_END}` : text;
}

/**
 * Whether `text` is still choosing a command name. A space means the user is
 * writing arguments, so the list has nothing left to offer and the whole line
 * goes to claude verbatim.
 */
function isChoosingName(text: string): boolean {
  return text.startsWith(SLASH) && !text.includes(" ");
}

export function ChatInput({
  sendKeys,
  slashCommands,
  onSlashOpen,
  onSlashPick,
  onSlashCancel,
  onSlashPassthrough,
}: ChatInputProps) {
  const [text, setText] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  /**
   * Whether claude's own box is holding the "/" we sent. Deliberately NOT the
   * same thing as the palette being visible: typing an argument hides the list
   * while claude still holds the slash, and deleting the argument brings the
   * list back without owing claude a second one.
   */
  const [slashMode, setSlashMode] = useState(false);
  const [selected, setSelected] = useState(0);
  // -1 means "editing, not walking history".
  const cursor = useRef(-1);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  const paletteOpen = slashMode && isChoosingName(text);
  const matches = paletteOpen ? filterCommands(slashCommands, text.slice(1)) : [];

  const clear = () => {
    setSlashMode(false);
    setSelected(0);
    cursor.current = -1;
    setText("");
  };

  const cancelSlash = () => {
    clear();
    onSlashCancel();
  };

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

  /** Enter while claude holds our slash: the overlay completes the command. */
  const submitSlash = () => {
    const chosen = paletteOpen ? matches[selected] : undefined;
    const line = text;
    clear();
    if (chosen) {
      onSlashPick(`${SLASH}${chosen.name}`);
      return;
    }
    // No row matched (or the line has arguments): claude knows its own
    // commands better than the cache does, so send the line as typed.
    onSlashPassthrough(line);
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
    if (slashMode && event.key === "Escape") {
      event.preventDefault();
      cancelSlash();
      return;
    }
    if (paletteOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      // The list owns the arrows while it is up; history is unreachable from
      // a line that starts with a slash anyway.
      event.preventDefault();
      const last = Math.max(0, matches.length - 1);
      setSelected((current) =>
        event.key === "ArrowDown"
          ? Math.min(last, current + 1)
          : Math.max(0, current - 1),
      );
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (slashMode) {
        submitSlash();
      } else {
        send();
      }
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
   * The palette opens from the CHANGE handler so a pasted or IME-composed
   * slash behaves the same as a typed one. Only a lone "/" on an empty box
   * counts: a pasted "/model opus" was never announced to claude, so it stays
   * ordinary text.
   */
  const onChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.currentTarget.value;
    if (!slashMode && text.length === 0 && next === SLASH) {
      setSlashMode(true);
      setSelected(0);
      setText(next);
      onSlashOpen();
      return;
    }
    if (slashMode && (next.length === 0 || !next.startsWith(SLASH))) {
      // Deleted back past the slash: claude is still holding one, so take it
      // back rather than leaving a stray character in its box.
      cancelSlash();
      return;
    }
    cursor.current = -1;
    setSelected(0);
    setText(next);
  };

  return (
    <div className="chat-input" data-testid="chat-input">
      {paletteOpen ? (
        <div className="chat-slash" data-testid="chat-slash">
          <SlashPalette
            commands={matches}
            selectedIndex={selected}
            onPick={(name) => {
              clear();
              onSlashPick(name);
            }}
            onHover={setSelected}
          />
        </div>
      ) : null}
      <textarea
        ref={boxRef}
        className="chat-input__box"
        aria-label="Message the session"
        placeholder="Message the session — Enter to send, Shift+Enter for a new line"
        rows={2}
        value={text}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
