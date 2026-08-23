import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationsStore } from "../conversations/store";
import type { LlmSessionRecord } from "../conversations/types";
import { createSavedSessionsStore } from "../saved/store";
import { DEFAULT_SETTINGS, type TermxSettings } from "../settings/settings";
import { SettingsStore } from "../settings/SettingsStore";
import type { LayoutV2 } from "../state/layout";
import type {
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../workspace/WorkspaceController";
import type { BootstrappedWorkspace } from "../workspace/bootstrapWorkspace";

vi.mock("../sidebar/Sidebar", () => ({
  // The real rail lives inside the Sidebar; the mock surfaces just the save
  // callback so the App-side wiring (gating, prefill, commit) is testable.
  Sidebar: (props: {
    conversations?: {
      onSaveConversation?: (record: LlmSessionRecord) => void;
    };
  }) => (
    <div data-testid="workspace-sidebar">
      {props.conversations?.onSaveConversation ? (
        <button
          type="button"
          data-testid="mock-rail-save"
          onClick={() =>
            props.conversations!.onSaveConversation!({
              provider: "claude",
              id: "abc-123",
              title: "Fix the daemon",
              cwd: "C:\\work\\project",
              filePath: "C:\\transcripts\\abc-123.jsonl",
              updatedAtMs: 111,
              summary: null,
              recap: null,
            })
          }
        />
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

const PANE_CWD = "C:\\work\\project";

function tab(overrides: Partial<SidebarTabModel> = {}): SidebarTabModel {
  return {
    id: "tab-1",
    groupId: null,
    title: "PowerShell · project",
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

function record(overrides: Partial<LlmSessionRecord> = {}): LlmSessionRecord {
  return {
    provider: "claude",
    id: "abc-123",
    title: "Fix the daemon",
    cwd: PANE_CWD,
    filePath: "C:\\transcripts\\abc-123.jsonl",
    updatedAtMs: 111,
    summary: null,
    recap: null,
    ...overrides,
  };
}

function conversationsFake(records: readonly LlmSessionRecord[]) {
  const stable = { records, data: { generated: {} } };
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => stable,
    setGeneratedNote: vi.fn(),
    refresh: vi.fn(async () => undefined),
  } as unknown as ConversationsStore;
}

interface HarnessOptions {
  settings?: Partial<TermxSettings>;
  records?: readonly LlmSessionRecord[];
  /** false = a workspace whose bootstrap produced no saved store at all. */
  savedStore?: boolean;
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
    paneTitles: vi.fn(() => ({})),
    sessionCwd: vi.fn(() => PANE_CWD),
    resumedSessionKeyForTab: vi.fn(() => null),
    resumedEntries: vi.fn(() => []),
    rebindResumedTab: vi.fn(),
    setResumeBootListener: vi.fn(),
    // SSH (ssh-sessions spec): these panes are all local, so no host info.
    sshPaneInfo: vi.fn(() => null),
    capturedConversation: vi.fn(() => null),
    reportCapturedConversation: vi.fn(),
    connectSshHost: vi.fn(async () => undefined),
  };
  const client = { close: vi.fn() };
  let counter = 0;
  const saved = createSavedSessionsStore(
    { read: async () => null, write: async () => undefined },
    { now: () => 1000, generateId: () => `saved-${++counter}` },
  );
  const workspace = {
    controller,
    client,
    settings: new SettingsStore({
      initial: { ...DEFAULT_SETTINGS, ...options.settings },
    }),
    ...(options.records ? { conversations: conversationsFake(options.records) } : {}),
    ...(options.savedStore === false ? {} : { saved }),
  } as unknown as BootstrappedWorkspace;
  return { workspace, controller, saved };
}

async function mount(workspace: BootstrappedWorkspace) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<App bootstrap={async () => workspace} />));
  return {
    container,
    unmount: () => act(async () => root.unmount()),
  };
}

function query<T extends HTMLElement>(scope: HTMLElement, testId: string): T {
  const found = scope.querySelector<T>(`[data-testid='${testId}']`);
  if (!found) {
    throw new Error(`missing [data-testid='${testId}']`);
  }
  return found;
}

/** Type into a controlled field through the native value setter. */
async function type(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("App saved-sessions integration", () => {
  it("saves a bare-shell pane: folder-tail name prefill, cwd from the controller, daemon id recorded", async () => {
    const { workspace, controller, saved } = harness();
    const { container, unmount } = await mount(workspace);

    await act(async () => query(container, "pane-save").click());

    expect(controller.sessionCwd).toHaveBeenCalledWith(1);
    expect(query<HTMLInputElement>(container, "save-session-name").value).toBe(
      "project",
    );
    expect(query<HTMLInputElement>(container, "save-session-cwd").value).toBe(
      PANE_CWD,
    );
    await act(async () => query(container, "save-session-save").click());

    expect(container.querySelector("[data-testid='save-session-save']")).toBeNull();
    const entries = saved.getSnapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "project",
      cwd: PANE_CWD,
      lastDaemonSessionId: 1,
    });
    expect(entries[0]!.conversation).toBeUndefined();
    expect(entries[0]!.description).toBeUndefined();

    await unmount();
  });

  it("links the pane's conversation, and re-saving prefills the stored entry and upserts", async () => {
    const { workspace, saved } = harness({ records: [record()] });
    const { container, unmount } = await mount(workspace);

    // First save: name comes from the linked conversation's title.
    await act(async () => query(container, "pane-save").click());
    expect(query<HTMLInputElement>(container, "save-session-name").value).toBe(
      "Fix the daemon",
    );
    expect(
      query(container, "save-session-conversation").textContent,
    ).toContain("Fix the daemon");
    await type(
      query<HTMLTextAreaElement>(container, "save-session-description"),
      "resume nightly",
    );
    await act(async () => query(container, "save-session-save").click());

    expect(saved.getSnapshot()).toHaveLength(1);
    expect(saved.getSnapshot()[0]).toMatchObject({
      name: "Fix the daemon",
      description: "resume nightly",
      conversation: { provider: "claude", id: "abc-123" },
      lastDaemonSessionId: 1,
    });

    // Second save of the same pane: the dialog must hand the stored fields
    // back (save() replaces the whole entry) and update, not duplicate.
    await act(async () => query(container, "pane-save").click());
    expect(
      query<HTMLTextAreaElement>(container, "save-session-description").value,
    ).toBe("resume nightly");
    expect(query(container, "save-session-save").textContent).toBe("Update");
    await type(
      query<HTMLInputElement>(container, "save-session-name"),
      "Daemon work",
    );
    await act(async () => query(container, "save-session-save").click());

    const entries = saved.getSnapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "Daemon work",
      description: "resume nightly",
      conversation: { provider: "claude", id: "abc-123" },
    });

    await unmount();
  });

  it("keeps the live pane cwd in the prefill over the stored folder", async () => {
    const { workspace, saved } = harness({ records: [record()] });
    saved.save({
      name: "Fix the daemon",
      cwd: "C:\\old\\place",
      conversation: { provider: "claude", id: "abc-123", title: "Fix the daemon" },
    });
    const { container, unmount } = await mount(workspace);

    await act(async () => query(container, "pane-save").click());
    // The spec prefills the folder from sessionCwd; the stored folder is only
    // a fallback — otherwise an Update quietly keeps snapshotting a stale dir.
    expect(query<HTMLInputElement>(container, "save-session-cwd").value).toBe(
      PANE_CWD,
    );

    await unmount();
  });

  it("rail re-save keeps the stored reattach link, and the rail action is gated", async () => {
    const gated = await mount(harness({ records: [record()] }).workspace);
    expect(
      gated.container.querySelector("[data-testid='mock-rail-save']"),
    ).toBeNull();
    await gated.unmount();

    const { workspace, saved } = harness({
      records: [record()],
      settings: { savedConversationsRail: true },
    });
    const { container, unmount } = await mount(workspace);

    // Pin from the pane first: the entry now carries daemon session 1.
    await act(async () => query(container, "pane-save").click());
    await act(async () => query(container, "save-session-save").click());
    expect(saved.getSnapshot()[0]).toMatchObject({ lastDaemonSessionId: 1 });

    // A rail save knows no pane, but must not strip the reattach link.
    await act(async () => query(container, "mock-rail-save").click());
    await type(
      query<HTMLTextAreaElement>(container, "save-session-description"),
      "tweaked from the rail",
    );
    await act(async () => query(container, "save-session-save").click());

    const entries = saved.getSnapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      description: "tweaked from the rail",
      lastDaemonSessionId: 1,
    });

    await unmount();
  });

  it("offers no pane save button when the setting is off or the store is absent", async () => {
    const settingOff = await mount(
      harness({ settings: { savedPaneButton: false } }).workspace,
    );
    expect(
      settingOff.container.querySelector("[data-testid='pane-save']"),
    ).toBeNull();
    await settingOff.unmount();

    const noStore = await mount(harness({ savedStore: false }).workspace);
    expect(
      noStore.container.querySelector("[data-testid='pane-save']"),
    ).toBeNull();
    await noStore.unmount();
  });
});
