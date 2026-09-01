import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  parseSettings,
  serializeSettings,
  type TermxSettings,
} from "../settings";
import { SettingsStore, loadSettingsStore } from "../SettingsStore";

/**
 * One legal value per field that differs from its default. Used by the
 * equality-check regression suite below: every field must survive a
 * change-of-one-field update (the maxGroupDepth-swallow bug class).
 */
const ALTERNATE_SETTINGS: TermxSettings = {
  newTabPolicy: "ask-native",
  shellIntegration: false,
  defaultProfile: "cmd",
  conversationsRail: false,
  conversationsPalette: false,
  summaryEngine: "llm",
  summaryContent: "none",
  summaryDisplay: "under-title",
  sleepHiddenTerminals: "60",
  onWindowClose: "stop-all",
  maxGroupDepth: 5,
  syncWindowRenameToTab: true,
  theme: "paper-light",
  agentPaneDefaultView: "chat",
  chatDefaultDensity: "full",
  savedPaneButton: false,
  savedSidebarList: false,
  savedConversationsRail: true,
  sshHostsSidebar: false,
  sshHostsMenu: false,
  sshPasswordPolicy: "never",
  sshEncryptPasswords: false,
  terminalFontSize: 18,
};

describe("parseSettings", () => {
  it("returns defaults for a missing file", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns defaults for malformed JSON without throwing", () => {
    expect(parseSettings("{not json")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("42")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("null")).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips a full settings object", () => {
    const settings = {
      newTabPolicy: "ask-searcher",
      shellIntegration: false,
      defaultProfile: "cmd",
      conversationsRail: false,
      conversationsPalette: false,
      summaryEngine: "llm",
      summaryContent: "both",
      summaryDisplay: "under-title",
      sleepHiddenTerminals: "60",
      onWindowClose: "stop-all",
      maxGroupDepth: 5,
      syncWindowRenameToTab: true,
      theme: "paper-light",
      agentPaneDefaultView: "chat",
      chatDefaultDensity: "chips",
      savedPaneButton: false,
      savedSidebarList: false,
      savedConversationsRail: true,
      sshHostsSidebar: false,
      sshHostsMenu: false,
      sshPasswordPolicy: "never",
      sshEncryptPasswords: false,
      terminalFontSize: 18,
    } as const;
    expect(parseSettings(serializeSettings(settings))).toEqual(settings);
  });

  it("recovers per-field: bad fields default, good fields survive", () => {
    const parsed = parseSettings(
      JSON.stringify({
        newTabPolicy: "chaos-mode",
        shellIntegration: "yes",
        defaultProfile: "cmd",
        conversationsRail: "nope",
        conversationsPalette: 1,
        summaryEngine: "chatgpt",
        summaryContent: "everything",
        summaryDisplay: "sidebar",
        sleepHiddenTerminals: "30",
        onWindowClose: "explode",
        maxGroupDepth: 7,
        syncWindowRenameToTab: "sometimes",
        theme: "neon",
        agentPaneDefaultView: "bubble",
        chatDefaultDensity: 7,
        savedPaneButton: "on",
        savedSidebarList: 1,
        savedConversationsRail: null,
        sshHostsSidebar: "yes",
        sshHostsMenu: 1,
        sshPasswordPolicy: "sometimes",
        sshEncryptPasswords: "dpapi",
        terminalFontSize: "big",
      }),
    );
    expect(parsed).toEqual({
      newTabPolicy: DEFAULT_SETTINGS.newTabPolicy,
      shellIntegration: DEFAULT_SETTINGS.shellIntegration,
      defaultProfile: "cmd",
      conversationsRail: DEFAULT_SETTINGS.conversationsRail,
      conversationsPalette: DEFAULT_SETTINGS.conversationsPalette,
      summaryEngine: DEFAULT_SETTINGS.summaryEngine,
      summaryContent: DEFAULT_SETTINGS.summaryContent,
      summaryDisplay: DEFAULT_SETTINGS.summaryDisplay,
      sleepHiddenTerminals: DEFAULT_SETTINGS.sleepHiddenTerminals,
      onWindowClose: DEFAULT_SETTINGS.onWindowClose,
      maxGroupDepth: DEFAULT_SETTINGS.maxGroupDepth,
      syncWindowRenameToTab: DEFAULT_SETTINGS.syncWindowRenameToTab,
      theme: DEFAULT_SETTINGS.theme,
      agentPaneDefaultView: DEFAULT_SETTINGS.agentPaneDefaultView,
      chatDefaultDensity: DEFAULT_SETTINGS.chatDefaultDensity,
      savedPaneButton: DEFAULT_SETTINGS.savedPaneButton,
      savedSidebarList: DEFAULT_SETTINGS.savedSidebarList,
      savedConversationsRail: DEFAULT_SETTINGS.savedConversationsRail,
      sshHostsSidebar: DEFAULT_SETTINGS.sshHostsSidebar,
      sshHostsMenu: DEFAULT_SETTINGS.sshHostsMenu,
      sshPasswordPolicy: DEFAULT_SETTINGS.sshPasswordPolicy,
      sshEncryptPasswords: DEFAULT_SETTINGS.sshEncryptPasswords,
      terminalFontSize: DEFAULT_SETTINGS.terminalFontSize,
    });
  });

  it("terminalFontSize: defaults to 14, rounds, and clamps to 8-32", () => {
    expect(DEFAULT_SETTINGS.terminalFontSize).toBe(14);
    expect(parseSettings(JSON.stringify({}))).toMatchObject({ terminalFontSize: 14 });
    for (const bad of ["16", null, true, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        parseSettings(JSON.stringify({ terminalFontSize: bad, defaultProfile: "cmd" })),
      ).toMatchObject({ terminalFontSize: 14, defaultProfile: "cmd" });
    }
    expect(parseSettings(JSON.stringify({ terminalFontSize: 20 })).terminalFontSize).toBe(20);
    expect(parseSettings(JSON.stringify({ terminalFontSize: 15.6 })).terminalFontSize).toBe(16);
    expect(parseSettings(JSON.stringify({ terminalFontSize: 2 })).terminalFontSize).toBe(8);
    expect(parseSettings(JSON.stringify({ terminalFontSize: 90 })).terminalFontSize).toBe(32);
  });

  it("theme: defaults to gunmetal-brass and rejects unknown ids", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("gunmetal-brass");
    expect(parseSettings(JSON.stringify({})).theme).toBe("gunmetal-brass");
    for (const bad of ["neon", "", 3, null, true, {}]) {
      expect(parseSettings(JSON.stringify({ theme: bad, defaultProfile: "cmd" })))
        .toMatchObject({ theme: "gunmetal-brass", defaultProfile: "cmd" });
    }
    expect(parseSettings(JSON.stringify({ theme: "paper-light" })).theme)
      .toBe("paper-light");
  });

  it("maxGroupDepth: defaults to 3 and rejects anything off the ladder", () => {
    expect(DEFAULT_SETTINGS.maxGroupDepth).toBe(3);
    expect(parseSettings(JSON.stringify({}))).toMatchObject({ maxGroupDepth: 3 });
    for (const bad of [7, 0, -1, 2.5, "deep", null, true]) {
      expect(parseSettings(JSON.stringify({ maxGroupDepth: bad, defaultProfile: "cmd" })))
        .toMatchObject({ maxGroupDepth: 3, defaultProfile: "cmd" });
    }
    expect(parseSettings(JSON.stringify({ maxGroupDepth: 1 })).maxGroupDepth).toBe(1);
    expect(parseSettings(JSON.stringify({ maxGroupDepth: 5 })).maxGroupDepth).toBe(5);
  });

  it("agentPaneDefaultView: defaults to terminal and rejects unknown views", () => {
    expect(DEFAULT_SETTINGS.agentPaneDefaultView).toBe("terminal");
    expect(parseSettings(JSON.stringify({}))).toMatchObject({
      agentPaneDefaultView: "terminal",
    });
    for (const bad of ["bubble", "", 7, null, true, {}]) {
      expect(
        parseSettings(
          JSON.stringify({ agentPaneDefaultView: bad, defaultProfile: "cmd" }),
        ),
      ).toMatchObject({ agentPaneDefaultView: "terminal", defaultProfile: "cmd" });
    }
    expect(
      parseSettings(JSON.stringify({ agentPaneDefaultView: "chat" }))
        .agentPaneDefaultView,
    ).toBe("chat");
  });

  it("chatDefaultDensity: defaults to smart and rejects unknown densities", () => {
    expect(DEFAULT_SETTINGS.chatDefaultDensity).toBe("smart");
    expect(parseSettings(JSON.stringify({}))).toMatchObject({
      chatDefaultDensity: "smart",
    });
    for (const bad of ["bubble", "dense", "", 7, null, true, {}]) {
      expect(
        parseSettings(
          JSON.stringify({ chatDefaultDensity: bad, defaultProfile: "cmd" }),
        ),
      ).toMatchObject({ chatDefaultDensity: "smart", defaultProfile: "cmd" });
    }
    for (const good of ["chips", "smart", "full"] as const) {
      expect(
        parseSettings(JSON.stringify({ chatDefaultDensity: good }))
          .chatDefaultDensity,
      ).toBe(good);
    }
  });

  it("saved-session surfaces: pane button and sidebar list on, rail off", () => {
    expect(DEFAULT_SETTINGS.savedPaneButton).toBe(true);
    expect(DEFAULT_SETTINGS.savedSidebarList).toBe(true);
    expect(DEFAULT_SETTINGS.savedConversationsRail).toBe(false);
    expect(parseSettings(JSON.stringify({}))).toMatchObject({
      savedPaneButton: true,
      savedSidebarList: true,
      savedConversationsRail: false,
    });
  });

  it(
    "window rename does NOT touch the rail tab by default — the whole point " +
      "of naming a window is a group label ABOVE two or three panes, while " +
      "each rail tab keeps its own identity",
    () => {
      expect(DEFAULT_SETTINGS.syncWindowRenameToTab).toBe(false);
      expect(parseSettings(JSON.stringify({}))).toMatchObject({
        syncWindowRenameToTab: false,
      });
      expect(parseSettings(JSON.stringify({ syncWindowRenameToTab: true })))
        .toMatchObject({ syncWindowRenameToTab: true });
      // Anything that is not a boolean falls back to off, like its neighbours.
      for (const junk of ["true", "", 0, 1, null, [], {}]) {
        expect(
          parseSettings(JSON.stringify({ syncWindowRenameToTab: junk }))
            .syncWindowRenameToTab,
        ).toBe(false);
      }
    },
  );

  it("ssh: both surfaces on, passwords stored and encrypted by default", () => {
    // Spec §6: the default is the one that makes connecting effortless, with
    // encryption on so "stored" never means "in the clear" unless asked.
    expect(DEFAULT_SETTINGS.sshHostsSidebar).toBe(true);
    expect(DEFAULT_SETTINGS.sshHostsMenu).toBe(true);
    expect(DEFAULT_SETTINGS.sshPasswordPolicy).toBe("store");
    expect(DEFAULT_SETTINGS.sshEncryptPasswords).toBe(true);
    expect(parseSettings(JSON.stringify({}))).toMatchObject({
      sshHostsSidebar: true,
      sshHostsMenu: true,
      sshPasswordPolicy: "store",
      sshEncryptPasswords: true,
    });
  });

  it("ssh: junk values fall back per field, other fields survive", () => {
    for (const bad of ["true", "", 0, 1, null, [], {}]) {
      expect(
        parseSettings(
          JSON.stringify({
            sshHostsSidebar: bad,
            sshHostsMenu: bad,
            sshPasswordPolicy: bad,
            sshEncryptPasswords: bad,
            defaultProfile: "cmd",
          }),
        ),
      ).toMatchObject({
        sshHostsSidebar: DEFAULT_SETTINGS.sshHostsSidebar,
        sshHostsMenu: DEFAULT_SETTINGS.sshHostsMenu,
        sshPasswordPolicy: DEFAULT_SETTINGS.sshPasswordPolicy,
        sshEncryptPasswords: DEFAULT_SETTINGS.sshEncryptPasswords,
        defaultProfile: "cmd",
      });
    }
  });

  it("ssh: keys-only mode is a legal password policy", () => {
    expect(
      parseSettings(JSON.stringify({ sshPasswordPolicy: "never" }))
        .sshPasswordPolicy,
    ).toBe("never");
    expect(
      parseSettings(JSON.stringify({ sshPasswordPolicy: "store" }))
        .sshPasswordPolicy,
    ).toBe("store");
  });

  it("saved-session surfaces: non-booleans fall back, other fields survive", () => {
    for (const bad of ["true", "", 0, 1, null, [], {}]) {
      expect(
        parseSettings(
          JSON.stringify({
            savedPaneButton: bad,
            savedSidebarList: bad,
            savedConversationsRail: bad,
            defaultProfile: "cmd",
          }),
        ),
      ).toMatchObject({
        savedPaneButton: DEFAULT_SETTINGS.savedPaneButton,
        savedSidebarList: DEFAULT_SETTINGS.savedSidebarList,
        savedConversationsRail: DEFAULT_SETTINGS.savedConversationsRail,
        defaultProfile: "cmd",
      });
    }
    expect(
      parseSettings(
        JSON.stringify({
          savedPaneButton: false,
          savedSidebarList: false,
          savedConversationsRail: true,
        }),
      ),
    ).toMatchObject({
      savedPaneButton: false,
      savedSidebarList: false,
      savedConversationsRail: true,
    });
  });

  it("ignores unknown fields", () => {
    const parsed = parseSettings(
      JSON.stringify({ futureFeature: true, defaultProfile: "cmd" }),
    );
    expect(parsed.defaultProfile).toBe("cmd");
  });

  it("conversationsRail: non-boolean falls back to default, other fields survive", () => {
    const parsed = parseSettings(
      JSON.stringify({ conversationsRail: "yes", defaultProfile: "cmd" }),
    );
    expect(parsed.conversationsRail).toBe(DEFAULT_SETTINGS.conversationsRail);
    expect(parsed.defaultProfile).toBe("cmd");
  });

  it("conversationsPalette: non-boolean falls back to default, other fields survive", () => {
    const parsed = parseSettings(
      JSON.stringify({ conversationsPalette: 0, defaultProfile: "cmd" }),
    );
    expect(parsed.conversationsPalette).toBe(
      DEFAULT_SETTINGS.conversationsPalette,
    );
    expect(parsed.defaultProfile).toBe("cmd");
  });

  it("summaryEngine: unknown value falls back to default, other fields survive", () => {
    const parsed = parseSettings(
      JSON.stringify({ summaryEngine: "vibes", defaultProfile: "cmd" }),
    );
    expect(parsed.summaryEngine).toBe(DEFAULT_SETTINGS.summaryEngine);
    expect(parsed.defaultProfile).toBe("cmd");
  });

  it("summaryContent: unknown value falls back to default, other fields survive", () => {
    const parsed = parseSettings(
      JSON.stringify({ summaryContent: "everything", defaultProfile: "cmd" }),
    );
    expect(parsed.summaryContent).toBe(DEFAULT_SETTINGS.summaryContent);
    expect(parsed.defaultProfile).toBe("cmd");
  });

  it("summaryDisplay: unknown value falls back to default, other fields survive", () => {
    const parsed = parseSettings(
      JSON.stringify({ summaryDisplay: "sidebar", defaultProfile: "cmd" }),
    );
    expect(parsed.summaryDisplay).toBe(DEFAULT_SETTINGS.summaryDisplay);
    expect(parsed.defaultProfile).toBe("cmd");
  });

  it("sleepHiddenTerminals: unknown value falls back to default, other fields survive", () => {
    const parsed = parseSettings(
      JSON.stringify({ sleepHiddenTerminals: "30", defaultProfile: "cmd" }),
    );
    expect(parsed.sleepHiddenTerminals).toBe(
      DEFAULT_SETTINGS.sleepHiddenTerminals,
    );
    expect(parsed.defaultProfile).toBe("cmd");
  });

  it("onWindowClose: unknown value falls back to default, other fields survive", () => {
    const parsed = parseSettings(
      JSON.stringify({ onWindowClose: "explode", defaultProfile: "cmd" }),
    );
    expect(parsed.onWindowClose).toBe(DEFAULT_SETTINGS.onWindowClose);
    expect(parsed.defaultProfile).toBe("cmd");
  });
});

