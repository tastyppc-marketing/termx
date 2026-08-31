/**
 * Full-screen settings surface: section sidebar + the active section's panel.
 * Structural behaviour (nav, panel switching, Esc, focus) lives here; the
 * per-control assertions migrated from the old settings-modal suite follow.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginNative } from "../../plugins/native";
import { PluginsStore } from "../../plugins/registry";
import { THEME_IDS, THEMES } from "../../theme/themes";
import { SETTINGS_SECTIONS } from "../sections";
import { SettingsStore } from "../SettingsStore";
import { SettingsSurface } from "../SettingsSurface";
import { DEFAULT_SETTINGS } from "../settings";

// The panel itself is covered by PluginsPanel.test.tsx; here the only question
// is whether a section carrying `panel: "plugins"` reaches it at all.
const { pluginsPanelProps } = vi.hoisted(() => ({ pluginsPanelProps: vi.fn() }));
vi.mock("../PluginsPanel", () => ({
  PluginsPanel: (props: Record<string, unknown>) => {
    pluginsPanelProps(props);
    return <div data-testid="plugins-panel-stub" />;
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

async function renderSurface(
  store: SettingsStore,
  onClose: () => void = () => undefined,
): Promise<void> {
  await act(async () => {
    root.render(<SettingsSurface store={store} onClose={onClose} />);
  });
}

function tabs(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(".settings-surface__tab"),
  );
}

async function selectSection(id: string): Promise<void> {
  const tab = container.querySelector<HTMLButtonElement>(
    `.settings-surface__tab[data-section='${id}']`,
  )!;
  await act(async () => {
    tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function panelFields(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(".settings-surface__panel [data-field]"),
  ).map((element) => element.dataset.field!);
}

describe("SettingsSurface", () => {
  it("renders a sidebar with every section label", async () => {
    await renderSurface(new SettingsStore());

    const surface = container.querySelector<HTMLElement>(".settings-surface")!;
    expect(surface.getAttribute("aria-label")).toBe("TermX settings");
    expect(tabs().map((tab) => tab.textContent)).toEqual(
      SETTINGS_SECTIONS.map((section) => section.label),
    );
  });

  it("opens on the first section and switches panels on click", async () => {
    await renderSurface(new SettingsStore());

    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(panelFields()).toEqual([...SETTINGS_SECTIONS[0]!.fields]);

    await selectSection("chat");

    const chatTab = container.querySelector(
      ".settings-surface__tab[data-section='chat']",
    )!;
    expect(chatTab.getAttribute("aria-selected")).toBe("true");
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("false");
    expect(panelFields()).toEqual(["agentPaneDefaultView", "chatDefaultDensity"]);
  });

  it("renders every field of whichever section is active", async () => {
    await renderSurface(new SettingsStore());

    for (const section of SETTINGS_SECTIONS) {
      await selectSection(section.id);
      expect(panelFields(), `fields of ${section.id}`).toEqual([...section.fields]);
    }
  });

  it("routes the Plugins section to the plugins panel", async () => {
    const plugins = {
      store: new PluginsStore(),
      native: {} as PluginNative,
      onOpen: vi.fn(),
    };
    pluginsPanelProps.mockClear();
    await act(async () => {
      root.render(
        <SettingsSurface
          store={new SettingsStore()}
          onClose={() => undefined}
          plugins={plugins}
        />,
      );
    });
    await selectSection("plugins");

    expect(
      container.querySelector("[data-testid='plugins-panel-stub']"),
    ).not.toBeNull();
    expect(pluginsPanelProps).toHaveBeenCalledWith(
      expect.objectContaining({
        store: plugins.store,
        native: plugins.native,
        onOpen: plugins.onOpen,
      }),
    );
  });

  it("explains the Plugins section when no registry is wired", async () => {
    await renderSurface(new SettingsStore());
    await selectSection("plugins");

    // Never an empty panel: a section that renders nothing reads as a bug.
    expect(
      container.querySelector("[data-testid='plugins-panel-stub']"),
    ).toBeNull();
    expect(
      container.querySelector(".settings-surface__panel .settings-section__note")
        ?.textContent,
    ).toBe("Plugin management is unavailable in this window.");
  });

  it("closes on Esc and from the back control", async () => {
    const onClose = vi.fn();
    await renderSurface(new SettingsStore(), onClose);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    const back = container.querySelector<HTMLButtonElement>(
      "[aria-label='Close settings']",
    )!;
    await act(async () => {
      back.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("ignores Esc raised outside the surface", async () => {
    const onClose = vi.fn();
    await renderSurface(new SettingsStore(), onClose);

    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    await act(async () => {
      outside.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("takes focus on mount and restores it on close", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    await renderSurface(new SettingsStore());
    expect(document.activeElement).toBe(
      container.querySelector(".settings-surface"),
    );

    await act(async () => root.render(null));
    expect(document.activeElement).toBe(opener);
  });
});

/**
 * Control behaviour migrated from the old settings-modal suite. Same
 * assertions, now made against the section that owns each control and
 * persisted through the live store rather than an onChange spy.
 */
