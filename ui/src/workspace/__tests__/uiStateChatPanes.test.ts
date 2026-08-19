import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_DENSITY,
  DEFAULT_CHAT_SHOW_THINKING,
  DEFAULT_CHAT_VIEW_MODE,
} from "../../chat/chatDefaults";
import {
  DEFAULT_UI_STATE,
  parseUiState,
  serializeUiState,
  setChatPaneState,
} from "../uiState";

describe("chat pane state in ui-state", () => {
  it("round-trips a pane's mode, density and thinking preference", () => {
    const stored = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "full",
      showThinking: false,
    });
    expect(stored.chatPanes).toEqual({
      7: { mode: "chat", density: "full", showThinking: false },
    });

    const reloaded = parseUiState(serializeUiState(stored));
    expect(reloaded.chatPanes).toEqual({
      7: { mode: "chat", density: "full", showThinking: false },
    });
  });

  it("keeps panes apart", () => {
    let state = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
    });
    state = setChatPaneState(state, "8", {
      mode: "terminal",
      density: "chips",
      showThinking: false,
    });
    expect(state.chatPanes).toEqual({
      7: { mode: "chat", density: "smart", showThinking: true },
      8: { mode: "terminal", density: "chips", showThinking: false },
    });
  });

  it("returns the same state when nothing changed", () => {
    const state = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
    });
    expect(
      setChatPaneState(state, "7", {
        mode: "chat",
        density: "smart",
        showThinking: true,
      }),
    ).toBe(state);
    expect(setChatPaneState(DEFAULT_UI_STATE, "7", null)).toBe(DEFAULT_UI_STATE);
  });

  it("stores a thinking flip on its own", () => {
    const state = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
    });
    const flipped = setChatPaneState(state, "7", {
      mode: "chat",
      density: "smart",
      showThinking: false,
    });
    expect(flipped).not.toBe(state);
    expect(flipped.chatPanes?.["7"]?.showThinking).toBe(false);
  });

  it("drops a pane's entry, and the whole field once the last one goes", () => {
    let state = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
    });
    state = setChatPaneState(state, "8", {
      mode: "chat",
      density: "full",
      showThinking: true,
    });
    state = setChatPaneState(state, "7", null);
    expect(state.chatPanes).toEqual({
      8: { mode: "chat", density: "full", showThinking: true },
    });
    state = setChatPaneState(state, "8", null);
    expect(state.chatPanes).toBeUndefined();
    expect("chatPanes" in state).toBe(false);
  });

  it("degrades junk to the defaults rather than losing the file", () => {
    const parsed = parseUiState(
      JSON.stringify({
        chatPanes: {
          good: { mode: "chat", density: "full", showThinking: false },
          halfGood: { mode: "chat", density: "sideways", showThinking: "yes" },
          empty: { mode: "nonsense", density: 42, showThinking: 1 },
          notAnObject: "chat",
        },
      }),
    );
    expect(parsed.chatPanes).toEqual({
      good: { mode: "chat", density: "full", showThinking: false },
      halfGood: { mode: "chat", density: "smart", showThinking: true },
    });

    for (const junk of ["[]", '{"chatPanes":[]}', '{"chatPanes":null}', "{}"]) {
      expect(parseUiState(junk).chatPanes).toBeUndefined();
    }
  });

  it("defaults a pre-thinking file to thoughts open", () => {
    const parsed = parseUiState(
      JSON.stringify({ chatPanes: { 7: { mode: "chat", density: "full" } } }),
    );
    expect(parsed.chatPanes).toEqual({
      7: { mode: "chat", density: "full", showThinking: true },
    });
  });

  it("leaves the rest of the ui state alone", () => {
    const withWidth = { ...DEFAULT_UI_STATE, sidebarWidth: 300 };
    const state = setChatPaneState(withWidth, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
    });
    expect(state.sidebarWidth).toBe(300);
    expect(setChatPaneState(state, "7", null).sidebarWidth).toBe(300);
  });
});

