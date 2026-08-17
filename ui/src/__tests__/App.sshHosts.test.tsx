/**
 * SSH-sessions App integration (ssh-sessions spec, lane D). Three seams the App
 * owns and the lanes below it cannot cover on their own:
 *
 *  - the Sidebar `hosts` prop it assembles from the inventory + settings, and
 *    the connect it dispatches to the controller;
 *  - the save dialog carrying the SSH host + captured conversation into a saved
 *    entry, and the async /rename title probe that refreshes the open dialog;
 *  - the set-password dialog write path, which must reach the real credentials
 *    store and only close once the store has taken the secret.
 *
 * The Sidebar is mocked down to the host controls (the real one is exercised in
 * its own suite); the credentials store and SplitLayout are real.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppFileName, AppFileStore } from "../native/appFiles";
import { createSavedSessionsStore } from "../saved/store";
import { createSshCredentialsStore } from "../ssh/credentials";
import type { SshHost } from "../ssh/types";
import { DEFAULT_SETTINGS, type TermxSettings } from "../settings/settings";
import { SettingsStore } from "../settings/SettingsStore";
import type { LayoutV2 } from "../state/layout";
import type {
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../workspace/WorkspaceController";
import type { BootstrappedWorkspace } from "../workspace/bootstrapWorkspace";

const probeRemoteTitle = vi.fn(async () => null as string | null);
vi.mock("../native/sshProbe", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  probeRemoteTitle: (...args: unknown[]) => probeRemoteTitle(...(args as [])),
}));

vi.mock("../sidebar/Sidebar", () => ({
  // Just the host controls the App wires: a connect button per host and, when
  // storing is allowed, a set-password button. Gating flags ride as data attrs.
  Sidebar: (props: {
    hosts?: {
      enabled: boolean;
      menuEnabled: boolean;
      hosts: readonly SshHost[];
      onConnect: (alias: string) => void;
      onSetPassword?: (alias: string) => void;
      withPassword?: ReadonlySet<string>;
    };
  }) => (
    <div data-testid="workspace-sidebar">
      {props.hosts ? (
        <div
          data-testid="hosts-section"
          data-enabled={String(props.hosts.enabled)}
          data-menu-enabled={String(props.hosts.menuEnabled)}
          data-can-set-password={String(Boolean(props.hosts.onSetPassword))}
        >
          {props.hosts.hosts.map((host) => (
            <div key={host.alias}>
              <button
                type="button"
                data-testid={`host-connect-${host.alias}`}
                onClick={() => props.hosts!.onConnect(host.alias)}
              />
              {props.hosts!.onSetPassword ? (
                <button
                  type="button"
                  data-testid={`host-setpw-${host.alias}`}
                  data-has-password={String(
                    props.hosts!.withPassword?.has(host.alias) ?? false,
                  )}
                  onClick={() => props.hosts!.onSetPassword!(host.alias)}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  ),
}));
vi.mock("../terminal/TerminalPane", () => ({
  TerminalPane: ({ sessionId }: { sessionId: number }) => (
    <div data-session-id={sessionId} data-testid="workspace-terminal" />
  ),
}));

import App from "../App";

const PANE_CWD = "/root/site";

const MYVPS: SshHost = {
  alias: "myvps",
  aliases: ["myvps"],
  hostName: "203.0.113.9",
  user: "root",
  identityFile: "~/.ssh/id_ed25519",
};

function tab(overrides: Partial<SidebarTabModel> = {}): SidebarTabModel {
  return {
    id: "tab-1",
    groupId: null,
    title: "myvps",
    color: "blue",
    fill: "off",
    primarySessionId: 1,
    sessionIds: [1],
    status: "live",
    activity: "idle",
    profile: "powershell",
    cwd: PANE_CWD,
    ...overrides,
  };
}

function snapshot(activeTab: SidebarTabModel = tab()): WorkspaceSnapshot {
  const layout: LayoutV2 = {
    version: 2,
    groups: {},
    rootItems: [{ kind: "tab", id: activeTab.id }],
    tabs: {
      [activeTab.id]: {
        id: activeTab.id,
        title: activeTab.title,
        color: activeTab.color,
        fill: activeTab.fill,
        split: { kind: "pane", sessionId: activeTab.primarySessionId },
      },
    },
    activeTabId: activeTab.id,
  };
  return {
    layout,
    rootItems: [{ kind: "tab", tab: activeTab }],
    ungroupedTabs: [activeTab],
    groups: [],
    paneStates: {
      [activeTab.primarySessionId]: { status: "live", exitCode: null },
    },
    activeTabId: activeTab.id,
    activeSessionId: activeTab.primarySessionId,
    persistence: { saving: false, error: null },
    notice: null,
  };
}

interface FakeFiles extends AppFileStore {
  text: string | null;
}
function fakeFiles(): FakeFiles {
  const files: FakeFiles = {
    text: null,
    read: (_name: AppFileName) => Promise.resolve(files.text),
    write: (_name: AppFileName, contents: string) => {
      files.text = contents;
      return Promise.resolve();
    },
  };
  return files;
}
function fakeCrypto() {
  return {
    protect: (plain: string) =>
      Promise.resolve(`enc:${[...plain].reverse().join("")}`),
    unprotect: (data: string) =>
      data.startsWith("enc:")
        ? Promise.resolve([...data.slice(4)].reverse().join(""))
        : Promise.reject(new Error("not our blob")),
  };
}

interface HarnessOptions {
  settings?: Partial<TermxSettings>;
  hosts?: readonly SshHost[];
  /** Pane 1's SSH host, if it is a remote pane. */
  paneHost?: string | null;
  /** The conversation captured on pane 1, if any. */
  capture?: { provider: "claude" | "codex"; id: string } | null;
}

