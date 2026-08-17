import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type TermxSettings } from "../../settings/settings";
import { ConversationsRail } from "../ConversationsRail";
import { ConversationsStore } from "../store";
import type { LlmSessionRecord, SessionLister } from "../types";

const NOW = 1_000_000_000;

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

function record(overrides: Partial<LlmSessionRecord> = {}): LlmSessionRecord {
  return {
    provider: "claude",
    id: "a",
    title: "Parser work",
    cwd: "C:\\Dev\\TermX",
    filePath: "C:\\a.jsonl",
    updatedAtMs: NOW - 60_000,
    summary: null,
    recap: null,
    ...overrides,
  };
}

async function renderRail(
  options: {
    rows?: LlmSessionRecord[];
    onSaveConversation?: (record: LlmSessionRecord) => void;
    settings?: Partial<TermxSettings>;
  } = {},
) {
  const rows = options.rows ?? [record()];
  const list = vi.fn<SessionLister>(async () => rows);
  const store = new ConversationsStore({
    list,
    debounceMs: 0,
    now: () => NOW,
    generateId: () => "f1",
  });
  const onResume = vi.fn();
  const onOpenTranscript = vi.fn();
  const settings: TermxSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  await act(async () => {
    root.render(
      <ConversationsRail
        store={store}
        settings={settings}
        onResume={onResume}
        onOpenTranscript={onOpenTranscript}
        debounceMs={0}
        nowMs={NOW}
        {...(options.onSaveConversation
          ? { onSaveConversation: options.onSaveConversation }
          : {})}
      />,
    );
  });
  await act(async () => {});
  return { store, onResume, onOpenTranscript };
}

function row(index = 0): HTMLElement {
  return Array.from(
    container.querySelectorAll<HTMLElement>(".conversations__rows .conversation-row"),
  )[index]!;
}

function saveButtons(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>("[data-testid='conversation-save']"),
  );
}

describe("ConversationsRail row save action", () => {
  it("renders no save action without the callback", async () => {
    await renderRail();
    await act(async () => row().click());

    expect(container.querySelector(".conversation-row__resume")).not.toBeNull();
    expect(saveButtons()).toHaveLength(0);
  });

  it("offers the save action on the selected row only", async () => {
    await renderRail({
      rows: [record({ id: "a" }), record({ id: "b", title: "Deploy script" })],
      onSaveConversation: vi.fn(),
    });
    expect(saveButtons()).toHaveLength(0);

    await act(async () => row(0).click());
    const buttons = saveButtons();
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe("Save");
    expect(buttons[0]!.getAttribute("aria-label")).toBe("Save Parser work");
    expect(buttons[0]!.closest(".conversation-row")).toBe(row(0));
  });

  it("fires the callback with the row's record and does not resume", async () => {
    const onSaveConversation = vi.fn();
    const { onResume } = await renderRail({ onSaveConversation });
    await act(async () => row().click());

    await act(async () => saveButtons()[0]!.click());
    expect(onSaveConversation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ provider: "claude", id: "a", cwd: "C:\\Dev\\TermX" }),
    );
    expect(onResume).not.toHaveBeenCalled();
  });

  it("cannot save a session whose folder was never recorded", async () => {
    const onSaveConversation = vi.fn();
    await renderRail({ rows: [record({ cwd: null })], onSaveConversation });
    await act(async () => row().click());

    const button = saveButtons()[0]!;
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(onSaveConversation).not.toHaveBeenCalled();
  });
});