/**
 * The sticky link (auto-reveal spec §5): the conversation a pane was last
 * known to be running, remembered so the Chat button survives a linkage
 * dropout instead of vanishing from a pane that plainly has a conversation.
 */
describe("chat pane link in ui-state", () => {
  const link = {
    provider: "claude",
    id: "0f4b1c2e-9a77",
    filePath: "C:\\Users\\me\\.claude\\projects\\C--Dev-TermX\\a.jsonl",
    title: "Daemon work",
  } as const;

  it("round-trips a link with the rest of the pane's state", () => {
    const stored = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
      link,
    });

    expect(parseUiState(serializeUiState(stored)).chatPanes).toEqual({
      7: { mode: "chat", density: "smart", showThinking: true, link },
    });
  });

  it("reads a file written before links existed", () => {
    const parsed = parseUiState(
      JSON.stringify({
        chatPanes: { 7: { mode: "chat", density: "full", showThinking: true } },
      }),
    );
    expect(parsed.chatPanes?.["7"]).toEqual({
      mode: "chat",
      density: "full",
      showThinking: true,
    });
    expect("link" in (parsed.chatPanes?.["7"] ?? {})).toBe(false);
  });

  it("drops a malformed link but keeps the pane", () => {
    const parsed = parseUiState(
      JSON.stringify({
        chatPanes: {
          badProvider: { mode: "chat", link: { ...link, provider: "grok" } },
          emptyField: { mode: "chat", link: { ...link, filePath: "" } },
          missingField: { mode: "chat", id: link.id, link: { provider: "claude" } },
          notAnObject: { mode: "chat", link: "claude:abc" },
        },
      }),
    );
    for (const key of ["badProvider", "emptyField", "missingField", "notAnObject"]) {
      expect(parsed.chatPanes?.[key]?.mode).toBe("chat");
      expect(parsed.chatPanes?.[key]?.link).toBeUndefined();
    }
  });

  it("keeps a pane that carries nothing but a link", () => {
    // A link is real content: it is the whole reason the chat button stays.
    const parsed = parseUiState(JSON.stringify({ chatPanes: { 7: { link } } }));
    expect(parsed.chatPanes?.["7"]).toEqual({
      mode: DEFAULT_CHAT_VIEW_MODE,
      density: DEFAULT_CHAT_DENSITY,
      showThinking: DEFAULT_CHAT_SHOW_THINKING,
      link,
    });
  });

  it("stores a link change on its own, and a handoff to another transcript", () => {
    const base = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
    });

    const linked = setChatPaneState(base, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
      link,
    });
    expect(linked).not.toBe(base);
    expect(linked.chatPanes?.["7"]?.link).toEqual(link);

    // §4's handoff: same pane, same settings, a different transcript.
    const successor = { ...link, id: "successor", filePath: "C:\\b.jsonl" };
    const rebound = setChatPaneState(linked, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
      link: successor,
    });
    expect(rebound).not.toBe(linked);
    expect(rebound.chatPanes?.["7"]?.link).toEqual(successor);
  });

  it("returns the same state when the link is unchanged too", () => {
    const state = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
      link,
    });
    expect(
      setChatPaneState(state, "7", {
        mode: "chat",
        density: "smart",
        showThinking: true,
        link: { ...link },
      }),
    ).toBe(state);
  });

  it("notices a link being dropped", () => {
    const state = setChatPaneState(DEFAULT_UI_STATE, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
      link,
    });
    const unlinked = setChatPaneState(state, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
    });
    expect(unlinked).not.toBe(state);
    expect(unlinked.chatPanes?.["7"]?.link).toBeUndefined();
  });

  it("leaves the rest of the ui state alone with a link in play", () => {
    const withWidth = { ...DEFAULT_UI_STATE, sidebarWidth: 300 };
    const state = setChatPaneState(withWidth, "7", {
      mode: "chat",
      density: "smart",
      showThinking: true,
    });
    expect(state.sidebarWidth).toBe(300);
    expect(setChatPaneState(state, "7", null).sidebarWidth).toBe(300);
  });
});
