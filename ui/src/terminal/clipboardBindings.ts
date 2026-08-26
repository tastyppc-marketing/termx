/**
 * Clipboard routes for a terminal pane.
 *
 * TermX copies and pastes for itself, because the webview will not. Verified
 * live over CDP (2026-08-23): with the helper textarea focused and editable, a
 * native Ctrl+V fires NO `paste` event and NO `input` event on it — WebView2
 * never delivers the paste command to the page, so xterm's own paste handler
 * can never run. `navigator.clipboard.readText()` does work (permission
 * "granted"), so the clipboard is readable; only the keystroke was missing.
 *
 * Kept out of `createPresentation` so the wiring is reachable from a test
 * without standing up a real xterm against a real webview.
 */

/** The slice of xterm's Terminal these bindings touch. */
export interface ClipboardTerminal {
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  clearSelection(): void;
  getSelection(): string;
  hasSelection(): boolean;
  /** Raw bytes into the pty as if typed — bypasses bracketed paste. */
  input(data: string): void;
  paste(text: string): void;
}

/** The slice of `navigator.clipboard` these bindings touch. */
export interface ClipboardBridge {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

/**
 * Text injected without keystrokes — Windows voice typing, IME replacement,
 * autocorrect, a drop — arrives as an `input` event. xterm forwards only
 * `insertText` and drops the rest on the floor, which is why dictation went
 * nowhere. These are exactly the kinds it ignores; `insertText` is deliberately
 * absent so nothing is ever sent twice.
 */
export const INJECTED_INPUT_TYPES: ReadonlySet<string> = new Set([
  "insertReplacementText",
  "insertFromPaste",
  "insertFromDrop",
  "insertFromYank",
]);

export function attachClipboardBindings(
  terminal: ClipboardTerminal,
  element: HTMLElement,
  clipboard: ClipboardBridge | undefined = navigator.clipboard,
): () => void {
  // Copy is a first-class terminal action (Warp / Windows Terminal manners):
  // Ctrl+Shift+C always copies the selection, and plain Ctrl+C copies when a
  // selection is active INSTEAD of interrupting — with nothing selected it
  // stays the interrupt it has always been. xterm's selection is not DOM
  // selection, so without this there is no way to copy at all.
  const copySelection = (): boolean => {
    const text = terminal.getSelection();
    if (text.length === 0) {
      return false;
    }
    void clipboard?.writeText?.(text)?.catch(() => undefined);
    terminal.clearSelection();
    return true;
  };

  // `terminal.paste` rather than a raw write: it honours bracketed-paste mode,
  // and without that a multi-line paste would EXECUTE every line in a shell
  // instead of arriving as text.
  //
  // No text does NOT mean nothing to paste: a screenshot or a copied image
  // file is invisible to the webview's clipboard, but the app in the pty can
  // read the OS clipboard itself — Claude Code ingests both forms the moment
  // it sees Ctrl+V. So an empty (or unreadable) clipboard forwards the paste
  // key instead of swallowing it; to a shell with no image handling a lone
  // ^V is inert, which is also what the empty clipboard deserved.
  const pasteFromClipboard = (): void => {
    const forwardPasteKey = () => terminal.input("\x16");
    void clipboard?.readText?.()?.then(
      (text) => {
        if (text) {
          terminal.paste(text);
        } else {
          forwardPasteKey();
        }
      },
      forwardPasteKey,
    );
  };

  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown" || event.altKey || event.metaKey) {
      return true;
    }
    // Ctrl+V and Ctrl+Shift+V, plus Shift+Insert — the three paste chords a
    // Windows terminal is expected to answer.
    if (
      (event.ctrlKey && event.key.toLowerCase() === "v") ||
      (event.shiftKey && !event.ctrlKey && event.key === "Insert")
    ) {
      pasteFromClipboard();
      event.preventDefault();
      return false;
    }
    if (!event.ctrlKey || event.key.toLowerCase() !== "c") {
      return true;
    }
    if (!copySelection()) {
      return true;
    }
    event.preventDefault();
    return false;
  });

  // Right-click copies a selection and otherwise pastes — Windows Terminal's
  // manners. The webview draws no native menu of its own, so without this the
  // mouse has no clipboard route at all.
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    if (terminal.hasSelection()) {
      copySelection();
      return;
    }
    pasteFromClipboard();
  };
  element.addEventListener("contextmenu", onContextMenu);

  const helperTextarea = element.querySelector<HTMLTextAreaElement>(
    ".xterm-helper-textarea",
  );
  const onInjectedInput = (event: Event) => {
    const input = event as InputEvent;
    if (input.isComposing || !input.data) {
      return; // a live composition belongs to xterm's own IME helper
    }
    if (!INJECTED_INPUT_TYPES.has(input.inputType)) {
      return;
    }
    terminal.paste(input.data);
    if (helperTextarea) {
      helperTextarea.value = "";
    }
  };
  helperTextarea?.addEventListener("input", onInjectedInput);

  return () => {
    element.removeEventListener("contextmenu", onContextMenu);
    helperTextarea?.removeEventListener("input", onInjectedInput);
  };
}
