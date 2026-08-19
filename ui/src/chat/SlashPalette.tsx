/**
 * The slash command palette (chat v3 spec §2).
 *
 * Pure presentation: it is handed a list that is ALREADY filtered and a
 * selected index, and it reports clicks and hovers back. It holds no state, it
 * cannot open or close itself, and it never sends a keystroke — the input box
 * owns the palette's whole state machine, and the overlay owns the PTY.
 */

import { useEffect, useRef } from "react";
import type { SlashCommand } from "./slashCommands";
import "./SlashPalette.css";

export interface SlashPaletteProps {
  /** Already filtered and ranked; drawn in exactly this order. */
  commands: readonly SlashCommand[];
  selectedIndex: number;
  /** The full command, leading slash included. */
  onPick(name: string): void;
  onHover(index: number): void;
}

export function SlashPalette({
  commands,
  selectedIndex,
  onPick,
  onHover,
}: SlashPaletteProps) {
  const selectedRow = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Optional call: jsdom has no scrollIntoView, and a palette short enough
    // not to scroll is still a working palette.
    selectedRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex, commands]);

  if (commands.length === 0) {
    return (
      <div className="slash-palette" data-testid="slash-palette">
        <p className="slash-palette__empty">No matching commands</p>
      </div>
    );
  }

  return (
    <div className="slash-palette" data-testid="slash-palette">
      {commands.map((command, index) => (
        <button
          key={command.name}
          type="button"
          className="slash-palette__row"
          ref={index === selectedIndex ? selectedRow : null}
          aria-current={index === selectedIndex}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(`/${command.name}`)}
        >
          <span className="slash-palette__name">/{command.name}</span>
          <span className="slash-palette__description">{command.description}</span>
        </button>
      ))}
    </div>
  );
}
