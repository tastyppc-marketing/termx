/**
 * Sidebar width drag handle and the full-screen Conversations control
 * (polish P5). Both are opt-in props: without them the sidebar renders
 * exactly as it always has.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationsStore } from "../../conversations/store";
import type { LlmSessionRecord } from "../../conversations/types";
import { DEFAULT_SETTINGS } from "../../settings/settings";
import type {
  SidebarTabModel,
  WorkspaceSnapshot,
} from "../../workspace/WorkspaceController";
import { Sidebar, type SidebarActions, type SidebarProps } from "../Sidebar";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

function rootTab(): SidebarTabModel {
  return {
    id: "tab-1",
    groupId: null,
    title: "powershell · one",
    color: "blue",
    fill: "off",
    primarySessionId: 1,
    sessionIds: [1],
    status: "live",
    activity: "idle",
    profile: "powershell",
    cwd: "C:\\one",
  };
}

function snapshot(): WorkspaceSnapshot {
  return {
    layout: {
      version: 3,
      auxWindows: {},
      windowNames: {},
      groups: {},
      rootItems: [{ kind: "tab", id: "tab-1" }],
      tabs: {
        "tab-1": {
          id: "tab-1",
          title: null,
          color: "blue",
          fill: "off",
          split: { kind: "pane", sessionId: 1 },
        },
      },
      activeTabId: "tab-1",
    },
    rootItems: [{ kind: "tab", tab: rootTab() }],
    ungroupedTabs: [rootTab()],
    groups: [],
    paneStates: { 1: { status: "live", exitCode: null } },
    activeTabId: "tab-1",
    activeSessionId: 1,
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
    createGroup: vi.fn(() => 'new-group'),
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

const RECORD: LlmSessionRecord = {
  provider: "claude",
  id: "a",
  title: "Parser work",
  cwd: "C:\\Dev\\TermX",
  filePath: "C:\\a.jsonl",
  updatedAtMs: 10,
  summary: null,
  recap: null,
};

async function renderSidebar(props: Partial<SidebarProps> = {}) {
  await act(async () => {
    root.render(<Sidebar snapshot={snapshot()} actions={actions()} {...props} />);
  });
}

function handle(): HTMLElement {
  const found = container.querySelector<HTMLElement>("[data-testid='sidebar-resize']");
  if (!found) {
    throw new Error("no resize handle");
  }
  return found;
}

function pointer(
  type: string,
  options: { x?: number; button?: number; pointerId?: number; isPrimary?: boolean } = {},
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: options.x ?? 0,
    clientY: 0,
    button: options.button ?? 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId ?? 3 },
    isPrimary: { value: options.isPrimary ?? true },
  });
  return event;
}

describe("Sidebar width", () => {
  it("renders no handle and no inline width without the resize props", async () => {
    await renderSidebar();

    expect(container.querySelector("[data-testid='sidebar-resize']")).toBeNull();
    expect(container.querySelector<HTMLElement>(".sidebar")!.style.width).toBe("");
  });

  it("applies a supplied width inline on the sidebar element", async () => {
    await renderSidebar({ width: 340, onResize: vi.fn() });

    const aside = container.querySelector<HTMLElement>(".sidebar")!;
    expect(aside.style.width).toBe("340px");
    expect(aside.style.flexBasis).toBe("340px");
    expect(handle().getAttribute("aria-label")).toBe("Resize sidebar");
  });

  it("reports clamped widths while dragging the handle", async () => {
    const onResize = vi.fn();
    await renderSidebar({ width: 300, onResize });

    await act(async () => handle().dispatchEvent(pointer("pointerdown", { x: 300 })));
    expect(handle().setPointerCapture).toHaveBeenCalledWith(3);

    await act(async () => handle().dispatchEvent(pointer("pointermove", { x: 360 })));
    expect(onResize).toHaveBeenLastCalledWith(360);

    // Past the ends of the range the report pins to the clamp, never beyond.
    await act(async () => handle().dispatchEvent(pointer("pointermove", { x: 900 })));
    expect(onResize).toHaveBeenLastCalledWith(480);
    await act(async () => handle().dispatchEvent(pointer("pointermove", { x: 0 })));
    expect(onResize).toHaveBeenLastCalledWith(200);

    await act(async () => handle().dispatchEvent(pointer("pointerup", { x: 0 })));
    expect(handle().releasePointerCapture).toHaveBeenCalledWith(3);

    // Released: further moves are not a drag any more.
    onResize.mockClear();
    await act(async () => handle().dispatchEvent(pointer("pointermove", { x: 500 })));
    expect(onResize).not.toHaveBeenCalled();
  });

  it("ignores non-primary and secondary-button presses on the handle", async () => {
    const onResize = vi.fn();
    await renderSidebar({ width: 300, onResize });

    await act(async () => handle().dispatchEvent(pointer("pointerdown", { x: 300, button: 2 })));
    await act(async () => handle().dispatchEvent(pointer("pointermove", { x: 360 })));
    await act(async () =>
      handle().dispatchEvent(pointer("pointerdown", { x: 300, isPrimary: false })));
    await act(async () => handle().dispatchEvent(pointer("pointermove", { x: 360 })));

    expect(onResize).not.toHaveBeenCalled();
  });

  it("resets to the default with null on a double-click", async () => {
    const onResize = vi.fn();
    await renderSidebar({ width: 420, onResize });

    await act(async () =>
      handle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));

    expect(onResize).toHaveBeenCalledWith(null);
  });

  it("nudges the width with the arrow keys from the handle", async () => {
    const onResize = vi.fn();
    await renderSidebar({ width: 300, onResize });

    await act(async () =>
      handle().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(onResize).toHaveBeenLastCalledWith(316);

    await act(async () =>
      handle().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(onResize).toHaveBeenLastCalledWith(284);
  });
});

describe("Sidebar full-screen control", () => {
  async function renderWithRail(props: Partial<SidebarProps> = {}) {
    const store = new ConversationsStore({
      list: vi.fn(async () => [RECORD]),
      debounceMs: 0,
    });
    await act(async () => {
      root.render(
        <Sidebar
          snapshot={snapshot()}
          actions={actions()}
          conversations={{
            store,
            settings: DEFAULT_SETTINGS,
            onResume: vi.fn(),
            onOpenTranscript: vi.fn(),
          }}
          {...props}
        />,
      );
    });
  }

  function expandButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      "[aria-label='Conversations full screen']",
    );
  }

  async function switchToConversations() {
    const button = [...container.querySelectorAll<HTMLButtonElement>(".sidebar__mode")]
      .find((candidate) => candidate.textContent?.trim() === "Conversations")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await act(async () => {});
  }

  it("stays hidden while the prop is unwired, even in conversations mode", async () => {
    await renderWithRail();
    expect(expandButton()).toBeNull();

    await switchToConversations();

    expect(container.querySelector(".conversations")).not.toBeNull();
    expect(expandButton()).toBeNull();
  });

  it("renders only in conversations mode when wired, and calls the callback", async () => {
    const onExpandConversations = vi.fn();
    await renderWithRail({ onExpandConversations });

    // Terminals mode: the rail is not on screen, so neither is its control.
    expect(expandButton()).toBeNull();

    await switchToConversations();

    const button = expandButton();
    expect(button).not.toBeNull();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onExpandConversations).toHaveBeenCalledTimes(1);
  });
});
