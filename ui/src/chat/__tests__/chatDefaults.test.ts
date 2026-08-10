import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../settings/settings";
import {
  DEFAULT_CHAT_DENSITY,
  DEFAULT_CHAT_VIEW_MODE,
  defaultChatDensity,
  defaultChatViewMode,
} from "../chatDefaults";

describe("chat defaults from settings", () => {
  it("falls back to the built-in defaults without a settings snapshot", () => {
    expect(defaultChatViewMode()).toBe(DEFAULT_CHAT_VIEW_MODE);
    expect(defaultChatDensity()).toBe(DEFAULT_CHAT_DENSITY);
  });

  it("uses the user's agentPaneDefaultView", () => {
    expect(
      defaultChatViewMode({ ...DEFAULT_SETTINGS, agentPaneDefaultView: "chat" }),
    ).toBe("chat");
  });

  it("uses the user's chatDefaultDensity", () => {
    expect(
      defaultChatDensity({ ...DEFAULT_SETTINGS, chatDefaultDensity: "full" }),
    ).toBe("full");
  });

  it("accepts the full TermxSettings shape as-is", () => {
    expect(defaultChatViewMode(DEFAULT_SETTINGS)).toBe(
      DEFAULT_SETTINGS.agentPaneDefaultView,
    );
    expect(defaultChatDensity(DEFAULT_SETTINGS)).toBe(
      DEFAULT_SETTINGS.chatDefaultDensity,
    );
  });
});
