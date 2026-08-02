/**
 * Full-screen Conversations surface (polish P5). A window-covering overlay
 * with a slim header and whatever the App puts inside it — normally
 * `<ConversationsRail variant="expanded" …/>`.
 *
 * Deliberately dumb: it knows nothing about the conversations store and
 * imports no rail, so the App keeps sole ownership of the wiring and this
 * component stays a layout shell. It is a layer, not a route: the App renders
 * it ALONGSIDE `.app-main` (never instead of it), so terminals underneath stay
 * mounted and running exactly like hidden tabs.
 */

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import "./ConversationsFullscreen.css";

export interface ConversationsFullscreenProps {
  /** The surface's body — the App supplies the expanded rail. */
  children: ReactNode;
  /** Esc or the restore control. Never called after unmount. */
  onClose(): void;
}

export function ConversationsFullscreen({
  children,
  onClose,
}: ConversationsFullscreenProps) {
  const rootRef = useRef<HTMLElement | null>(null);

  // Taking focus on mount both makes Esc work immediately and gives the
  // keydown guard below something inside the overlay to match on.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      // Scoped, never a global hotkey: the listener exists only while the
      // overlay is mounted, and even then Esc closes only when focus is
      // inside it — a dialog or palette layered on top keeps its own Escape.
      const root = rootRef.current;
      if (!root || !root.contains(document.activeElement)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  return (
    <section
      ref={rootRef}
      className="conversations-fullscreen"
      aria-label="Conversations full screen"
      tabIndex={-1}
    >
      <header className="conversations-fullscreen__header">
        <h2 className="conversations-fullscreen__title">Conversations</h2>
        <span className="conversations-fullscreen__hint">Esc</span>
        <button
          type="button"
          className="conversations-fullscreen__restore"
          aria-label="Exit full screen"
          title="Exit full screen (Esc)"
          onClick={onClose}
        >
          ⛶
        </button>
      </header>
      <div className="conversations-fullscreen__body">{children}</div>
    </section>
  );
}