function harness(options: HarnessOptions = {}) {
  const current = snapshot();
  const controller = {
    attachments: {
      attach: vi.fn(),
      onError: vi.fn(() => () => undefined),
      close: vi.fn(),
    },
    getSnapshot: () => current,
    subscribe: () => () => undefined,
    dispose: vi.fn(),
    activateTab: vi.fn(),
    renameTab: vi.fn(),
    recolorTab: vi.fn(),
    moveTab: vi.fn(),
    reorderGroup: vi.fn(),
    createGroup: vi.fn(),
    renameGroup: vi.fn(),
    toggleGroup: vi.fn(),
    createTab: vi.fn(),
    duplicateTab: vi.fn(),
    openFolderHere: vi.fn(),
    closeLiveTab: vi.fn(),
    closeGroup: vi.fn(),
    dismissDeadTab: vi.fn(),
    splitPane: vi.fn(async () => null),
    closePane: vi.fn(async () => undefined),
    resizePane: vi.fn(),
    reportSessionCwd: vi.fn(),
    setFolderSearchHandler: vi.fn(),
    createTabWithCwd: vi.fn(async () => undefined),
    createTabViaNativeDialog: vi.fn(async () => undefined),
    mergeTabs: vi.fn(),
    popOutPane: vi.fn(),
    resumeSession: vi.fn(async () => undefined),
    resumeSaved: vi.fn(async () => undefined),
    sessionDims: vi.fn(() => ({})),
    sessionCwd: vi.fn(() => PANE_CWD),
    resumedSessionKeyForTab: vi.fn(() => null),
    sshPaneInfo: vi.fn(() =>
      options.paneHost ? { host: options.paneHost } : null,
    ),
    capturedConversation: vi.fn(() => options.capture ?? null),
    reportCapturedConversation: vi.fn(),
    connectSshHost: vi.fn(async () => undefined),
  };
  let counter = 0;
  const saved = createSavedSessionsStore(
    { read: async () => null, write: async () => undefined },
    { now: () => 1000, generateId: () => `saved-${++counter}` },
  );
  const sshCredentials = createSshCredentialsStore(fakeFiles(), fakeCrypto());
  const workspace = {
    controller,
    client: { close: vi.fn() },
    settings: new SettingsStore({
      initial: { ...DEFAULT_SETTINGS, ...options.settings },
    }),
    saved,
    sshHosts: options.hosts ?? [MYVPS],
    sshCredentials,
  } as unknown as BootstrappedWorkspace;
  return { workspace, controller, saved, sshCredentials };
}

async function mount(workspace: BootstrappedWorkspace) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<App bootstrap={async () => workspace} />));
  return { container, unmount: () => act(async () => root.unmount()) };
}