describe("SettingsStore", () => {
  it("applies updates synchronously and notifies subscribers", () => {
    const store = new SettingsStore();
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().newTabPolicy));

    store.update({ newTabPolicy: "ask-native" });

    expect(store.getSnapshot().newTabPolicy).toBe("ask-native");
    expect(seen).toEqual(["ask-native"]);
  });

  it("does not notify or save when a patch changes nothing", async () => {
    const save = vi.fn(() => Promise.resolve());
    const store = new SettingsStore({ save });
    const listener = vi.fn();
    store.subscribe(listener);

    store.update({ shellIntegration: DEFAULT_SETTINGS.shellIntegration });
    await store.flush();

    expect(listener).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("does not notify or save when a patch to a new (conversations/terminals) field changes nothing", async () => {
    const save = vi.fn(() => Promise.resolve());
    const store = new SettingsStore({ save });
    const listener = vi.fn();
    store.subscribe(listener);

    store.update({
      conversationsRail: DEFAULT_SETTINGS.conversationsRail,
      conversationsPalette: DEFAULT_SETTINGS.conversationsPalette,
      summaryEngine: DEFAULT_SETTINGS.summaryEngine,
      summaryContent: DEFAULT_SETTINGS.summaryContent,
      summaryDisplay: DEFAULT_SETTINGS.summaryDisplay,
      sleepHiddenTerminals: DEFAULT_SETTINGS.sleepHiddenTerminals,
      onWindowClose: DEFAULT_SETTINGS.onWindowClose,
    });
    await store.flush();

    expect(listener).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("notifies and saves when only a new field actually changes", async () => {
    const save = vi.fn(() => Promise.resolve());
    const store = new SettingsStore({ save });
    const listener = vi.fn();
    store.subscribe(listener);

    store.update({ onWindowClose: "stop-all" });
    await store.flush();

    expect(store.getSnapshot().onWindowClose).toBe("stop-all");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("notifies and saves for a theme-only change (live switching)", async () => {
    const save = vi.fn(() => Promise.resolve());
    const store = new SettingsStore({ save });
    const listener = vi.fn();
    store.subscribe(listener);

    store.update({ theme: "paper-light" });
    await store.flush();

    expect(store.getSnapshot().theme).toBe("paper-light");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);

    store.update({ theme: "paper-light" });
    await store.flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies and saves for a maxGroupDepth-only change", async () => {
    const save = vi.fn(() => Promise.resolve());
    const store = new SettingsStore({ save });
    const listener = vi.fn();
    store.subscribe(listener);

    store.update({ maxGroupDepth: 5 });
    await store.flush();

    expect(store.getSnapshot().maxGroupDepth).toBe(5);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("notifies and saves for an agentPaneDefaultView-only change", async () => {
    const save = vi.fn(() => Promise.resolve());
    const store = new SettingsStore({ save });
    const listener = vi.fn();
    store.subscribe(listener);

    store.update({ agentPaneDefaultView: "chat" });
    await store.flush();

    expect(store.getSnapshot().agentPaneDefaultView).toBe("chat");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("notifies and saves for a chatDefaultDensity-only change", async () => {
    const save = vi.fn(() => Promise.resolve());
    const store = new SettingsStore({ save });
    const listener = vi.fn();
    store.subscribe(listener);

    store.update({ chatDefaultDensity: "full" });
    await store.flush();

    expect(store.getSnapshot().chatDefaultDensity).toBe("full");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  // The generic guard: a field added to TermxSettings but forgotten in the
  // store's equality check is silently unsaveable (bug class fixed in e5f0e5b).
  // This loop fails for ANY such field, including ones added in future batches.
  it("notifies and saves for a one-field change to EVERY settings field", async () => {
    const keys = Object.keys(DEFAULT_SETTINGS) as (keyof TermxSettings)[];
    expect(keys.length).toBeGreaterThan(0);

    for (const key of keys) {
      expect(ALTERNATE_SETTINGS[key], `alternate for ${key}`).not.toEqual(
        DEFAULT_SETTINGS[key],
      );

      const save = vi.fn(() => Promise.resolve());
      const store = new SettingsStore({ save });
      const listener = vi.fn();
      store.subscribe(listener);

      store.update({ [key]: ALTERNATE_SETTINGS[key] } as Partial<TermxSettings>);
      await store.flush();

      expect(store.getSnapshot()[key], `snapshot for ${key}`).toEqual(
        ALTERNATE_SETTINGS[key],
      );
      expect(listener, `listener for ${key}`).toHaveBeenCalledTimes(1);
      expect(save, `save for ${key}`).toHaveBeenCalledTimes(1);
    }
  });

  it("serializes saves in update order", async () => {
    const saved: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new SettingsStore({
      save: async (text) => {
        if (saved.length === 0) {
          await gate;
        }
        saved.push(text);
      },
    });

    store.update({ defaultProfile: "cmd" });
    store.update({ shellIntegration: false });
    release();
    await store.flush();

    expect(saved).toHaveLength(2);
    expect(JSON.parse(saved[0]!).defaultProfile).toBe("cmd");
    expect(JSON.parse(saved[1]!).shellIntegration).toBe(false);
  });

  it("keeps working in memory when a save fails", async () => {
    const errors: unknown[] = [];
    const store = new SettingsStore({
      save: () => Promise.reject(new Error("disk full")),
      onSaveError: (error) => errors.push(error),
    });

    store.update({ defaultProfile: "cmd" });
    await store.flush();
    store.update({ shellIntegration: false });
    await store.flush();

    expect(store.getSnapshot()).toMatchObject({
      defaultProfile: "cmd",
      shellIntegration: false,
    });
    expect(errors).toHaveLength(2);
  });
});

describe("loadSettingsStore", () => {
  it("loads persisted settings", async () => {
    const store = await loadSettingsStore({
      read: () =>
        Promise.resolve(JSON.stringify({ newTabPolicy: "first-terminal" })),
    });
    expect(store.getSnapshot().newTabPolicy).toBe("first-terminal");
  });

  it("falls back to defaults when the read itself fails", async () => {
    const store = await loadSettingsStore({
      read: () => Promise.reject(new Error("ipc down")),
    });
    expect(store.getSnapshot()).toEqual(DEFAULT_SETTINGS);
  });

  it("does not write during load (malformed file preserved until user edit)", async () => {
    const save = vi.fn(() => Promise.resolve());
    const store = await loadSettingsStore({
      read: () => Promise.resolve("{broken"),
      save,
    });
    await store.flush();
    expect(save).not.toHaveBeenCalled();

    store.update({ defaultProfile: "cmd" });
    await store.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