describe("SettingsSurface controls", () => {
  function storeWithSave(): { store: SettingsStore; save: ReturnType<typeof vi.fn> } {
    const save = vi.fn(() => Promise.resolve());
    return { store: new SettingsStore({ save }), save };
  }

  function input(selector: string): HTMLInputElement {
    return container.querySelector<HTMLInputElement>(
      `.settings-surface__panel ${selector}`,
    )!;
  }

  async function click(element: HTMLElement): Promise<void> {
    await act(async () => {
      element.click();
    });
  }

  it("Groups & Tabs: new-tab policy and the group-nesting depth ladder", async () => {
    const { store, save } = storeWithSave();
    await renderSurface(store);
    await selectSection("groups");

    expect(input("input[value='group-active']").checked).toBe(true);
    await click(input("input[value='ask-searcher']"));
    expect(store.getSnapshot().newTabPolicy).toBe("ask-searcher");

    expect(input("input[name='maxGroupDepth'][value='3']").checked).toBe(true);
    await click(input("input[name='maxGroupDepth'][value='1']"));
    expect(store.getSnapshot().maxGroupDepth).toBe(1);
    await click(input("input[name='maxGroupDepth'][value='5']"));
    expect(store.getSnapshot().maxGroupDepth).toBe(5);

    await store.flush();
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("leaves an ordinary toggle's label readable to assistive tech", async () => {
    // The Plugins panel hides this span because it passes `ariaLabel`; a
    // settings field has no override, so the visible text IS the name and
    // hiding it would leave the checkbox nameless.
    const { store } = storeWithSave();
    await renderSurface(store);
    await selectSection("terminal");

    const text = container.querySelector(
      ".settings-surface__panel .settings-check .settings-radio__text",
    )!;
    expect(text.getAttribute("aria-hidden")).toBeNull();
    expect(
      input("input[type='checkbox']").getAttribute("aria-label"),
    ).toBeNull();
  });

  it("Terminal: shell integration and the default shell select", async () => {
    const { store } = storeWithSave();
    await renderSurface(store);
    await selectSection("terminal");

    const integration = input("input[type='checkbox']");
    expect(integration.checked).toBe(true);
    await click(integration);
    expect(store.getSnapshot().shellIntegration).toBe(false);

    const select = container.querySelector<HTMLSelectElement>(
      ".settings-surface__panel select",
    )!;
    expect(select.value).toBe("powershell");
    select.value = "cmd";
    await act(async () => {
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(store.getSnapshot().defaultProfile).toBe("cmd");
  });

  it("Conversations: rail, palette and the three summary ladders", async () => {
    const { store } = storeWithSave();
    await renderSurface(store);
    await selectSection("conversations");

    const rail = input("input[name='conversationsRail']");
    expect(rail.checked).toBe(true);
    await click(rail);
    expect(store.getSnapshot().conversationsRail).toBe(false);

    const palette = input("input[name='conversationsPalette']");
    expect(palette.checked).toBe(true);
    await click(palette);
    expect(store.getSnapshot().conversationsPalette).toBe(false);

    await click(input("input[name='summaryEngine'][value='llm']"));
    expect(store.getSnapshot().summaryEngine).toBe("llm");

    await click(input("input[name='summaryContent'][value='recap']"));
    expect(store.getSnapshot().summaryContent).toBe("recap");

    await click(input("input[name='summaryDisplay'][value='under-title']"));
    expect(store.getSnapshot().summaryDisplay).toBe("under-title");
  });

  it("General: close behaviour and hidden-terminal sleep", async () => {
    const { store } = storeWithSave();
    await renderSurface(store);
    await selectSection("general");

    expect(input("input[name='onWindowClose'][value='ask']").checked).toBe(true);
    const keepRunning = input("input[name='onWindowClose'][value='keep-running']");
    expect(keepRunning.parentElement?.textContent).toContain(
      "keeps terminals and agents running in the background",
    );
    await click(keepRunning);
    expect(store.getSnapshot().onWindowClose).toBe("keep-running");
    await click(input("input[name='onWindowClose'][value='stop-all']"));
    expect(store.getSnapshot().onWindowClose).toBe("stop-all");

    expect(input("input[name='sleepHiddenTerminals'][value='15']").checked).toBe(
      true,
    );
    await click(input("input[name='sleepHiddenTerminals'][value='60']"));
    expect(store.getSnapshot().sleepHiddenTerminals).toBe("60");
    await click(input("input[name='sleepHiddenTerminals'][value='off']"));
    expect(store.getSnapshot().sleepHiddenTerminals).toBe("off");
  });

  it("Appearance: all six theme cards, each previewing its own palette", async () => {
    const { store } = storeWithSave();
    await renderSurface(store);
    await selectSection("appearance");

    const swatches = Array.from(
      container.querySelectorAll<HTMLInputElement>(
        ".settings-surface__panel input[name='theme']",
      ),
    );
    expect(swatches.map((option) => option.value)).toEqual([...THEME_IDS]);
    expect(swatches.find((option) => option.checked)?.value).toBe(
      DEFAULT_SETTINGS.theme,
    );
    expect(
      container.querySelectorAll(".settings-surface__panel .settings-theme__swatch"),
    ).toHaveLength(THEME_IDS.length);
    for (const id of THEME_IDS) {
      expect(container.textContent).toContain(THEMES[id].name);
    }

    await click(swatches.find((option) => option.value === "paper-light")!);
    expect(store.getSnapshot().theme).toBe("paper-light");
  });

  it("Chat View: agent pane default view and default chat density", async () => {
    const { store, save } = storeWithSave();
    await renderSurface(store);
    await selectSection("chat");

    expect(input("input[name='agentPaneDefaultView'][value='terminal']").checked)
      .toBe(true);
    await click(input("input[name='agentPaneDefaultView'][value='chat']"));
    expect(store.getSnapshot().agentPaneDefaultView).toBe("chat");

    expect(input("input[name='chatDefaultDensity'][value='smart']").checked).toBe(
      true,
    );
    await click(input("input[name='chatDefaultDensity'][value='full']"));
    expect(store.getSnapshot().chatDefaultDensity).toBe("full");
    await click(input("input[name='chatDefaultDensity'][value='chips']"));
    expect(store.getSnapshot().chatDefaultDensity).toBe("chips");

    await store.flush();
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("Saved sessions: the three surface toggles", async () => {
    const { store, save } = storeWithSave();
    await renderSurface(store);
    await selectSection("saved");

    const paneButton = input("input[name='savedPaneButton']");
    expect(paneButton.checked).toBe(true);
    await click(paneButton);
    expect(store.getSnapshot().savedPaneButton).toBe(false);

    const sidebarList = input("input[name='savedSidebarList']");
    expect(sidebarList.checked).toBe(true);
    await click(sidebarList);
    expect(store.getSnapshot().savedSidebarList).toBe(false);

    const rail = input("input[name='savedConversationsRail']");
    expect(rail.checked).toBe(false);
    await click(rail);
    expect(store.getSnapshot().savedConversationsRail).toBe(true);

    await store.flush();
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("SSH: the two surface toggles and the encryption toggle", async () => {
    const { store, save } = storeWithSave();
    await renderSurface(store);
    await selectSection("ssh");

    const sidebar = input("input[name='sshHostsSidebar']");
    expect(sidebar.checked).toBe(true);
    await click(sidebar);
    expect(store.getSnapshot().sshHostsSidebar).toBe(false);

    const menu = input("input[name='sshHostsMenu']");
    expect(menu.checked).toBe(true);
    await click(menu);
    expect(store.getSnapshot().sshHostsMenu).toBe(false);

    const encrypt = input("input[name='sshEncryptPasswords']");
    expect(encrypt.checked).toBe(true);
    await click(encrypt);
    expect(store.getSnapshot().sshEncryptPasswords).toBe(false);

    await store.flush();
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("SSH: the password policy ladder switches to keys-only", async () => {
    const { store } = storeWithSave();
    await renderSurface(store);
    await selectSection("ssh");

    expect(input("input[name='sshPasswordPolicy'][value='store']").checked).toBe(
      true,
    );
    await click(input("input[name='sshPasswordPolicy'][value='never']"));
    expect(store.getSnapshot().sshPasswordPolicy).toBe("never");
  });

  it("SSH: the encryption hint says plainly what off means", async () => {
    const { store } = storeWithSave();
    await renderSurface(store);
    await selectSection("ssh");

    // Spec §6: no euphemism for "plain text on disk".
    const field = container.querySelector(
      ".settings-field[data-field='sshEncryptPasswords']",
    );
    expect(field?.textContent).toMatch(/plain text/i);
  });

  it("re-renders live when the store changes underneath it", async () => {
    const { store } = storeWithSave();
    await renderSurface(store);
    await selectSection("appearance");

    await act(async () => store.update({ theme: "paper-light" }));

    const checked = Array.from(
      container.querySelectorAll<HTMLInputElement>(
        ".settings-surface__panel input[name='theme']",
      ),
    ).find((option) => option.checked);
    expect(checked?.value).toBe("paper-light");
  });
});