function query<T extends HTMLElement>(scope: HTMLElement, testId: string): T {
  const found = scope.querySelector<T>(`[data-testid='${testId}']`);
  if (!found) {
    throw new Error(`missing [data-testid='${testId}']`);
  }
  return found;
}

async function type(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  probeRemoteTitle.mockClear();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("App ssh-hosts integration", () => {
  it("passes the gated hosts section and connects the clicked host", async () => {
    const { workspace, controller } = harness({
      settings: {
        sshHostsSidebar: true,
        sshHostsMenu: false,
        sshPasswordPolicy: "store",
      },
    });
    const { container, unmount } = await mount(workspace);

    const section = query(container, "hosts-section");
    // Each surface is gated independently — the section on, the menu off.
    expect(section.getAttribute("data-enabled")).toBe("true");
    expect(section.getAttribute("data-menu-enabled")).toBe("false");
    // The "store" policy exposes the set-password affordance.
    expect(section.getAttribute("data-can-set-password")).toBe("true");

    await act(async () => query(container, "host-connect-myvps").click());
    expect(controller.connectSshHost).toHaveBeenCalledTimes(1);
    expect(controller.connectSshHost).toHaveBeenCalledWith(MYVPS);

    await unmount();
  });

  it("hides the set-password affordance unless the policy allows storing", async () => {
    const { workspace } = harness({
      settings: { sshHostsSidebar: true, sshPasswordPolicy: "never" },
    });
    const { container, unmount } = await mount(workspace);

    expect(
      query(container, "hosts-section").getAttribute("data-can-set-password"),
    ).toBe("false");
    expect(
      container.querySelector("[data-testid='host-setpw-myvps']"),
    ).toBeNull();

    await unmount();
  });

  it("saves a remote pane with its host and captured conversation, and probes the remote title", async () => {
    const { workspace, saved } = harness({
      paneHost: "myvps",
      capture: { provider: "claude", id: "conv-9" },
    });
    const { container, unmount } = await mount(workspace);

    await act(async () => query(container, "pane-save").click());
    // The remote /rename lands async: the App probes for the current title.
    expect(probeRemoteTitle).toHaveBeenCalledWith("myvps", "claude", "conv-9");
    await act(async () => query(container, "save-session-save").click());

    const entries = saved.getSnapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      ssh: { host: "myvps" },
      conversation: { provider: "claude", id: "conv-9" },
    });

    await unmount();
  });

  it("adopts the probed /rename title as the remote pin's name", async () => {
    probeRemoteTitle.mockResolvedValueOnce("Nightly deploy");
    const { workspace, saved } = harness({
      paneHost: "myvps",
      capture: { provider: "claude", id: "conv-9" },
    });
    const { container, unmount } = await mount(workspace);

    await act(async () => query(container, "pane-save").click());
    // The name seeds from the raw id, then the async probe replaces it — the
    // user did not touch the field, so the /rename wins.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(query<HTMLInputElement>(container, "save-session-name").value).toBe(
      "Nightly deploy",
    );
    await act(async () => query(container, "save-session-save").click());
    expect(saved.getSnapshot()[0]).toMatchObject({
      name: "Nightly deploy",
      ssh: { host: "myvps" },
    });

    await unmount();
  });

  it("stores a password through the real credentials store, closing only after the write", async () => {
    const { workspace, sshCredentials } = harness({
      settings: {
        sshHostsSidebar: true,
        sshPasswordPolicy: "store",
        sshEncryptPasswords: false,
      },
    });
    const { container, unmount } = await mount(workspace);

    await act(async () => query(container, "host-setpw-myvps").click());
    await type(
      query<HTMLInputElement>(container, "ssh-password-input"),
      "hunter2 ",
    );
    await act(async () => query(container, "ssh-password-save").click());

    // The dialog closes only once the store has taken the secret.
    expect(
      container.querySelector("[data-testid='ssh-password-save']"),
    ).toBeNull();
    expect(sshCredentials.hasPassword("myvps")).toBe(true);
    // The value survives the round trip untrimmed.
    expect(await sshCredentials.passwordFor("myvps")).toBe("hunter2 ");

    await unmount();
  });
});
