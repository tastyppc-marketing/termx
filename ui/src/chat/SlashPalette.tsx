// LANE-B STUB — replaced at merge; lane A must not commit changes beyond the frozen contract
/**
 * Bare list stand-in for lane B's palette. Lane A's tests never reach into
 * this DOM — they drive the palette through ChatInput's keyboard and assert on
 * ChatInput's own wrapper — so replacing it at merge changes nothing here.
 */

import type { SlashCommand } from "./slashCommands";

export interface SlashPaletteProps {
  commands: readonly SlashCommand[];
  selectedIndex: number;
  onPick(name: string): void;
  onHover(index: number): void;
}

export function SlashPalette({
  commands,
  selectedIndex,
  onPick,
  onHover,
}: SlashPaletteProps) {
  if (commands.length === 0) {
    return <div className="slash-palette">No matching commands</div>;
  }
  return (
    <div className="slash-palette" role="listbox">
      {commands.map((command, index) => (
        <button
          key={command.name}
          type="button"
          role="option"
          className="slash-palette__row"
          aria-current={index === selectedIndex ? "true" : undefined}
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
