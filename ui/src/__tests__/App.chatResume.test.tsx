/**
 * Resume → chat integration (auto-reveal spec §4/§5/§7).
 *
 * Three behaviors that only exist at the App level, where the resume outcome,
 * the conversations scan, and the pane's chat props meet:
 *
 * 1. A resume that opened a tab marks its pane as BOOTING (the dock starts
 *    revealed) and stamps the pane's link immediately.
 * 2. When `claude --resume` hands off to a NEW transcript file, the rescan
 *    rebinds the resumed tab and repoints the pane at the successor.
 * 3. A remembered link keeps the chat reachable when a scan returns nothing —
 *    the Chat switch must not vanish with the records.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationsStore } from "../conversations/store";
import type { LlmSessionRecord } from "../conversations/types";
import type { LayoutV2 } from "../state/layout";
import type { WorkspaceSnapshot } from "../workspace/WorkspaceController";
import type { BootstrappedWorkspace } from "../workspace/bootstrapWorkspace";
import { UiStateStore, setChatPaneState } from "../workspace/uiState";

vi.mock("../sidebar/Sidebar", () => ({
  Sidebar: ({
    conversations,
  }: {
    conversations?: {
      store: { getSnapshot(): { records: readonly LlmSessionRecord[] } };
      onResume(record: LlmSessionRecord): void;
    };
  }) => (
    <div data-testid="chat-sidebar">
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
  TerminalPane: ({
    sessionId,
    chat,
  }: {
    sessionId: number;
    chat?: {
      filePath: string;
      title: string;
      mode: string;
      bootReveal?: boolean;
      slashCommands?: readonly unknown[];
    };
  }) => (
    <div
      data-testid="workspace-terminal"
      data-session-id={sessionId}
      data-chat-file={chat?.filePath ?? ""}
      data-chat-title={chat?.title ?? ""}
      data-chat-boot={chat?.bootReveal === true ? "true" : "false"}
      data-chat-present={chat ? "true" : "false"}
      data-chat-commands={String(chat?.slashCommands?.length ?? 0)}
    />
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

interface Harness {
  workspace: BootstrappedWorkspace;
  conversations: ConversationsStore;
  uiState: UiStateStore;
  setRecords(records: readonly LlmSessionRecord[]): void;
  /** What `resumedSessionKeyForTab`/`rebindResumedTab` currently point at. */
  currentKey(): string;
  rebindResumedTab: ReturnType<typeof vi.fn>;
  fireBoot(sessionId: number): void;
}

