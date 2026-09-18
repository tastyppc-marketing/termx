import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Welcome } from "../Welcome";
import { shouldShowWelcome } from "../shouldShowWelcome";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("shouldShowWelcome", () => {
  it("shows only on a brand-new machine with nothing running and no root", () => {
    expect(
      shouldShowWelcome({ settingsWasCreated: true, liveSessionCount: 0, workspaceRoot: null }),
    ).toBe(true);
    expect(
      shouldShowWelcome({ settingsWasCreated: false, liveSessionCount: 0, workspaceRoot: null }),
    ).toBe(false);
    expect(
      shouldShowWelcome({ settingsWasCreated: true, liveSessionCount: 2, workspaceRoot: null }),
    ).toBe(false);
    expect(
      shouldShowWelcome({ settingsWasCreated: true, liveSessionCount: 0, workspaceRoot: "C:\W" }),
    ).toBe(false);
  });
});

describe("Welcome", () => {
  it("disables Start until a folder is picked, then reports it", async () => {
    const onStart = vi.fn();
    const onSkip = vi.fn();
    const pickFolder = vi.fn().mockResolvedValue("C:\Work");
    await act(async () =>
      root.render(<Welcome open pickFolder={pickFolder} onStart={onStart} onSkip={onSkip} />),
    );
    const start = host.querySelector<HTMLButtonElement>('[data-testid="welcome-start"]')!;
    expect(start.disabled).toBe(true);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="welcome-choose"]')!.click(),
    );
    expect(host.querySelector('[data-testid="welcome-path"]')!.textContent).toBe("C:\Work");
    expect(start.disabled).toBe(false);
    await act(async () => start.click());
    expect(onStart).toHaveBeenCalledWith("C:\Work");
  });

  it("Skip reports without a folder and Escape does nothing", async () => {
    const onStart = vi.fn();
    const onSkip = vi.fn();
    await act(async () =>
      root.render(<Welcome open pickFolder={vi.fn()} onStart={onStart} onSkip={onSkip} />),
    );
    const dialog = host.querySelector<HTMLDivElement>('[role="dialog"]')!;
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onSkip).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="welcome-skip"]')!.click(),
    );
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("renders nothing when closed", async () => {
    await act(async () =>
      root.render(<Welcome open={false} pickFolder={vi.fn()} onStart={vi.fn()} onSkip={vi.fn()} />),
    );
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});
