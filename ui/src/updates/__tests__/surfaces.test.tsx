import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateBanner } from "../UpdateBanner";
import { ForcedUpdateModal } from "../ForcedUpdateModal";
import { HostRestartBanner } from "../HostRestartBanner";
import { AboutDialog } from "../AboutDialog";
import type { UpdateResult, UpdateState } from "../types";

const paths = vi.hoisted(() => ({ appDataDir: vi.fn(), resourceDir: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: paths.appDataDir, resourceDir: paths.resourceDir }));

const result: UpdateResult = { status: "available", currentVersion: "0.2.0", latestVersion: "0.3.0", releaseTag: "v0.3.0", forced: false, hostChanged: false, sha256: "a".repeat(64), assetName: "TermX-Setup-0.3.0-x64.exe", notesUrl: "https://example.test/notes" };
let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  paths.appDataDir.mockReset().mockResolvedValue("C:\\Users\\me\\AppData\\Roaming\\TermX");
  paths.resourceDir.mockReset().mockResolvedValue("C:\\Program Files\\TermX");
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("UpdateBanner", () => {
  it("shows for a ready optional update and offers Install / Later", async () => {
    const onInstall = vi.fn(); const onLater = vi.fn(); const onNotes = vi.fn();
    const update: UpdateState = { kind: "ready", result, installerPath: "C:\\x.exe" };
    await act(async () => root.render(<UpdateBanner update={update} onInstall={onInstall} onLater={onLater} onNotes={onNotes} />));
    expect(host.textContent).toContain("TermX 0.3.0 is ready");
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="update-later"]')!.click());
    expect(onLater).toHaveBeenCalledOnce();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="update-install"]')!.click());
    expect(onInstall).toHaveBeenCalledOnce();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="update-notes"]')!.click());
    expect(onNotes).toHaveBeenCalledOnce();
  });
  it("renders nothing while downloading, for forced results, or when current", async () => {
    await act(async () => root.render(<UpdateBanner update={{ kind: "downloading", result }} onInstall={vi.fn()} onLater={vi.fn()} onNotes={vi.fn()} />));
    expect(host.textContent).toBe("");
    await act(async () => root.render(<UpdateBanner update={{ kind: "ready", result: { ...result, forced: true }, installerPath: "x" }} onInstall={vi.fn()} onLater={vi.fn()} onNotes={vi.fn()} />));
    expect(host.textContent).toBe("");
    await act(async () => root.render(<UpdateBanner update={{ kind: "checked", result: { ...result, status: "current" } }} onInstall={vi.fn()} onLater={vi.fn()} onNotes={vi.fn()} />));
    expect(host.textContent).toBe("");
  });
});

