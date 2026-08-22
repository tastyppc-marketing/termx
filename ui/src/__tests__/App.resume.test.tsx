/**
 * Sidebar resume → workspace, at the App level (polish P6).
 *
 * The controller owns opening the tab and typing `claude --resume`; what only
 * exists here is the wiring between the rail's Resume action, the resume
 * outcome, and the already-open dialog.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationsStore } from "../conversations/store";
import type { LlmSessionRecord } from "../conversations/types";
import type { LayoutV2 } from "../state/layout";
import type { WorkspaceSnapshot } from "../workspace/WorkspaceController";
import type { BootstrappedWorkspace } from "../workspace/bootstrapWorkspace";
import { UiStateStore } from "../workspace/uiState";

vi.mock("../sidebar/Sidebar", () => ({
  Sidebar: ({
    conversations,
  }: {
    conversations?: {
      store: { getSnapshot(): { records: readonly LlmSessionRecord[] } };
      onResume(record: LlmSessionRecord): void;
    };
  }) => (
    <div data-testid="resume-sidebar">
      <button
        type="button"
        data-testid="sidebar-resume-first"
        onClick={() => {
          const record = conversations?.store.getSnapshot().records[0];
          if (record) {
            conversations.onResume(record);
          }
        }}
      />
    </div>
  ),
}));
vi.mock("../terminal/TerminalPane", () => ({
  TerminalPane: ({ sessionId }: { sessionId: number }) => (
    <div data-testid="workspace-terminal" data-session-id={sessionId} />
  ),
}));

import App from "../App";

const CWD = "C:\\work\\project";

function record(overrides: Partial<LlmSessionRecord> = {}): LlmSessionRecord {
  return {
    provider: "claude",
    id: "orig",
    title: "Original conversation",
    cwd: CWD,
    filePath: "C:\\transcripts\\orig.jsonl",
    updatedAtMs: 500,
    summary: null,
    recap: null,
    ...overrides,
  };
}

function workspaceSnapshot(): WorkspaceSnapshot {
  const layout: LayoutV2 = {
    version: 2,
    groups: {},
    rootItems: [{ kind: "tab", id: "tab-1" }],
    tabs: {
      "tab-1": {
        id: "tab-1",
        title: "PowerShell · project",
        color: "blue",
        fill: "off",
        split: { kind: "pane", sessionId: 1 },
      },
    },
    activeTabId: "tab-1",
  };
  return {
    layout,
    rootItems: [
      {
        kind: "tab",
        tab: {
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
          cwd: CWD,
        },
      },
    ],
    ungroupedTabs: [],
    groups: [],
    paneStates: { 1: { status: "live", exitCode: null } },
    activeTabId: "tab-1",
    activeSessionId: 1,
    persistence: { saving: false, error: null },
    notice: null,
  } as unknown as WorkspaceSnapshot;
}

type ResumeOutcome =
  | { kind: "opened"; tabId: string; sessionId: number }
  | { kind: "already-open"; tabId: string };

interface Harness {
  workspace: BootstrappedWorkspace;
  conversations: ConversationsStore;
  resumeSession: ReturnType<typeof vi.fn>;
  activateTab: ReturnType<typeof vi.fn>;
}

function harness(options: { outcome: ResumeOutcome }): Harness {
  const records = [record()];
  const conversations = new ConversationsStore({
    list: async () => records,
  });
  // useSyncExternalStore compares by reference: one snapshot for the run.
  const snapshot = workspaceSnapshot();
  const resumeSession = vi.fn(async () => options.outcome);
  const activateTab = vi.fn();
  const controller = {
    attachments: {
      attach: vi.fn(),
      onError: vi.fn(() => () => undefined),
      close: vi.fn(),
    },
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    dispose: vi.fn(),
    activateTab,
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
    reportCapturedConversation: vi.fn(),
    setFolderSearchHandler: vi.fn(),
    createTabWithCwd: vi.fn(async () => undefined),
    createTabViaNativeDialog: vi.fn(async () => undefined),
    mergeTabs: vi.fn(),
    popOutPane: vi.fn(),
    sessionDims: vi.fn(() => ({})),
    sessionCwd: vi.fn(() => CWD),
    resumeSession,
    resumedSessionKeyForTab: vi.fn(() => null),
  };
  return {
    workspace: {
      controller,
      client: { close: vi.fn() },
      conversations,
      uiState: new UiStateStore(),
    } as unknown as BootstrappedWorkspace,
    conversations,
    resumeSession,
    activateTab,
  };
}

async function mountApp(fixture: Harness): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<App bootstrap={async () => fixture.workspace} />));
  // The mount effect kicks off the first conversations scan; let it land.
  await act(async () => {
    await fixture.conversations.refresh(false);
  });
  return { container, root };
}

function clickResume(container: HTMLElement): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(
    "[data-testid='sidebar-resume-first']",
  )!;
  return act(async () => button.click());
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("sidebar resume", () => {
  it("asks the controller to resume the record and shows the tab's terminal", async () => {
    const fixture = harness({
      outcome: { kind: "opened", tabId: "tab-1", sessionId: 1 },
    });
    const { container, root } = await mountApp(fixture);

    await clickResume(container);

    expect(fixture.resumeSession).toHaveBeenCalledWith(record());
    const pane = container.querySelector<HTMLElement>(
      "[data-testid='workspace-terminal']",
    );
    expect(pane?.getAttribute("data-session-id")).toBe("1");
    // A resume that opened a tab raises no dialog.
    expect(container.querySelector("[role='dialog']")).toBeNull();

    await act(async () => root.unmount());
  });

  it("raises the already-open dialog and switches to the existing tab", async () => {
    const fixture = harness({
      outcome: { kind: "already-open", tabId: "tab-1" },
    });
    const { container, root } = await mountApp(fixture);

    await clickResume(container);

    const dialog = container.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();
    const switchButton = container.querySelector<HTMLButtonElement>(
      ".already-open-dialog__switch",
    )!;
    await act(async () => switchButton.click());

    expect(fixture.activateTab).toHaveBeenCalledWith("tab-1");
    expect(container.querySelector("[role='dialog']")).toBeNull();

    await act(async () => root.unmount());
  });
});
