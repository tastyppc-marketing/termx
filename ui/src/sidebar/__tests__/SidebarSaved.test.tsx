/**
 * Sidebar "Saved" section (saved-sessions spec §"Resume flow"): gating by the
 * setting, row projection and order, resume on click, inline rename, and the
 * two-step delete that reuses the sidebar's destructive confirmation.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedSession } from "../../saved/types";
import { emptyLayout } from "../../state/layout";
import type { WorkspaceSnapshot } from "../../workspace/WorkspaceController";
import { Sidebar, type SidebarActions, type SidebarSaved } from "../Sidebar";

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

const ENTRIES: readonly SavedSession[] = [
  {
    id: "older",
    name: "OpenSEO audit",
    description: "Mid-audit, keyword pass done",
    cwd: "C:\\Users\\mjfos\\code\\open SEO",
    conversation: { provider: "codex", id: "abc-123", title: "Audit thread" },
    createdAtMs: 1,
    updatedAtMs: 100,
  },
  {
    id: "newer",
    name: "TermX daemon work",
    cwd: "C:\\Dev\\TermX",
    conversation: { provider: "claude", id: "def-456", title: "Daemon work" },
    createdAtMs: 2,
    updatedAtMs: 900,
  },
  {
    id: "bare",
    name: "Scratch shell",
    cwd: "C:\\Dev\\scratch",
    createdAtMs: 3,
    updatedAtMs: 500,
  },
];

function savedProps(overrides: Partial<SidebarSaved> = {}): {
  saved: SidebarSaved;
  onResume: ReturnType<typeof vi.fn>;
  onRename: ReturnType<typeof vi.fn>;
  onDescribe: ReturnType<typeof vi.fn>;
  onDelete: ReturnType<typeof vi.fn>;
} {
  const onResume = vi.fn();
  const onRename = vi.fn();
  const onDescribe = vi.fn();
  const onDelete = vi.fn();
  return {
    saved: {
      enabled: true,
      entries: ENTRIES,
      onResume,
      onRename,
      onDescribe,
      onDelete,
      ...overrides,
    },
    onResume,
    onRename,
    onDescribe,
    onDelete,
  };
}

async function renderSidebar(saved: SidebarSaved | undefined) {
  await act(async () =>
    root.render(
      <Sidebar
        snapshot={snapshot()}
        actions={actions()}
        {...(saved ? { saved } : {})}
      />,
    )
  );
}

function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-testid='saved-row']")];
}

function row(id: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-saved-id='${id}']`);
  if (!found) {
    throw new Error(`no saved row ${id}`);
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

function dialogButton(label: string): HTMLButtonElement {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>(".sidebar-dialog button"),
  ].find((candidate) => candidate.textContent === label);
  if (!found) {
    throw new Error(`no dialog button ${label}`);
  }
  return found;
}

async function click(element: Element): Promise<void> {
  await act(async () =>
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
  );
}

describe("Sidebar saved sessions section", () => {
  it("renders nothing when the caller wires no saved sessions", async () => {
    await renderSidebar(undefined);

    expect(container.querySelector("[data-testid='saved-section']")).toBeNull();
  });

  it("renders nothing when the sidebar list setting is off", async () => {
    const { saved } = savedProps({ enabled: false });
    await renderSidebar(saved);

    expect(container.querySelector("[data-testid='saved-section']")).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it("keeps the section with a one-line hint when nothing is saved yet", async () => {
    const { saved } = savedProps({ entries: [] });
    await renderSidebar(saved);

    expect(container.querySelector("[data-testid='saved-section']")).not.toBeNull();
    expect(rows()).toHaveLength(0);
    expect(container.querySelector(".sidebar-saved__empty")?.textContent).toContain(
      "Pin a terminal",
    );
  });

  it("lists the saved sessions most recently updated first", async () => {
    const { saved } = savedProps();
    await renderSidebar(saved);

    expect(rows().map((element) => element.dataset.savedId)).toEqual([
      "newer",
      "bare",
      "older",
    ]);
  });

  it("shows the name, the folder tail, and a provider badge only when a conversation is attached", async () => {
    const { saved } = savedProps();
    await renderSidebar(saved);

    const newer = row("newer");
    expect(newer.querySelector(".sidebar-saved__name")?.textContent).toBe(
      "TermX daemon work",
    );
    expect(newer.querySelector(".sidebar-saved__folder")?.textContent).toBe("TermX");
    expect(newer.querySelector(".sidebar-saved__badge")?.textContent).toBe("claude");
    expect(row("older").querySelector(".sidebar-saved__badge")?.textContent).toBe(
      "codex",
    );
    expect(row("bare").querySelector(".sidebar-saved__badge")).toBeNull();
    expect(row("bare").querySelector(".sidebar-saved__folder")?.textContent).toBe(
      "scratch",
    );
  });

  it("carries the description as the row's tooltip, falling back to the folder", async () => {
    const { saved } = savedProps();
    await renderSidebar(saved);

    expect(row("older").title).toBe("Mid-audit, keyword pass done");
    expect(row("bare").title).toBe("C:\\Dev\\scratch");
  });

  it("resumes the clicked entry", async () => {
    const { saved, onResume } = savedProps();
    await renderSidebar(saved);

    await click(row("bare"));

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume.mock.calls[0]![0]).toMatchObject({ id: "bare" });
  });

  it("resumes on Enter from the keyboard", async () => {
    const { saved, onResume } = savedProps();
    await renderSidebar(saved);

    await act(async () =>
      row("newer").dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      }))
    );

    expect(onResume.mock.calls[0]![0]).toMatchObject({ id: "newer" });
  });

  it("renames inline through the store instead of resuming", async () => {
    const { saved, onRename, onResume } = savedProps();
    await renderSidebar(saved);

    await click(button("Rename TermX daemon work"));
    const input = row("newer").querySelector<HTMLInputElement>("input.inline-rename")!;
    input.value = "TermX lane C";
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    );

    expect(onRename).toHaveBeenCalledWith("newer", "TermX lane C");
    expect(onResume).not.toHaveBeenCalled();
    // The editor closes once committed.
    expect(row("newer").querySelector("input.inline-rename")).toBeNull();
  });

  it("edits the description inline, and an empty commit clears it", async () => {
    const { saved, onDescribe, onResume } = savedProps();
    await renderSidebar(saved);

    await click(button("Edit description for TermX daemon work"));
    const input = row("newer").querySelector<HTMLInputElement>("input.inline-rename")!;
    input.value = "resume nightly";
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    );

    expect(onDescribe).toHaveBeenCalledWith("newer", "resume nightly");
    expect(onResume).not.toHaveBeenCalled();
    expect(row("newer").querySelector("input.inline-rename")).toBeNull();

    // Clearing: an empty commit still reaches the store (unlike a rename,
    // where blank cancels) — it is the only way to remove a description.
    await click(button("Edit description for TermX daemon work"));
    const again = row("newer").querySelector<HTMLInputElement>("input.inline-rename")!;
    again.value = "";
    await act(async () =>
      again.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    );
    expect(onDescribe).toHaveBeenLastCalledWith("newer", "");
  });

  it("deletes only after the confirmation is accepted", async () => {
    const { saved, onDelete, onResume } = savedProps();
    await renderSidebar(saved);

    await click(button("Delete Scratch shell"));
    expect(onResume).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    const dialog = container.querySelector(".sidebar-dialog")!;
    expect(dialog.getAttribute("aria-label")).toBe("Delete saved session");
    expect(dialog.querySelector("h2")?.textContent).toBe("Delete saved session?");
    expect(dialog.querySelector("p")?.textContent).toContain("Scratch shell");

    await click(dialogButton("Delete"));

    expect(onDelete).toHaveBeenCalledWith("bare");
    expect(container.querySelector(".sidebar-dialog")).toBeNull();
  });

  it("keeps the entry when the confirmation is cancelled", async () => {
    const { saved, onDelete } = savedProps();
    await renderSidebar(saved);

    await click(button("Delete Scratch shell"));
    await click(dialogButton("Cancel"));

    expect(onDelete).not.toHaveBeenCalled();
    expect(container.querySelector(".sidebar-dialog")).toBeNull();
  });
});