function harness(options: {
  records: readonly LlmSessionRecord[];
  resumedEntry?: { key: string; tabId: string; resumedAtMs: number };
}): Harness {
  let records = options.records;
  const conversations = new ConversationsStore({
    list: async () => records,
  });
  const uiState = new UiStateStore();
  let bootListener: ((sessionId: number) => void) | null = null;
  let key = options.resumedEntry?.key ?? "claude:orig";
  const rebindResumedTab = vi.fn((oldKey: string, newKey: string) => {
    if (key === oldKey) {
      key = newKey;
    }
  });
  // useSyncExternalStore compares by reference: one snapshot for the run.
  const snapshot = workspaceSnapshot();
  const controller = {
    attachments: {
      attach: vi.fn(),
      onError: vi.fn(() => () => undefined),
      close: vi.fn(),
    },
    getSnapshot: () => snapshot,
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
    reportCapturedConversation: vi.fn(),
    setFolderSearchHandler: vi.fn(),
    createTabWithCwd: vi.fn(async () => undefined),
    createTabViaNativeDialog: vi.fn(async () => undefined),
    mergeTabs: vi.fn(),
    popOutPane: vi.fn(),
    sessionDims: vi.fn(() => ({})),
    sessionCwd: vi.fn(() => CWD),
    resumeSession: vi.fn(async () => {
      bootListener?.(1);
      return { kind: "opened", tabId: "tab-1", sessionId: 1 };
    }),
    resumedSessionKeyForTab: vi.fn((tabId: string) =>
      tabId === "tab-1" ? key : null,
    ),
    resumedEntries: vi.fn(() =>
      options.resumedEntry ? [options.resumedEntry] : [],
    ),
    rebindResumedTab,
    setResumeBootListener: vi.fn(
      (listener: ((sessionId: number) => void) | null) => {
        bootListener = listener;
      },
    ),
  };
  return {
    workspace: {
      controller,
      client: { close: vi.fn() },
      conversations,
      uiState,
    } as unknown as BootstrappedWorkspace,
    conversations,
    uiState,
    setRecords(next) {
      records = next;
    },
    currentKey: () => key,
    rebindResumedTab,
    fireBoot: (sessionId) => bootListener?.(sessionId),
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

function pane(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    "[data-testid='workspace-terminal']",
  );
  expect(element).not.toBeNull();
  return element!;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("resume boot reveal (spec §4)", () => {
  it("marks the opened pane as booting and stamps its link", async () => {
    const fixture = harness({ records: [record()] });
    const { container, root } = await mountApp(fixture);

    expect(pane(container).getAttribute("data-chat-boot")).toBe("false");

    const resume = container.querySelector<HTMLButtonElement>(
      "[data-testid='sidebar-resume-first']",
    )!;
    await act(async () => resume.click());

    const element = pane(container);
    expect(element.getAttribute("data-chat-boot")).toBe("true");
    expect(element.getAttribute("data-chat-file")).toBe(
      "C:\\transcripts\\orig.jsonl",
    );
    // The link was stamped at resume time — no scan needed to make it stick.
    expect(fixture.uiState.getSnapshot().chatPanes?.["1"]?.link).toEqual({
      provider: "claude",
      id: "orig",
      filePath: "C:\\transcripts\\orig.jsonl",
      title: "Original conversation",
    });

    await act(async () => root.unmount());
  });
});

describe("transcript handoff (spec §4)", () => {
  it("rebinds the resumed tab to the successor and repoints the pane", async () => {
    // Adoption only happens within a short window of the resume, so the entry
    // must be recent by the real clock the App reads.
    const now = Date.now();
    const fixture = harness({
      records: [record()],
      resumedEntry: {
        key: "claude:orig",
        tabId: "tab-1",
        resumedAtMs: now - 5_000,
      },
    });
    const { container, root } = await mountApp(fixture);

    expect(pane(container).getAttribute("data-chat-file")).toBe(
      "C:\\transcripts\\orig.jsonl",
    );

    // `claude --resume` wrote a NEW transcript in the same folder, later than
    // the resume; the next scan must adopt it.
    const successor = record({
      id: "succ",
      title: "Resumed conversation",
      filePath: "C:\\transcripts\\succ.jsonl",
      updatedAtMs: now,
    });
    fixture.setRecords([record(), successor]);
    await act(async () => {
      await fixture.conversations.refresh(true);
    });

    expect(fixture.rebindResumedTab).toHaveBeenCalledWith(
      "claude:orig",
      "claude:succ",
    );
    const element = pane(container);
    expect(element.getAttribute("data-chat-file")).toBe(
      "C:\\transcripts\\succ.jsonl",
    );
    expect(element.getAttribute("data-chat-title")).toBe("Resumed conversation");
    // The successor link is persisted, so it survives a restart too.
    expect(fixture.uiState.getSnapshot().chatPanes?.["1"]?.link?.id).toBe(
      "succ",
    );

    await act(async () => root.unmount());
  });
});

describe("sticky links (spec §5)", () => {
  it("keeps the chat reachable from the remembered link when a scan is empty", async () => {
    const fixture = harness({ records: [] });
    fixture.uiState.update((current) =>
      setChatPaneState(current, "1", {
        mode: "terminal",
        density: "full",
        showThinking: true,
        link: {
          provider: "claude",
          id: "orig",
          filePath: "C:\\transcripts\\orig.jsonl",
          title: "Original conversation",
        },
      }),
    );
    const { container, root } = await mountApp(fixture);

    const element = pane(container);
    expect(element.getAttribute("data-chat-present")).toBe("true");
    expect(element.getAttribute("data-chat-file")).toBe(
      "C:\\transcripts\\orig.jsonl",
    );
    expect(element.getAttribute("data-chat-title")).toBe(
      "Original conversation",
    );
    // The palette is never without a list: with nothing learned yet, the
    // shipped seed commands ride along (v3 §2).
    expect(Number(element.getAttribute("data-chat-commands"))).toBeGreaterThan(0);

    await act(async () => root.unmount());
  });
});