describe("ForcedUpdateModal", () => {
  it("cannot be dismissed and lists the sessions that will close when the host changed", async () => {
    const onInstall = vi.fn();
    const update: UpdateState = { kind: "ready", result: { ...result, forced: true, hostChanged: true }, installerPath: "x" };
    await act(async () => root.render(<ForcedUpdateModal update={update} sessionTitles={["build", "deploy"]} onInstall={onInstall} onNotes={vi.fn()} />));
    const dialog = host.querySelector<HTMLDivElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("TermX 0.3.0 is required");
    expect(dialog.textContent).toContain("build");
    expect(dialog.textContent).toContain("deploy");
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.querySelectorAll("button").length).toBe(2); // Update now + What's new
    const now = host.querySelector<HTMLButtonElement>('[data-testid="update-now"]')!;
    expect(now.textContent).toBe("Update now");
    await act(async () => now.click());
    expect(onInstall).toHaveBeenCalledOnce();
  });
  it("omits the session list when the host is unchanged and renders nothing for optional or current results", async () => {
    await act(async () => root.render(<ForcedUpdateModal update={{ kind: "ready", result: { ...result, forced: true }, installerPath: "x" }} sessionTitles={["build"]} onInstall={vi.fn()} onNotes={vi.fn()} />));
    expect(host.textContent).not.toContain("build");
    await act(async () => root.render(<ForcedUpdateModal update={{ kind: "ready", result, installerPath: "x" }} sessionTitles={[]} onInstall={vi.fn()} onNotes={vi.fn()} />));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.render(<ForcedUpdateModal update={{ kind: "checked", result: { ...result, status: "current", forced: true } }} sessionTitles={[]} onInstall={vi.fn()} onNotes={vi.fn()} />));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  it("shows the error inline and keeps its button while downloading fails", async () => {
    await act(async () => root.render(<ForcedUpdateModal update={{ kind: "error", message: "Sign in to GitHub with gh to get updates", result: { ...result, forced: true } }} sessionTitles={[]} onInstall={vi.fn()} onNotes={vi.fn()} />));
    expect(host.textContent).toContain("Sign in to GitHub");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="update-now"]')!.textContent).toBe("Retry");
  });
  it("disables the button while downloading or installing", async () => {
    await act(async () => root.render(<ForcedUpdateModal update={{ kind: "downloading", result: { ...result, forced: true } }} sessionTitles={[]} onInstall={vi.fn()} onNotes={vi.fn()} />));
    const now = host.querySelector<HTMLButtonElement>('[data-testid="update-now"]')!;
    expect(now.disabled).toBe(true); expect(now.textContent).toBe("Downloading…");
    await act(async () => root.render(<ForcedUpdateModal update={{ kind: "installing", result: { ...result, forced: true } }} sessionTitles={[]} onInstall={vi.fn()} onNotes={vi.fn()} />));
    expect(now.disabled).toBe(true); expect(now.textContent).toBe("Installing…");
  });
  it("traps Tab inside the dialog", async () => {
    await act(async () => root.render(<ForcedUpdateModal update={{ kind: "ready", result: { ...result, forced: true }, installerPath: "x" }} sessionTitles={[]} onInstall={vi.fn()} onNotes={vi.fn()} />));
    const buttons = host.querySelectorAll<HTMLButtonElement>("button");
    buttons[buttons.length - 1]!.focus();
    const dialog = host.querySelector<HTMLDivElement>('[role="dialog"]')!;
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(buttons[0]);
  });
});

describe("HostRestartBanner", () => {
  it("names the live count and restarts on click", async () => {
    const onRestart = vi.fn();
    await act(async () => root.render(<HostRestartBanner open liveCount={3} onRestart={onRestart} />));
    expect(host.textContent).toContain("Restart terminals to finish the update (3 will close)");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="host-restart"]')!.click());
    expect(onRestart).toHaveBeenCalledOnce();
  });
  it("renders nothing when closed and shows a restart error inline", async () => {
    await act(async () => root.render(<HostRestartBanner open={false} liveCount={3} onRestart={vi.fn()} />));
    expect(host.textContent).toBe("");
    await act(async () => root.render(<HostRestartBanner open liveCount={0} onRestart={vi.fn()} error="The daemon did not stop" />));
    expect(host.textContent).toContain("The daemon did not stop");
    expect(host.querySelector('[data-testid="host-restart"]')).not.toBeNull();
  });
});

describe("AboutDialog", () => {
  it("lists both versions and both folders, and closes on Escape", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(<AboutDialog open onClose={onClose} uiVersion="0.3.0" hostVersion="0.2.0" />));
    const dialog = host.querySelector<HTMLDivElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("0.3.0");
    expect(dialog.textContent).toContain("0.2.0");
    expect(dialog.textContent).toContain("C:\\Program Files\\TermX");
    expect(dialog.textContent).toContain("C:\\Users\\me\\AppData\\Roaming\\TermX");
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("says when the daemon is not connected and when a folder is unavailable, and renders nothing when closed", async () => {
    paths.resourceDir.mockRejectedValue(new Error("no runtime"));
    await act(async () => root.render(<AboutDialog open onClose={vi.fn()} uiVersion={undefined} hostVersion={null} />));
    expect(host.textContent).toContain("not connected");
    expect(host.textContent).toContain("unavailable");
    await act(async () => root.render(<AboutDialog open={false} onClose={vi.fn()} uiVersion="0.3.0" hostVersion={null} />));
    expect(host.textContent).toBe("");
  });
});
