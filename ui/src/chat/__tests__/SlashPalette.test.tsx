/**
 * The slash palette (chat v3 spec §2). It is pure presentation: it holds no
 * selection of its own, sends nothing, and cannot open or close itself — the
 * input box owns all of that. These tests hold it to exactly that.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlashPalette } from "../SlashPalette";
import type { SlashCommand } from "../slashCommands";

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
  container.remove();
});

const COMMANDS: readonly SlashCommand[] = [
  { name: "model", description: "Set the AI model for this session" },
  { name: "memory", description: "Edit the memory files" },
  { name: "mcp", description: "Manage MCP servers and connections" },
];

async function render(ui: React.ReactElement): Promise<void> {
  await act(async () => root.render(ui));
}

function palette(
  props: Partial<React.ComponentProps<typeof SlashPalette>> = {},
): React.ReactElement {
  return (
    <SlashPalette
      commands={COMMANDS}
      selectedIndex={0}
      onPick={() => undefined}
      onHover={() => undefined}
      {...props}
    />
  );
}

function rows(): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")];
}

/** React derives mouseenter from a delegated mouseover, so that is what a
 *  hover looks like from the DOM's side. */
async function hover(row: HTMLElement): Promise<void> {
  await act(async () => {
    row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
}

describe("SlashPalette", () => {
  it("lists the commands it was given, in order, with their descriptions", async () => {
    await render(palette());
    expect(rows().map((row) => row.textContent)).toEqual([
      "/modelSet the AI model for this session",
      "/memoryEdit the memory files",
      "/mcpManage MCP servers and connections",
    ]);
  });

  it("marks the selected row and only that row", async () => {
    await render(palette({ selectedIndex: 1 }));
    expect(rows().map((row) => row.getAttribute("aria-current"))).toEqual([
      "false",
      "true",
      "false",
    ]);
  });

  it("picks the full command name on click", async () => {
    const picked: string[] = [];
    await render(palette({ onPick: (name) => picked.push(name) }));
    const target = rows()[2];
    await act(async () => target?.click());
    expect(picked).toEqual(["/mcp"]);
  });

  it("reports a hovered row by index and picks nothing", async () => {
    const hovered: number[] = [];
    const picked: string[] = [];
    await render(
      palette({ onHover: (index) => hovered.push(index), onPick: (name) => picked.push(name) }),
    );
    const target = rows()[1];
    if (target) {
      await hover(target);
    }
    expect(hovered).toEqual([1]);
    expect(picked).toEqual([]);
  });

  it("says so when the query matched nothing", async () => {
    await render(palette({ commands: [] }));
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain("No matching commands");
  });

  it("keeps the selected row in view as the selection moves", async () => {
    const scrollIntoView = vi.fn();
    // jsdom leaves the method off entirely, so it is optional here.
    const prototype = HTMLElement.prototype as unknown as {
      scrollIntoView?: (arg?: unknown) => void;
    };
    const original = prototype.scrollIntoView;
    prototype.scrollIntoView = scrollIntoView;
    try {
      await render(palette({ selectedIndex: 0 }));
      await render(palette({ selectedIndex: 2 }));
      expect(scrollIntoView.mock.instances.at(-1)).toBe(rows()[2]);
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    } finally {
      if (original) {
        prototype.scrollIntoView = original;
      } else {
        delete prototype.scrollIntoView;
      }
    }
  });

  it("renders without a scrollIntoView to call", async () => {
    // jsdom does not implement it; neither does an unattached row.
    await expect(render(palette({ selectedIndex: 9 }))).resolves.toBeUndefined();
    expect(rows()).toHaveLength(3);
  });
});
