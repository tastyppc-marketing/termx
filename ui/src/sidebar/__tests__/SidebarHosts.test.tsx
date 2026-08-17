/**
 * Sidebar "Hosts" section (ssh-sessions spec §1): gating by the setting, the
 * alias + `user@hostname` projection, connect on click and Enter, the
 * password-policy-gated key action, and the empty-inventory hint.
 *
 * Modelled on SidebarSaved.test.tsx — the section deliberately shares the
 * Saved section's visual language and keyboard manners.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SshHost } from "../../ssh/types";
import { emptyLayout } from "../../state/layout";
import type { WorkspaceSnapshot } from "../../workspace/WorkspaceController";
import { Sidebar, type SidebarActions, type SidebarHosts } from "../Sidebar";

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

function snapshot(): WorkspaceSnapshot {
  return {
    layout: emptyLayout(),
    rootItems: [],
    ungroupedTabs: [],
    groups: [],
    paneStates: {},
    activeTabId: null,
    activeSessionId: null,
    persistence: { saving: false, error: null },
    notice: null,
  };
}

function actions(): SidebarActions {
  return {
    activateTab: vi.fn(),
    renameTab: vi.fn(),
    recolorTab: vi.fn(),
    setTabFill: vi.fn(),
    recolorGroup: vi.fn(),
    moveItem: vi.fn(() => true),
    createGroup: vi.fn(() => "new-group"),
    renameGroup: vi.fn(),
    toggleGroup: vi.fn(),
    createTab: vi.fn(async () => undefined),
    mergeTabs: vi.fn(),
    duplicateTab: vi.fn(async () => undefined),
    openFolderHere: vi.fn(async () => undefined),
    closeLiveTab: vi.fn(async () => undefined),
    deleteGroup: vi.fn(async () => undefined),
    dismissDeadTab: vi.fn(async () => undefined),
  };
}

function host(overrides: Partial<SshHost> & { alias: string }): SshHost {
  return {
    aliases: [overrides.alias],
    hostName: null,
    user: null,
    identityFile: null,
    ...overrides,
  };
}

const HOSTS: readonly SshHost[] = [
  host({
    alias: "myvps",
    aliases: ["myvps", "vps"],
    hostName: "100.64.0.2",
    user: "root",
    identityFile: "~/.ssh/id_ed25519",
  }),
  host({ alias: "buildbox", hostName: "build.example.net", user: null }),
  host({ alias: "bare" }),
];

function hostsProps(overrides: Partial<SidebarHosts> = {}): {
  hosts: SidebarHosts;
  onConnect: ReturnType<typeof vi.fn>;
  onSetPassword: ReturnType<typeof vi.fn>;
} {
  const onConnect = vi.fn();
  const onSetPassword = vi.fn();
  return {
    hosts: {
      enabled: true,
      menuEnabled: true,
      hosts: HOSTS,
      onConnect,
      onSetPassword,
      ...overrides,
    },
    onConnect,
    onSetPassword,
  };
}

async function renderSidebar(hosts: SidebarHosts | undefined) {
  await act(async () =>
    root.render(
      <Sidebar
        snapshot={snapshot()}
        actions={actions()}
        {...(hosts ? { hosts } : {})}
      />,
    )
  );
}

function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-testid='host-row']")];
}

function row(alias: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-host-alias='${alias}']`);
  if (!found) {
    throw new Error(`no host row ${alias}`);
  }
  return found;
}

function button(label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`[aria-label='${label}']`);
  if (!found) {
    throw new Error(`no control labelled ${label}`);
  }
  return found;
}

async function click(element: Element): Promise<void> {
  await act(async () =>
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
  );
}

describe("Sidebar hosts section", () => {
  it("renders nothing when the caller wires no hosts", async () => {
    await renderSidebar(undefined);

    expect(container.querySelector("[data-testid='hosts-section']")).toBeNull();
  });

  it("renders nothing when the sidebar hosts setting is off", async () => {
    const { hosts } = hostsProps({ enabled: false });
    await renderSidebar(hosts);

    expect(container.querySelector("[data-testid='hosts-section']")).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it("keeps the section with a one-line hint when the inventory is empty", async () => {
    const { hosts } = hostsProps({ hosts: [] });
    await renderSidebar(hosts);

    expect(container.querySelector("[data-testid='hosts-section']")).not.toBeNull();
    expect(rows()).toHaveLength(0);
    expect(container.querySelector(".sidebar-hosts__empty")?.textContent).toContain(
      "Hosts from your SSH config appear here.",
    );
  });

  it("sits below the Saved section", async () => {
    const { hosts } = hostsProps();
    await act(async () =>
      root.render(
        <Sidebar
          snapshot={snapshot()}
          actions={actions()}
          saved={{
            enabled: true,
            entries: [],
            onResume: vi.fn(),
            onRename: vi.fn(),
            onDescribe: vi.fn(),
            onDelete: vi.fn(),
          }}
          hosts={hosts}
        />,
      )
    );

    const sections = [
      ...container.querySelectorAll<HTMLElement>(
        "[data-testid='saved-section'], [data-testid='hosts-section']",
      ),
    ];
    expect(sections.map((section) => section.dataset.testid)).toEqual([
      "saved-section",
      "hosts-section",
    ]);
  });

  it("lists every host in config order with the alias and its user@hostname", async () => {
    const { hosts } = hostsProps();
    await renderSidebar(hosts);

    expect(rows().map((element) => element.dataset.hostAlias)).toEqual([
      "myvps",
      "buildbox",
      "bare",
    ]);
    expect(row("myvps").querySelector(".sidebar-hosts__alias")?.textContent).toBe("myvps");
    expect(row("myvps").querySelector(".sidebar-hosts__target")?.textContent).toBe(
      "root@100.64.0.2",
    );
    // No User in the block: the hostname alone is the useful detail.
    expect(row("buildbox").querySelector(".sidebar-hosts__target")?.textContent).toBe(
      "build.example.net",
    );
    // No HostName either: the alias line stands alone.
    expect(row("bare").querySelector(".sidebar-hosts__target")).toBeNull();
  });

  it("carries the connect command as the row's tooltip", async () => {
    const { hosts } = hostsProps();
    await renderSidebar(hosts);

    expect(row("myvps").title).toBe("ssh myvps");
  });

  it("connects the clicked host", async () => {
    const { hosts, onConnect } = hostsProps();
    await renderSidebar(hosts);

    await click(row("buildbox"));

    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect).toHaveBeenCalledWith("buildbox");
  });

  it("connects on Enter from the keyboard", async () => {
    const { hosts, onConnect } = hostsProps();
    await renderSidebar(hosts);

    await act(async () =>
      row("bare").dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      }))
    );

    expect(onConnect).toHaveBeenCalledWith("bare");
  });

  it("offers the key action per host, and it never doubles as a connect", async () => {
    const { hosts, onConnect, onSetPassword } = hostsProps();
    await renderSidebar(hosts);

    await click(button("Set password for myvps"));

    expect(onSetPassword).toHaveBeenCalledWith("myvps");
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("hides the key action when the password policy forbids storing", async () => {
    const { hosts } = hostsProps();
    const { onSetPassword: _drop, ...rest } = hosts;
    await renderSidebar(rest as SidebarHosts);

    expect(container.querySelector("[aria-label='Set password for myvps']")).toBeNull();
    expect(rows()).toHaveLength(3);
  });

  it("labels the key action for hosts that already have a stored password", async () => {
    const { hosts } = hostsProps({ withPassword: new Set(["myvps"]) });
    await renderSidebar(hosts);

    expect(button("Set password for myvps").title).toBe("Change password…");
    expect(button("Set password for buildbox").title).toBe("Set password…");
    expect(row("myvps").querySelector("[data-testid='host-password-badge']")).not.toBeNull();
    expect(row("buildbox").querySelector("[data-testid='host-password-badge']")).toBeNull();
  });

  it("never renders a password value anywhere in the section", async () => {
    const { hosts } = hostsProps({ withPassword: new Set(["myvps"]) });
    await renderSidebar(hosts);

    const section = container.querySelector("[data-testid='hosts-section']")!;
    expect(section.outerHTML).not.toContain("password-value");
  });
});
