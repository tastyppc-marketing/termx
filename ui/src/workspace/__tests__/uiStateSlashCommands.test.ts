/**
 * The learned slash command cache in ui-state (chat v3 spec §2).
 *
 * This is the only field in the file written by something claude drew rather
 * than by something the user did, which is exactly why the parse is strict
 * about shape and forgiving about content: a junk entry is dropped, a junk
 * file degrades to no cache at all, and the palette falls back on its seeds.
 */

import { describe, expect, it } from "vitest";
import { SEED_COMMANDS } from "../../chat/slashCommands";
import {
  DEFAULT_UI_STATE,
  parseUiState,
  serializeUiState,
  setSlashCommands,
} from "../uiState";

describe("slash commands in ui-state", () => {
  it("round-trips a learned cache", () => {
    const stored = setSlashCommands(DEFAULT_UI_STATE, [
      { name: "model", description: "Set the AI model for this session" },
      { name: "rewind", description: "Rewind the conversation and/or the code" },
    ]);
    expect(parseUiState(serializeUiState(stored)).slashCommands).toEqual([
      { name: "model", description: "Set the AI model for this session" },
      { name: "rewind", description: "Rewind the conversation and/or the code" },
    ]);
    expect(parseUiState(serializeUiState(setSlashCommands(DEFAULT_UI_STATE, SEED_COMMANDS)))
      .slashCommands).toEqual([...SEED_COMMANDS]);
  });

  it("returns the same state when the cache did not change", () => {
    const state = setSlashCommands(DEFAULT_UI_STATE, [
      { name: "model", description: "Set the AI model for this session" },
    ]);
    // A fresh array of fresh objects: every learn rebuilds these, so the
    // comparison has to be field-wise or a save is scheduled every 300 ms.
    expect(
      setSlashCommands(state, [
        { name: "model", description: "Set the AI model for this session" },
      ]),
    ).toBe(state);
    expect(setSlashCommands(DEFAULT_UI_STATE, [])).toBe(DEFAULT_UI_STATE);
  });

  it("stores a changed description and a grown list", () => {
    const state = setSlashCommands(DEFAULT_UI_STATE, [
      { name: "model", description: "old" },
    ]);
    const edited = setSlashCommands(state, [{ name: "model", description: "new" }]);
    expect(edited).not.toBe(state);
    expect(edited.slashCommands).toEqual([{ name: "model", description: "new" }]);

    const grown = setSlashCommands(edited, [
      { name: "model", description: "new" },
      { name: "vim", description: "Toggle Vim mode" },
    ]);
    expect(grown.slashCommands).toHaveLength(2);
  });

  it("drops the field on an empty cache, keeping unrelated fields", () => {
    const withWidth = { ...DEFAULT_UI_STATE, sidebarWidth: 300 };
    const state = setSlashCommands(
      setSlashCommands(withWidth, [{ name: "model", description: "Set the AI model" }]),
      [],
    );
    expect(state.slashCommands).toBeUndefined();
    expect("slashCommands" in state).toBe(false);
    expect(state.sidebarWidth).toBe(300);
  });

  it("degrades junk entries instead of failing the parse", () => {
    const parsed = parseUiState(
      JSON.stringify({
        slashCommands: [
          { name: "model", description: "Set the AI model" },
          { name: "quiet", description: "" },
          { name: "", description: "no name" },
          { name: "/model", description: "carries its own slash" },
          { name: "usr/local", description: "not a command name" },
          { name: 7, description: "not a string" },
          { name: "nodesc" },
          "not an object",
          null,
        ],
      }),
    );
    // A stored name becomes "/name" in the palette and then a keystroke into a
    // live session, so anything carrying a slash of its own is dropped rather
    // than repaired. An empty description is just a menu row claude drew thin.
    expect(parsed.slashCommands).toEqual([
      { name: "model", description: "Set the AI model" },
      { name: "quiet", description: "" },
    ]);
  });

  it("ignores a field that is not a list of commands", () => {
    expect(parseUiState(JSON.stringify({ slashCommands: {} })).slashCommands)
      .toBeUndefined();
    expect(parseUiState(JSON.stringify({ slashCommands: 7 })).slashCommands)
      .toBeUndefined();
    expect(parseUiState(JSON.stringify({ slashCommands: [] })).slashCommands)
      .toBeUndefined();
    expect(parseUiState(JSON.stringify({ slashCommands: [{ name: "" }] })).slashCommands)
      .toBeUndefined();
  });
});
