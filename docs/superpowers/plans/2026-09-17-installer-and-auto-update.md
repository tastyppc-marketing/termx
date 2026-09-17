# TermX Installer + Auto-Update + First-Run Workspace Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a one-click NSIS installer from private GitHub releases, an in-app updater with optional and forced channels that installs silently and relaunches, a first-run workspace-root welcome screen, and a one-command release pipeline.

**Architecture:** The existing `gh`-CLI-based update checker in `ui/src-tauri/src/updates.rs` grows download, digest verification and silent-install commands; the React hook `useUpdates` grows the download/ready/installing states and drives a banner (optional) or an undismissable modal (forced). The Tauri bundler ships the host daemon and output helper as `externalBin`; an NSIS hook renames the running daemon aside so the installer never has to kill terminals. Versions are synced by one script and guarded by one test; a GitHub Actions workflow builds and publishes on `v*` tags.

**Tech Stack:** Rust (Tauri 2.11, semver, sha2, tempfile), TypeScript/React 19, Vitest, NSIS via Tauri bundler, PowerShell 5.1 scripts, GitHub Actions (windows-latest), `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-09-17-installer-and-auto-update-design.md`

## Global Constraints

- Repository for releases: `tastyppc-marketing/termx` (already `REPOSITORY` in `updates.rs`). Private. Never store a token in the app; every network call goes through a `gh` subprocess.
- Release asset name, exact: `TermX-Setup-<version>-x64.exe`. Tag: `v<version>`. Stable semver only.
- Release body machine lines, one per line, anchored at line start, case-insensitive: `termx-update: force`, `termx-sha256: <64 hex>`, `termx-host: changed`. A release without a sha256 line never qualifies.
- Forced floor: `forced` is true when ANY qualifying release newer than the running version is forced. `hostChanged` aggregates the same way.
- Four version fields must stay identical: `ui/src-tauri/tauri.conf.json`, `ui/package.json`, `ui/src-tauri/Cargo.toml`, `host/Cargo.toml`. Only `tools/version.ps1` changes them.
- No absolute machine paths in any project file or script. Scripts derive paths from `$PSScriptRoot`.
- Gates from `C:\Dev\TermX\ui`: `npx tsc -p tsconfig.app.json --noEmit --incremental false` and `npx vitest run` (vitest run from the repo root false-fails). Rust: `cargo test` inside `ui/src-tauri` (this crate is NOT in the root workspace) and `cargo test --workspace` at the root.
- Agents never commit, never start or kill TermX / termx-host, never touch `dist-portable\`. The main thread gates and commits.
- New Tauri commands need all three registrations: `lib.rs` `generate_handler!`, `build.rs` command list, `capabilities/default.json` `allow-<kebab-name>`.
- Copy in UI strings: plain, active, no em-dashes.

---

## File structure

| File | Responsibility |
|---|---|
| `tools/version.ps1` (new) | Rewrite the four version fields (+ package-lock root) |
| `tools/release.ps1` (new) | Local release cut: guard, version, notes, commit, tag, push |
| `ui/src/__tests__/versionSync.test.ts` (new) | Fail when versions differ |
| `ui/src/settings/settings.ts`, `sections.ts`, `SettingsSurface.tsx` | `workspaceRoot`, `updatePolicy` fields + controls |
| `ui/src/workspace/scopePaths.ts` | `newTabCwdCandidates(..., workspaceRoot)` |
| `ui/src/workspace/WorkspaceController.ts` | Pass workspaceRoot; picker default path; expose `hostVersion`; `restartHost()` |
| `ui/src/settings/SettingsStore.ts` | `wasCreated` flag |
| `ui/src/welcome/Welcome.tsx` (+ `.css`, test) (new) | First-run modal |
| `ui/src-tauri/src/updates.rs` | Selection (installer asset, body markers), download+verify, install argv, commands |
| `ui/src-tauri/src/cleanup.rs` (new) | Delete `*.old` beside the exe at startup |
| `ui/src/updates/types.ts`, `useUpdates.ts`, `useUpdates.test.tsx` | Extended result/state, download/install, launch auto-install, snooze |
| `ui/src/updates/UpdateBanner.tsx`, `ForcedUpdateModal.tsx`, `HostRestartBanner.tsx`, `AboutDialog.tsx` (+ css, tests) (new) | Surfaces |
| `ui/src/workspace/uiState.ts` | `updates: { lastCheckAt, snoozedVersion }` |
| `ui/src/statusbar/StatusBar.tsx` | "ready" label |
| `ui/src/menubar/menus.ts`, `Menubar.tsx` | "About TermX…" row |
| `ui/src/App.tsx` | Wiring |
| `ui/src-tauri/tauri.conf.json`, `ui/src-tauri/nsis/hooks.nsh` (new), `.gitignore` | Bundle |
| `ui/src-tauri/src/bootstrap.rs` | `termx-output` triple name candidate |
| `.github/workflows/release.yml` (new) | CI build + publish |
| `docs/RELEASE.md`, `docs/updates.md` (new) | Docs |

---

### Task 1: Version sync script and guard test

**Files:**
- Create: `tools/version.ps1`
- Create: `ui/src/__tests__/versionSync.test.ts`

**Interfaces:**
- Produces: `tools/version.ps1 -Version X.Y.Z` (exit 0 on success, 1 on bad input). Test `versionSync` reads the four files relative to `ui/`.

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/__tests__/versionSync.test.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const UI = resolve(__dirname, "..", "..");
const ROOT = resolve(UI, "..");

function cargoVersion(path: string): string {
  const match = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(path, "utf8"));
  if (!match) throw new Error(`no version in ${path}`);
  return match[1];
}

describe("version sync", () => {
  it("declares one version everywhere", () => {
    const conf = JSON.parse(readFileSync(resolve(UI, "src-tauri", "tauri.conf.json"), "utf8")) as { version: string };
    const pkg = JSON.parse(readFileSync(resolve(UI, "package.json"), "utf8")) as { version: string };
    const versions = {
      tauriConf: conf.version,
      packageJson: pkg.version,
      uiCargo: cargoVersion(resolve(UI, "src-tauri", "Cargo.toml")),
      hostCargo: cargoVersion(resolve(ROOT, "host", "Cargo.toml")),
    };
    expect(new Set(Object.values(versions)).size, JSON.stringify(versions)).toBe(1);
    expect(versions.tauriConf).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Run it (passes today because all four are 0.2.0; prove it detects drift)**

Run from `ui/`: `npx vitest run src/__tests__/versionSync.test.ts`
Expected: PASS. Then temporarily edit `host/Cargo.toml` version to `0.2.1`, rerun, expected FAIL naming the four values; revert the edit.

- [ ] **Step 3: Write the script**

```powershell
# tools/version.ps1 — the only way TermX's version changes.
param([Parameter(Mandatory = $true)][string]$Version)
$ErrorActionPreference = "Stop"
if ($Version -notmatch '^\d+\.\d+\.\d+$') { Write-Error "Version must be X.Y.Z (got '$Version')"; exit 1 }
$root = Split-Path -Parent $PSScriptRoot

function Set-Json([string]$path) {
  $text = Get-Content -Raw -LiteralPath $path
  $updated = [regex]::Replace($text, '("version"\s*:\s*")[^"]+(")', "`${1}$Version`${2}", 1)
  if ($updated -eq $text) { Write-Error "no version field in $path"; exit 1 }
  [IO.File]::WriteAllText($path, $updated)
}
function Set-Cargo([string]$path) {
  $text = Get-Content -Raw -LiteralPath $path
  $updated = [regex]::Replace($text, '(?m)^(version\s*=\s*")[^"]+(")', "`${1}$Version`${2}", 1)
  if ($updated -eq $text) { Write-Error "no version field in $path"; exit 1 }
  [IO.File]::WriteAllText($path, $updated)
}

Set-Json (Join-Path $root "ui\src-tauri\tauri.conf.json")
Set-Json (Join-Path $root "ui\package.json")
$lock = Join-Path $root "ui\package-lock.json"
if (Test-Path -LiteralPath $lock) {
  # Root version appears twice at the top of package-lock (root + packages[""]).
  $text = Get-Content -Raw -LiteralPath $lock
  $updated = [regex]::Replace($text, '("version"\s*:\s*")[^"]+(")', "`${1}$Version`${2}", 2)
  [IO.File]::WriteAllText($lock, $updated)
}
Set-Cargo (Join-Path $root "ui\src-tauri\Cargo.toml")
Set-Cargo (Join-Path $root "host\Cargo.toml")
Write-Host "TermX version set to $Version in 4 manifests"
```

- [ ] **Step 4: Verify the script round-trips**

Run: `powershell -NoProfile -File tools\version.ps1 -Version 0.2.0` from the repo root, then `git diff --stat` — expected: no diff (already 0.2.0). Run again with `0.9.9`, expected: four files changed (plus package-lock); run vitest test → PASS; then `powershell -NoProfile -File tools\version.ps1 -Version 0.2.0` to restore and `git diff --stat` → empty. Note: Cargo.lock files are NOT touched by the script; `cargo build` rewrites them on the next build, and `release.ps1` (Task 11) runs a `cargo update -w` so the lock files are committed with the version bump.

- [ ] **Step 5: Report hashes** (agents report `git hash-object` of both files; main thread gates and commits: `feat(release): version sync script + guard test`).

---

### Task 2: Settings fields `workspaceRoot` and `updatePolicy`

**Files:**
- Modify: `ui/src/settings/settings.ts` (interface ~line 64, defaults ~line 133, parse ~line 200)
- Modify: `ui/src/settings/sections.ts:35-39`
- Modify: `ui/src/settings/SettingsSurface.tsx` (`SettingsControl` switch ~line 425; props ~line 64)
- Test: `ui/src/settings/__tests__/settings.test.ts` (exists; add cases), `ui/src/settings/__tests__/sections.test.ts` (exists; will pass once fields are placed)

**Interfaces:**
- Produces: `TermxSettings.workspaceRoot: string | null` (default null), `TermxSettings.updatePolicy: UpdatePolicy` where `export const UPDATE_POLICIES = ["auto", "ask"] as const` (default `"auto"`). `SettingsSurfaceProps.pickFolder?: FolderPicker` (from `ui/src/native/dialog.ts`).

- [ ] **Step 1: Write failing tests** (append to `ui/src/settings/__tests__/settings.test.ts`)

```ts
import { DEFAULT_SETTINGS, parseSettings, serializeSettings } from "../settings";

describe("workspaceRoot and updatePolicy", () => {
  it("default to null and auto", () => {
    expect(DEFAULT_SETTINGS.workspaceRoot).toBeNull();
    expect(DEFAULT_SETTINGS.updatePolicy).toBe("auto");
  });
  it("round-trip a chosen root and policy", () => {
    const text = serializeSettings({ ...DEFAULT_SETTINGS, workspaceRoot: "C:\\Work", updatePolicy: "ask" });
    const parsed = parseSettings(text);
    expect(parsed.workspaceRoot).toBe("C:\\Work");
    expect(parsed.updatePolicy).toBe("ask");
  });
  it("reject junk without touching the rest", () => {
    const parsed = parseSettings(JSON.stringify({ workspaceRoot: 42, updatePolicy: "yolo", theme: DEFAULT_SETTINGS.theme }));
    expect(parsed.workspaceRoot).toBeNull();
    expect(parsed.updatePolicy).toBe("auto");
  });
  it("caps an absurd root at 1024 chars by falling back to null", () => {
    expect(parseSettings(JSON.stringify({ workspaceRoot: "x".repeat(1025) })).workspaceRoot).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run from `ui/`: `npx vitest run src/settings` — expected: the new cases fail on missing fields (TypeScript compile errors count as failure here).

- [ ] **Step 3: Implement in `settings.ts`**

Add near the other option lists:

```ts
export const UPDATE_POLICIES = ["auto", "ask"] as const;
export type UpdatePolicy = (typeof UPDATE_POLICIES)[number];
export const WORKSPACE_ROOT_MAX = 1024;
```

Add to `TermxSettings` (first two entries, before `newTabPolicy`):

```ts
  /** Folder every new terminal starts in when nothing else decides. Null until the user picks one. */
  readonly workspaceRoot: string | null;
  /** "auto": optional updates download in the background and install at the next launch. "ask": offer only. Forced updates ignore this. */
  readonly updatePolicy: UpdatePolicy;
```

Defaults: `workspaceRoot: null, updatePolicy: "auto",`. Validators:

```ts
function isUpdatePolicy(value: unknown): value is UpdatePolicy {
  return (UPDATE_POLICIES as readonly unknown[]).includes(value);
}
function parseWorkspaceRoot(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= WORKSPACE_ROOT_MAX ? value : null;
}
```

In `parseSettings` return object add:

```ts
    workspaceRoot: parseWorkspaceRoot(record.workspaceRoot),
    updatePolicy: isUpdatePolicy(record.updatePolicy) ? record.updatePolicy : DEFAULT_SETTINGS.updatePolicy,
```

- [ ] **Step 4: Place the fields in `sections.ts`**

```ts
  {
    id: "general",
    label: "General",
    fields: ["workspaceRoot", "updatePolicy", "onWindowClose", "sleepHiddenTerminals"],
  },
```

- [ ] **Step 5: Render the controls in `SettingsSurface.tsx`**

Add `pickFolder?: FolderPicker` to `SettingsSurfaceProps` (import `type FolderPicker` from `"../native/dialog"`), thread it to `SettingsControl` as a prop, and add two cases:

```tsx
    case "workspaceRoot":
      return (
        <div>
          <div className="settings-row">
            <span className="settings-row__label">Workspace folder</span>
            <span className="settings-row__value" data-testid="workspace-root-value">
              {settings.workspaceRoot ?? "Not set"}
            </span>
            <button
              type="button"
              className="settings-row__button"
              disabled={!pickFolder}
              onClick={() => {
                void pickFolder?.({ title: "Choose your workspace folder", ...(settings.workspaceRoot ? { defaultPath: settings.workspaceRoot } : {}) })
                  .then((picked) => { if (picked) onChange({ workspaceRoot: picked }); });
              }}
            >
              Choose…
            </button>
            {settings.workspaceRoot ? (
              <button type="button" className="settings-row__button" onClick={() => onChange({ workspaceRoot: null })}>Clear</button>
            ) : null}
          </div>
          <p className="settings-section__note">New terminals open here unless a tab or group already has a folder.</p>
        </div>
      );
    case "updatePolicy":
      return (
        <RadioLadder
          name="updatePolicy"
          title="Optional updates"
          options={UPDATE_POLICY_OPTIONS}
          value={settings.updatePolicy}
          onPick={(value) => onChange({ updatePolicy: value })}
        />
      );
```

with, next to `POLICY_OPTIONS`:

```ts
const UPDATE_POLICY_OPTIONS: ReadonlyArray<LadderOption<UpdatePolicy>> = [
  { value: "auto", label: "Install at next launch", hint: "Downloads in the background; installs when you next open TermX." },
  { value: "ask", label: "Ask me", hint: "Shows the update and waits for you to click Install." },
];
```

Add `.settings-row__value { flex: 1; opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }` and `.settings-row__button { margin-left: 8px; }` to `SettingsSurface.css` if no equivalent exists.

- [ ] **Step 6: Run tests**

Run from `ui/`: `npx vitest run src/settings` — expected PASS including `sections.test.ts`. Then `npx tsc -p tsconfig.app.json --noEmit --incremental false` — expected 0 errors (fix any `TermxSettings` fixture literals in tests that now miss the two fields by spreading `DEFAULT_SETTINGS`).

- [ ] **Step 7: Report hashes** (main thread commits: `feat(settings): workspaceRoot + updatePolicy`).

---

### Task 3: Workspace root drives new-tab cwd and the folder pickers

**Files:**
- Modify: `ui/src/workspace/scopePaths.ts:78-103`
- Modify: `ui/src/workspace/WorkspaceController.ts` (`createTab` ~1537, `createTabViaNativeDialog` ~1636, second `pickFolderAndCreateSession` call ~2456)
- Test: `ui/src/workspace/__tests__/scopePaths.test.ts`

**Interfaces:**
- Consumes: `settings.workspaceRoot` (Task 2).
- Produces: `newTabCwdCandidates(state, key, policy, activeTabCwd, workspaceRoot: string | null)`.

- [ ] **Step 1: Failing tests** (append to `scopePaths.test.ts`)

```ts
  it("every policy falls back on the workspace root before the host default", () => {
    const state = reportScopeCwd(EMPTY_SCOPE_PATHS, "g1", "C:\\Active");
    expect(newTabCwdCandidates(state, "g1", "group-active", null, "C:\\Root")).toEqual(["C:\\Active", "C:\\Root", null]);
    expect(newTabCwdCandidates(EMPTY_SCOPE_PATHS, "g1", "first-terminal", null, "C:\\Root")).toEqual(["C:\\Root", null]);
    expect(newTabCwdCandidates(EMPTY_SCOPE_PATHS, "g1", "active-tab", null, "C:\\Root")).toEqual(["C:\\Root", null]);
  });
  it("dedupes the root against an equal active path", () => {
    const state = reportScopeCwd(EMPTY_SCOPE_PATHS, "g1", "c:\\root");
    expect(newTabCwdCandidates(state, "g1", "group-active", null, "C:\\ROOT")).toEqual(["c:\\root", null]);
  });
```

Update the four existing calls in that file to pass a fifth argument `null`.

- [ ] **Step 2: Run** `npx vitest run src/workspace/__tests__/scopePaths.test.ts` — expected FAIL (arity).

- [ ] **Step 3: Implement**

```ts
export function newTabCwdCandidates(
  state: ScopePathsState,
  key: ScopeKey,
  policy: Exclude<NewTabPolicy, "ask-searcher" | "ask-native">,
  activeTabCwd: string | null,
  workspaceRoot: string | null,
): ReadonlyArray<string | null> {
  const chain: Array<string | null> = [];
  if (policy === "active-tab") chain.push(activeTabCwd);
  if (policy === "active-tab" || policy === "group-active") chain.push(state.active[key] ?? null);
  chain.push(state.seeds[key] ?? null, workspaceRoot, null);
  // (dedupe block unchanged)
```

In `WorkspaceController.createTab` pass `settings.workspaceRoot` as the fifth argument. In `createTabViaNativeDialog` and the other `pickFolderAndCreateSession` call site, pass the picker options through: find the call and add `defaultPath` when `this.settings.getSnapshot().workspaceRoot` is set. Look at `pickFolderAndCreateSession` (`ui/src/workspace/*.ts`, imported at line 11) and extend its options type with `pickOptions?: PickFolderOptions` forwarded to `pickFolder(options)`; keep both call sites identical.

- [ ] **Step 4: Run** `npx vitest run src/workspace` and `npx tsc -p tsconfig.app.json --noEmit --incremental false` — expected PASS / 0 errors.

- [ ] **Step 5: Report hashes** (commit: `feat(workspace): workspace root as the new-tab fallback folder`).

---

### Task 4: First-run welcome screen

**Files:**
- Modify: `ui/src/settings/SettingsStore.ts` (add `wasCreated`)
- Modify: `ui/src/workspace/bootstrapWorkspace.ts:403-406` (nothing beyond letting the flag through)
- Create: `ui/src/welcome/Welcome.tsx`, `ui/src/welcome/Welcome.css`, `ui/src/welcome/__tests__/Welcome.test.tsx`, `ui/src/welcome/shouldShowWelcome.ts`
- Modify: `ui/src/App.tsx` (render near `<CloseGuard>` ~line 1809)

**Interfaces:**
- Consumes: `SettingsStore`, `FolderPicker`, `controller.createTab`.
- Produces: `SettingsStore.wasCreated: boolean` (true when the read returned null); `shouldShowWelcome({ settingsWasCreated, liveSessionCount, workspaceRoot }): boolean`; `<Welcome open pickFolder onStart(root) onSkip />`.

- [ ] **Step 1: Failing tests**

```ts
// ui/src/welcome/__tests__/Welcome.test.tsx
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Welcome } from "../Welcome";
import { shouldShowWelcome } from "../shouldShowWelcome";

let root: Root; let host: HTMLDivElement;
beforeEach(() => { (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("shouldShowWelcome", () => {
  it("shows only on a brand-new machine with nothing running and no root", () => {
    expect(shouldShowWelcome({ settingsWasCreated: true, liveSessionCount: 0, workspaceRoot: null })).toBe(true);
    expect(shouldShowWelcome({ settingsWasCreated: false, liveSessionCount: 0, workspaceRoot: null })).toBe(false);
    expect(shouldShowWelcome({ settingsWasCreated: true, liveSessionCount: 2, workspaceRoot: null })).toBe(false);
    expect(shouldShowWelcome({ settingsWasCreated: true, liveSessionCount: 0, workspaceRoot: "C:\\W" })).toBe(false);
  });
});

describe("Welcome", () => {
  it("disables Start until a folder is picked, then reports it", async () => {
    const onStart = vi.fn(); const onSkip = vi.fn();
    const pickFolder = vi.fn().mockResolvedValue("C:\\Work");
    await act(async () => root.render(<Welcome open pickFolder={pickFolder} onStart={onStart} onSkip={onSkip} />));
    const start = host.querySelector<HTMLButtonElement>('[data-testid="welcome-start"]')!;
    expect(start.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="welcome-choose"]')!.click());
    expect(host.querySelector('[data-testid="welcome-path"]')!.textContent).toBe("C:\\Work");
    expect(start.disabled).toBe(false);
    await act(async () => start.click());
    expect(onStart).toHaveBeenCalledWith("C:\\Work");
  });
  it("Skip reports without a folder and Escape does nothing", async () => {
    const onStart = vi.fn(); const onSkip = vi.fn();
    await act(async () => root.render(<Welcome open pickFolder={vi.fn()} onStart={onStart} onSkip={onSkip} />));
    const dialog = host.querySelector<HTMLDivElement>('[role="dialog"]')!;
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onSkip).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="welcome-skip"]')!.click());
    expect(onSkip).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/welcome` — expected FAIL (modules missing).

- [ ] **Step 3: Implement**

`SettingsStore.ts`: add `readonly wasCreated: boolean;` set from a new option `wasCreated?: boolean` (default false); in `loadSettingsStore` pass `wasCreated: text === null`.

```ts
// ui/src/welcome/shouldShowWelcome.ts
export function shouldShowWelcome(input: { settingsWasCreated: boolean; liveSessionCount: number; workspaceRoot: string | null }): boolean {
  return input.settingsWasCreated && input.liveSessionCount === 0 && input.workspaceRoot === null;
}
```

```tsx
// ui/src/welcome/Welcome.tsx
import { useEffect, useRef, useState } from "react";
import type { FolderPicker } from "../native/dialog";
import "./Welcome.css";

export interface WelcomeProps {
  open: boolean;
  pickFolder: FolderPicker;
  onStart(root: string): void;
  onSkip(): void;
}

/** First-run modal: pick the workspace folder. Not dismissable by Escape or backdrop; Skip is the explicit way out. */
export function Welcome({ open, pickFolder, onStart, onSkip }: WelcomeProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  useEffect(() => { if (open) ref.current?.focus(); }, [open]);
  if (!open) return null;
  return (
    <div className="welcome-backdrop">
      <div ref={ref} className="welcome" role="dialog" aria-modal="true" aria-label="Welcome to TermX" tabIndex={-1}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); } }}>
        <h1 className="welcome__title">Welcome to TermX</h1>
        <p className="welcome__body">Pick the folder your work lives in. New terminals open there. You can change it any time in Settings.</p>
        <div className="welcome__row">
          <span className="welcome__path" data-testid="welcome-path">{root ?? "No folder chosen"}</span>
          <button type="button" data-testid="welcome-choose" onClick={() => { void pickFolder({ title: "Choose your workspace folder" }).then((picked) => { if (picked) setRoot(picked); }); }}>Choose folder…</button>
        </div>
        <div className="welcome__actions">
          <button type="button" data-testid="welcome-skip" onClick={onSkip}>Skip</button>
          <button type="button" className="welcome__primary" data-testid="welcome-start" disabled={root === null} onClick={() => { if (root) onStart(root); }}>Start</button>
        </div>
        <p className="welcome__hint">Updates come from GitHub. Run <code>gh auth login</code> once so TermX can fetch them.</p>
      </div>
    </div>
  );
}
```

`Welcome.css`: copy the backdrop/dialog rules from `ui/src/close/CloseGuard.css` under the `welcome-*` names (same tokens, max-width 480px, `.welcome__path` ellipsis, `.welcome__primary` uses the accent variables the CloseGuard primary button uses).

`App.tsx`: compute `const liveSessionCount = Object.values(snapshot.paneStates).filter((p) => p.status === "live").length;` (check the `PaneSessionState` shape at `WorkspaceController.ts` and use its live discriminator); `const [welcomeOpen, setWelcomeOpen] = useState(() => shouldShowWelcome({ settingsWasCreated: settingsStore.wasCreated, liveSessionCount: 0, workspaceRoot: settings.workspaceRoot }));` evaluated once at mount, and render:

```tsx
<Welcome open={welcomeOpen} pickFolder={pickNativeFolder}
  onStart={(root) => { settingsStore.update({ workspaceRoot: root }); setWelcomeOpen(false); void controller.createTab({ groupId: null, profile: null }); }}
  onSkip={() => { settingsStore.update({ updatePolicy: settings.updatePolicy }); setWelcomeOpen(false); }} />
```

Skip must still create `settings_v1.json` so the screen never returns: `SettingsStore.update` ignores no-op patches, so add a `SettingsStore.touch(): void` method that runs the save chain with the current serialized settings, and call `settingsStore.touch()` in `onSkip` instead of the fake patch. Test `touch` in `ui/src/settings/__tests__/SettingsStore.test.ts` (exists): after `touch()`, `flush()` resolves and the injected `save` was called once with `serializeSettings(current)`.

- [ ] **Step 4: Run** `npx vitest run src/welcome src/settings` and tsc — expected PASS / 0.

- [ ] **Step 5: Report hashes** (commit: `feat(welcome): first-run workspace folder screen`).

---

### Task 5: Release selection for installers, body markers, forced floor (Rust)

**Files:**
- Modify: `ui/src-tauri/src/updates.rs` (`Release`, `select_release`, `UpdateResult`, tests)

**Interfaces:**
- Produces: `UpdateResult { status, current_version, latest_version, release_tag, forced: bool, host_changed: bool, sha256: Option<String>, asset_name: Option<String>, notes_url: Option<String> }` (serde camelCase). `fn parse_markers(body: &str) -> Markers { forced, host_changed, sha256: Option<String> }`. `fn installer_asset_name(version: &Version) -> String`.

- [ ] **Step 1: Failing tests** (replace the `release()` fixture and add cases inside `mod tests`)

```rust
    fn release(version: &str) -> Value {
        json!({"tag_name":format!("v{version}"),"draft":false,"prerelease":false,
            "body":format!("termx-sha256: {}\nNotes.", "a".repeat(64)),
            "assets":[{"name":format!("TermX-Setup-{version}-x64.exe"),"size":1234,"state":"uploaded"}]})
    }
    #[test]
    fn markers_parse_case_insensitively_at_line_start() {
        let m = parse_markers("Intro\nTERMX-UPDATE: Force\n  termx-host: changed\ntermx-sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n");
        assert!(m.forced);
        assert!(!m.host_changed, "indented line does not count");
        assert_eq!(m.sha256.as_deref(), Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"));
        assert!(parse_markers("termx-sha256: short").sha256.is_none());
    }
    #[test]
    fn forced_and_host_changed_aggregate_over_every_newer_release() {
        let mut forced_mid = release("0.3.1");
        forced_mid["body"] = json!(format!("termx-update: force\ntermx-host: changed\ntermx-sha256: {}", "b".repeat(64)));
        let result = check(vec![release("0.3.0"), forced_mid, release("0.3.2")], "0.3.0").unwrap();
        assert_eq!(result.release_tag.as_deref(), Some("v0.3.2"));
        assert!(result.forced);
        assert!(result.host_changed);
        assert_eq!(result.sha256.as_deref(), Some(&"a".repeat(64)));
        assert_eq!(result.asset_name.as_deref(), Some("TermX-Setup-0.3.2-x64.exe"));
        assert_eq!(result.notes_url.as_deref(), Some("https://github.com/tastyppc-marketing/termx/releases/tag/v0.3.2"));
        // A forced release at or below the running version does not force.
        let older = check(vec![release("0.3.0"), release("0.3.1")], "0.3.1").unwrap();
        assert!(!older.forced);
    }
    #[test]
    fn a_release_without_a_digest_never_qualifies() {
        let mut nodigest = release("0.4.0");
        nodigest["body"] = json!("no markers");
        assert_eq!(check(vec![nodigest], "0.2.0").unwrap().status, "no-release");
    }
```

Update `ignores_unfinished_unstable_or_incomplete_packages`: `lone_exe` name → `"TermX.exe"`, `wrong_arch` name → `"TermX-Setup-0.6.0-arm64.exe"`.

- [ ] **Step 2: Run** `cargo test` in `ui/src-tauri` — expected FAIL (missing fields/functions).

- [ ] **Step 3: Implement**

```rust
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    status: &'static str,
    current_version: String,
    latest_version: Option<String>,
    release_tag: Option<String>,
    forced: bool,
    host_changed: bool,
    sha256: Option<String>,
    asset_name: Option<String>,
    notes_url: Option<String>,
}

#[derive(Deserialize)]
struct Release { tag_name: String, draft: bool, prerelease: bool, #[serde(default)] body: String, assets: Vec<Asset> }

#[derive(Debug, Default, PartialEq)]
struct Markers { forced: bool, host_changed: bool, sha256: Option<String> }

fn parse_markers(body: &str) -> Markers {
    let mut m = Markers::default();
    for line in body.lines() {
        let lower = line.to_ascii_lowercase();
        if lower == "termx-update: force" { m.forced = true; }
        else if lower == "termx-host: changed" { m.host_changed = true; }
        else if let Some(rest) = lower.strip_prefix("termx-sha256:") {
            let hex = rest.trim();
            if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) && m.sha256.is_none() { m.sha256 = Some(hex.to_owned()); }
        }
    }
    m
}

fn installer_asset_name(version: &Version, arch: &str) -> String { format!("TermX-Setup-{version}-{arch}.exe") }
```

`select_release`: collect `(version, tag, markers)` for every qualifying release (asset present AND `markers.sha256.is_some()`), pick the max by precedence for `latest`, and compute `forced = qualifying.iter().any(|(v, _, m)| v > current && m.forced)` and `host_changed` likewise. Fill `sha256`, `asset_name`, `notes_url` from the latest (`release_url(&tag)`), `None` for `no-release`.

- [ ] **Step 4: Run** `cargo test` in `ui/src-tauri` — expected PASS (the ignored integration test stays ignored).

- [ ] **Step 5: Report hash** (commit: `feat(updates): installer asset selection, release-body markers, forced floor`).

---

### Task 6: Download, verify and install commands (Rust)

**Files:**
- Modify: `ui/src-tauri/Cargo.toml` (add `sha2 = "0.10"`)
- Modify: `ui/src-tauri/src/updates.rs`
- Modify: `ui/src-tauri/src/lib.rs` `generate_handler!`, `ui/src-tauri/build.rs` command list, `ui/src-tauri/capabilities/default.json`
- Create: `ui/src-tauri/src/cleanup.rs`; wire in `lib.rs` `.setup()`

**Interfaces:**
- Produces Tauri commands: `download_update(tag: String, asset_name: String, sha256: String) -> Result<String /*installer path*/, String>`; `install_update(installer_path: String) -> Result<(), String>` (exits the app on success). Pure helpers: `fn download_args(tag, asset_name, dir) -> Vec<String>`, `fn installer_args(install_dir: &Path) -> Vec<String>`, `fn verify_sha256(path, expected_hex) -> Result<(), String>`, `fn updates_dir(version) -> PathBuf` (`%LOCALAPPDATA%\TermX\updates\<version>`), `cleanup::remove_stale_binaries(exe_dir)`.

- [ ] **Step 1: Failing tests** (in `updates.rs` `mod tests`, plus `cleanup.rs` tests)

```rust
    #[test]
    fn download_and_installer_argv_are_fixed_shape() {
        let dir = std::path::Path::new("C:\\u\\updates\\0.3.0");
        assert_eq!(download_args("v0.3.0", "TermX-Setup-0.3.0-x64.exe", dir), vec![
            "release", "download", "v0.3.0", "--repo", "tastyppc-marketing/termx",
            "--pattern", "TermX-Setup-0.3.0-x64.exe", "--dir", "C:\\u\\updates\\0.3.0", "--clobber"]);
        assert!(download_args("v0.3.0\n", "x", dir).is_empty(), "bad tag yields no argv");
        let args = installer_args(std::path::Path::new("C:\\Users\\me\\AppData\\Local\\Programs\\TermX"));
        assert_eq!(args, vec!["/S".to_owned(), "/D=C:\\Users\\me\\AppData\\Local\\Programs\\TermX".to_owned()]);
    }
    #[test]
    fn digest_verification_rejects_mismatch_and_deletes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x.exe");
        std::fs::write(&file, b"hello").unwrap();
        let good = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert!(verify_sha256(&file, good).is_ok());
        assert!(verify_sha256(&file, &"0".repeat(64)).unwrap_err().contains("verification"));
        assert!(!file.exists());
    }
```

```rust
// ui/src-tauri/src/cleanup.rs tests
    #[test]
    fn removes_old_sidecars_and_ignores_locked_ones() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("termx-host-x86_64-pc-windows-msvc.exe.old"), b"x").unwrap();
        std::fs::write(dir.path().join("keep.txt"), b"x").unwrap();
        remove_stale_binaries(dir.path());
        assert!(!dir.path().join("termx-host-x86_64-pc-windows-msvc.exe.old").exists());
        assert!(dir.path().join("keep.txt").exists());
    }
```

- [ ] **Step 2: Run** `cargo test` in `ui/src-tauri` — expected FAIL.

- [ ] **Step 3: Implement**

```rust
fn download_args(tag: &str, asset_name: &str, dir: &Path) -> Vec<String> {
    if stable_version(tag).is_none() || asset_name.len() > 100
        || !asset_name.bytes().all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b)) { return Vec::new(); }
    ["release", "download", tag, "--repo", REPOSITORY, "--pattern", asset_name, "--dir"]
        .iter().map(|s| s.to_string()).chain([dir.to_string_lossy().into_owned(), "--clobber".to_owned()]).collect()
}

fn installer_args(install_dir: &Path) -> Vec<String> {
    // NSIS: /S = silent; /D must be LAST and unquoted, even with spaces.
    vec!["/S".to_owned(), format!("/D={}", install_dir.display())]
}

fn verify_sha256(path: &Path, expected_hex: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).map_err(|_| "Could not read the downloaded update.")?;
    if bytes.is_empty() { let _ = std::fs::remove_file(path); return Err("The downloaded update is empty.".into()); }
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if !actual.eq_ignore_ascii_case(expected_hex) {
        let _ = std::fs::remove_file(path);
        return Err("The update failed verification and was discarded. Click to retry.".into());
    }
    Ok(())
}

fn updates_dir(version: &str) -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).ok_or("LOCALAPPDATA is not set.")?;
    Ok(base.join("TermX").join("updates").join(version))
}

#[tauri::command]
pub async fn download_update(tag: String, asset_name: String, sha256: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let version = stable_version(&tag).ok_or("Invalid TermX release tag.")?;
        let dir = updates_dir(&version.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|_| "Could not create the updates folder.")?;
        let target = dir.join(&asset_name);
        if target.is_file() && verify_sha256(&target, &sha256).is_ok() { return Ok(target.to_string_lossy().into_owned()); }
        let args = download_args(&tag, &asset_name, &dir);
        if args.is_empty() { return Err("Invalid update reference.".into()); }
        let mut command = Command::new("gh");
        command.args(&args).env("GH_PROMPT_DISABLED", "1").env("GH_NO_UPDATE_NOTIFIER", "1").env_remove("GH_DEBUG");
        bounded_output(command, Duration::from_secs(300), MAX_RESPONSE)?;
        verify_sha256(&target, &sha256)?;
        Ok(target.to_string_lossy().into_owned())
    }).await.map_err(|_| "The update download could not finish.".to_owned())?
}

#[tauri::command]
pub async fn install_update(app: tauri::AppHandle, installer_path: String) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|_| "Could not locate TermX.")?;
    let install_dir = exe.parent().ok_or("Could not locate TermX.")?.to_path_buf();
    let installer = PathBuf::from(&installer_path);
    let expected_dir = updates_dir("")?; // parent of every version folder
    if !installer.starts_with(expected_dir.parent().unwrap_or(&expected_dir)) || installer.extension().and_then(|e| e.to_str()) != Some("exe") {
        return Err("Refusing to run an installer from outside the updates folder.".into());
    }
    let mut command = Command::new(&installer);
    command.args(installer_args(&install_dir)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    command.spawn().map_err(|_| "Could not start the installer.".to_owned())?;
    // NSIS waits for this process to exit before replacing files; leave now.
    app.exit(0);
    Ok(())
}
```

`cleanup.rs`:

```rust
//! Delete `*.old` sidecars the NSIS pre-install hook left beside the exe. A file still mapped by the old daemon fails to delete; that is fine, next launch retries.
use std::path::Path;
pub fn remove_stale_binaries(exe_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(exe_dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".old") && (name.starts_with("termx-host") || name.starts_with("termx-output")) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}
```

In `lib.rs` `.setup()`: `if let Ok(exe) = std::env::current_exe() { if let Some(dir) = exe.parent() { cleanup::remove_stale_binaries(dir); } }`. Register `updates::download_update`, `updates::install_update` in all three places (`allow-download-update`, `allow-install-update`).

- [ ] **Step 4: Run** `cargo test` in `ui/src-tauri` — expected PASS; `cargo build` (debug) once to prove the commands compile with the ACL (`build.rs` regenerates permissions).

- [ ] **Step 5: Report hashes** (commit: `feat(updates): download with gh, verify sha256, silent install and exit`).

---

### Task 7: UI updater hook: states, download/install, launch auto-install, snooze

**Files:**
- Modify: `ui/src/updates/types.ts`, `ui/src/updates/useUpdates.ts`, `ui/src/updates/useUpdates.test.tsx`
- Modify: `ui/src/workspace/uiState.ts` (add `updates?: { lastCheckAt?: number; snoozedVersion?: string }` with parse/serialize; look at how `hostsCollapsed` is parsed and mirror it)
- Modify: `ui/src/App.tsx:596` (`useUpdates(...)` call)

**Interfaces:**
- Consumes: `UpdateResult` fields from Task 5 (camelCase: `forced`, `hostChanged`, `sha256`, `assetName`, `notesUrl`), commands from Task 6, `settings.updatePolicy`.
- Produces: `useUpdates({ policy: UpdatePolicy; snoozedVersion: string | null; onSnooze(version: string): void })` returning `{ version, update, check, open, download, install, snooze }`. `UpdateState` adds `{ kind: "downloading"; result }`, `{ kind: "ready"; result; installerPath }`, `{ kind: "installing"; result }`.

- [ ] **Step 1: Failing tests** (add to `useUpdates.test.tsx`; update `Harness` to accept the new options object with defaults `{ policy: "ask", snoozedVersion: null, onSnooze: vi.fn() }` and update `noRelease` to include `forced:false,hostChanged:false,sha256:null,assetName:null,notesUrl:null`)

```tsx
const available={...noRelease,status:"available",latestVersion:"0.3.0",releaseTag:"v0.3.0",sha256:"a".repeat(64),assetName:"TermX-Setup-0.3.0-x64.exe",notesUrl:"https://github.com/tastyppc-marketing/termx/releases/tag/v0.3.0"};
it("downloads then installs on request, passing the release identity through",async()=>{
  api.invoke.mockResolvedValueOnce(available).mockResolvedValueOnce("C:\\u\\TermX-Setup-0.3.0-x64.exe").mockResolvedValueOnce(undefined);
  await act(async()=>root.render(<Harness/>));
  await act(async()=>value.download());
  expect(api.invoke).toHaveBeenNthCalledWith(2,"download_update",{tag:"v0.3.0",assetName:"TermX-Setup-0.3.0-x64.exe",sha256:"a".repeat(64)});
  expect(value.update).toEqual({kind:"ready",result:available,installerPath:"C:\\u\\TermX-Setup-0.3.0-x64.exe"});
  await act(async()=>value.install());
  expect(api.invoke).toHaveBeenNthCalledWith(3,"install_update",{installerPath:"C:\\u\\TermX-Setup-0.3.0-x64.exe"});
  expect(value.update.kind).toBe("installing");
});
it("auto policy downloads in the background and installs at launch when ready and not forced",async()=>{
  api.invoke.mockResolvedValueOnce(available).mockResolvedValueOnce("C:\\u\\x.exe").mockResolvedValueOnce(undefined);
  await act(async()=>root.render(<Harness policy="auto"/>));
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(api.invoke.mock.calls.map(c=>c[0])).toEqual(["check_for_updates","download_update","install_update"]);
});
it("a snoozed optional version is downloaded but not installed at launch",async()=>{
  api.invoke.mockResolvedValueOnce(available).mockResolvedValueOnce("C:\\u\\x.exe");
  await act(async()=>root.render(<Harness policy="auto" snoozedVersion="0.3.0"/>));
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(api.invoke.mock.calls.map(c=>c[0])).toEqual(["check_for_updates","download_update"]);
  expect(value.update.kind).toBe("ready");
});
it("a forced update is never auto-installed at launch; the modal owns that click",async()=>{
  api.invoke.mockResolvedValueOnce({...available,forced:true}).mockResolvedValueOnce("C:\\u\\x.exe");
  await act(async()=>root.render(<Harness policy="auto"/>));
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(api.invoke.mock.calls.map(c=>c[0])).toEqual(["check_for_updates","download_update"]);
});
it("checks even when the status bar is hidden",async()=>{
  await act(async()=>root.render(<Harness/>));
  expect(api.invoke).toHaveBeenCalledWith("check_for_updates");
});
```

Delete the old "after hiding the bar" assertion (the check no longer depends on the bar); keep the overlap assertion.

- [ ] **Step 2: Run** `npx vitest run src/updates` — expected FAIL.

- [ ] **Step 3: Implement `useUpdates.ts`**

Replace the `enabled` parameter with `options: { policy: UpdatePolicy; snoozedVersion: string | null; onSnooze(version: string): void }`. Keep generation/pending/checking guards. After a successful check with `status === "available"`:
- always `void download()` (background; failures land in `{kind:"error"}` with the message, but keep `result` so the pill still shows the version);
- when download resolves: `setUpdate({kind:"ready",result,installerPath})`; then if `policy === "auto" && !result.forced && result.latestVersion !== snoozedVersion && launchInstallAllowed.current` → `void install()`. `launchInstallAllowed` is a ref set true only for the FIRST check of the mount (launch) and false afterwards, so a 6-hour poll never restarts the app mid-work.

```ts
const download=useCallback(async()=>{
  if (update.kind!=="checked" && update.kind!=="error") return; // (read result from a ref to avoid stale closure; store latest result in resultRef)
  const result=resultRef.current; if(!result||result.status!=="available"||!result.releaseTag||!result.assetName||!result.sha256) return;
  const token=generation.current; setUpdate({kind:"downloading",result});
  try { const installerPath=await invoke<string>("download_update",{tag:result.releaseTag,assetName:result.assetName,sha256:result.sha256});
    if(generation.current===token) setUpdate({kind:"ready",result,installerPath}); return installerPath; }
  catch(error){ if(generation.current===token) setUpdate({kind:"error",message:errorMessage(error),result}); return null; }
},[]);
const install=useCallback(async()=>{
  const state=stateRef.current; if(state.kind!=="ready") return;
  const token=generation.current; setUpdate({kind:"installing",result:state.result});
  try { await invoke("install_update",{installerPath:state.installerPath}); }
  catch(error){ if(generation.current===token) setUpdate({kind:"error",message:errorMessage(error),result:state.result}); }
},[]);
const snooze=useCallback(()=>{ const r=resultRef.current; if(r?.latestVersion) options.onSnooze(r.latestVersion); },[options]);
```

`types.ts`:

```ts
export interface UpdateResult { status: "current"|"available"|"no-release"; currentVersion: string; latestVersion: string|null; releaseTag: string|null; forced: boolean; hostChanged: boolean; sha256: string|null; assetName: string|null; notesUrl: string|null; }
export type UpdateState =
  | { kind: "idle" } | { kind: "checking" } | { kind: "checked"; result: UpdateResult }
  | { kind: "downloading"; result: UpdateResult } | { kind: "ready"; result: UpdateResult; installerPath: string }
  | { kind: "installing"; result: UpdateResult } | { kind: "error"; message: string; result?: UpdateResult };
```

`uiState.ts`: add the optional `updates` field, parse (`lastCheckAt` finite number, `snoozedVersion` string ≤ 32 chars, else drop), serialize only when present. Test in `ui/src/workspace/__tests__/uiState.test.ts` (exists): round-trip and junk-drop.

`App.tsx:596`: `const updates=useUpdates({policy:settings.updatePolicy, snoozedVersion:uiStateSnapshot.updates?.snoozedVersion??null, onSnooze:(v)=>controller.setUpdateSnooze(v)});` — add `setUpdateSnooze(version: string): void` to `WorkspaceController` that does `this.uiState.update((s)=>({...s, updates:{...s.updates, snoozedVersion:version}}))`. (Find how App reads the ui-state snapshot; if it does not, add `useSyncExternalStore(controller.uiStateStore.subscribe, controller.uiStateStore.getSnapshot)` following how settings are read.)

- [ ] **Step 4: Run** `npx vitest run src/updates src/workspace/__tests__/uiState.test.ts` + tsc — expected PASS / 0.

- [ ] **Step 5: Report hashes** (commit: `feat(updates): download, install, launch auto-install, snooze`).

---

### Task 8: Update surfaces: banner, forced modal, status pill, About dialog

**Files:**
- Create: `ui/src/updates/UpdateBanner.tsx`, `ForcedUpdateModal.tsx`, `AboutDialog.tsx`, `updates.css`, `__tests__/surfaces.test.tsx`
- Modify: `ui/src/statusbar/StatusBar.tsx:61-67`, `ui/src/menubar/menus.ts`, `ui/src/menubar/Menubar.tsx` (wherever the Settings menu rows are built), `ui/src/App.tsx`

**Interfaces:**
- Consumes: `UpdateState`, `useUpdates` return (Task 7), `hostVersion` (Task 9 provides; use `hostVersion: string | null` prop, pass `null` until Task 9 lands).
- Produces: `<UpdateBanner update onInstall onLater onNotes />` renders only for `ready` + optional + not snoozed; `<ForcedUpdateModal update sessionTitles onInstall onNotes />` renders for any state whose `result.forced` is true and `status === "available"`; `<AboutDialog open onClose uiVersion hostVersion installDir dataDir />`. `menus.ts` gains `helpMenu(deps: { openAbout(): void })` returning one row `{ id: "about", label: "About TermX…" }` (placed in the Settings menu, last).

- [ ] **Step 1: Failing tests**

```tsx
// ui/src/updates/__tests__/surfaces.test.tsx
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateBanner } from "../UpdateBanner";
import { ForcedUpdateModal } from "../ForcedUpdateModal";
import type { UpdateResult, UpdateState } from "../types";

const result: UpdateResult = { status: "available", currentVersion: "0.2.0", latestVersion: "0.3.0", releaseTag: "v0.3.0", forced: false, hostChanged: false, sha256: "a".repeat(64), assetName: "TermX-Setup-0.3.0-x64.exe", notesUrl: "https://example.test/notes" };
let root: Root; let host: HTMLDivElement;
beforeEach(() => { (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("UpdateBanner", () => {
  it("shows for a ready optional update and offers Install / Later", async () => {
    const onInstall = vi.fn(); const onLater = vi.fn();
    const update: UpdateState = { kind: "ready", result, installerPath: "C:\\x.exe" };
    await act(async () => root.render(<UpdateBanner update={update} onInstall={onInstall} onLater={onLater} onNotes={vi.fn()} />));
    expect(host.textContent).toContain("TermX 0.3.0 is ready");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="update-later"]')!.click());
    expect(onLater).toHaveBeenCalledOnce();
  });
  it("renders nothing while downloading, for forced results, or when current", async () => {
    await act(async () => root.render(<UpdateBanner update={{ kind: "downloading", result }} onInstall={vi.fn()} onLater={vi.fn()} onNotes={vi.fn()} />));
    expect(host.textContent).toBe("");
    await act(async () => root.render(<UpdateBanner update={{ kind: "ready", result: { ...result, forced: true }, installerPath: "x" }} onInstall={vi.fn()} onLater={vi.fn()} onNotes={vi.fn()} />));
    expect(host.textContent).toBe("");
  });
});

describe("ForcedUpdateModal", () => {
  it("cannot be dismissed and lists the sessions that will close when the host changed", async () => {
    const onInstall = vi.fn();
    const update: UpdateState = { kind: "ready", result: { ...result, forced: true, hostChanged: true }, installerPath: "x" };
    await act(async () => root.render(<ForcedUpdateModal update={update} sessionTitles={["build", "deploy"]} onInstall={onInstall} onNotes={vi.fn()} />));
    const dialog = host.querySelector<HTMLDivElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("build");
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.querySelectorAll("button").length).toBe(2); // Update now + What's new
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="update-now"]')!.click());
    expect(onInstall).toHaveBeenCalledOnce();
  });
  it("shows the error inline and keeps its button while downloading fails", async () => {
    await act(async () => root.render(<ForcedUpdateModal update={{ kind: "error", message: "Sign in to GitHub with gh to get updates", result: { ...result, forced: true } }} sessionTitles={[]} onInstall={vi.fn()} onNotes={vi.fn()} />));
    expect(host.textContent).toContain("Sign in to GitHub");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="update-now"]')!.textContent).toBe("Retry");
  });
});
```

Also in `ui/src/statusbar/__tests__/StatusBar.test.tsx` add: a `ready` state prints `Update 0.3.0 ready`; `downloading` prints `Downloading 0.3.0…`.

- [ ] **Step 2: Run** `npx vitest run src/updates src/statusbar` — expected FAIL.

- [ ] **Step 3: Implement**

`UpdateBanner.tsx`: returns null unless `update.kind === "ready" && !update.result.forced`. Markup: `<div className="update-banner" role="status">TermX {v} is ready. <button data-testid="update-install" onClick={onInstall}>Install now</button> <button data-testid="update-later" onClick={onLater}>Later</button> <button className="link" onClick={onNotes}>What's new</button></div>`.

`ForcedUpdateModal.tsx`: renders when `"result" in update && update.result?.forced && update.result.status === "available"`. Backdrop + `role="dialog" aria-modal` with the CloseGuard focus-trap (copy the Tab-cycling handler; on Escape only `preventDefault`+`stopPropagation`). Body: "TermX {v} is required. Work continues after the update." If `hostChanged && sessionTitles.length` → "These terminals will close:" + `<ul>`. Footer: `<button data-testid="update-now" className="primary" disabled={update.kind==="downloading"||update.kind==="installing"} onClick={onInstall}>{update.kind==="error" ? "Retry" : update.kind==="ready" ? "Update now" : update.kind==="installing" ? "Installing…" : "Downloading…"}</button> <button onClick={onNotes}>What's new</button>`. Error message paragraph when `kind === "error"`. `onInstall` in App: if `kind === "error"` → `updates.download()` then install when ready; if `ready` → `updates.install()`.

`StatusBar.tsx:61-67`: extend `updateLabel` with `downloading` → `` `Downloading ${v}…` ``, `ready` → `` `Update ${v} ready` ``, `installing` → `"Installing…"`; `available` stays as the "checked" case. `onOpenUpdate` is called for `ready` (App maps it to `install`) and `checked+available` (App maps to `download`).

`AboutDialog.tsx`: simple dialog (Escape closes) with four `<dl>` rows: UI version, Terminal daemon version (`hostVersion ?? "not connected"`), Install folder, Data folder. Install folder and data folder come from two tiny new Tauri commands? No: avoid new commands. Use `@tauri-apps/api/path` `appDataDir()` for the data folder and `resourceDir()` for the install folder (both already permitted by `core:default`). Wrap in try/catch and show "unavailable".

`menus.ts`: add

```ts
export interface HelpMenuDeps { openAbout(): void }
export function aboutRow(deps: HelpMenuDeps): MenuItemModel {
  return { kind: "item", id: "about", label: "About TermX…", disabled: false, onSelect: deps.openAbout };
}
```

and append `aboutRow` after a separator to whichever function builds the Settings menu rows in `Menubar.tsx` / `menus.ts` (read `menus.test.ts` to keep the shortcut guard satisfied: the row has no `shortcut`).

`App.tsx`: render `<UpdateBanner>` at the top of the workspace column (above the split area), `<ForcedUpdateModal>` and `<AboutDialog>` beside `<CloseGuard>`. `sessionTitles` = titles of live panes from `snapshot.ungroupedTabs`/`snapshot.groups` (use the existing sidebar models' `title`). `onNotes` → `updates.open()`.

- [ ] **Step 4: Run** `npx vitest run src/updates src/statusbar src/menubar` + tsc — expected PASS / 0.

- [ ] **Step 5: Report hashes** (commit: `feat(updates): optional banner, forced modal, About dialog, status pill states`).

---

### Task 9: Daemon version awareness and restart flow

**Files:**
- Modify: `ui/src/workspace/WorkspaceController.ts` (snapshot gains `hostVersion: string | null`; new `restartHost(): Promise<void>`; `WorkspaceHostClient` Pick at line 96 must include `version` and `shutdown`)
- Modify: `ui/src/host/client.ts` (nothing: `version` is already a public readonly field)
- Create: `ui/src/updates/HostRestartBanner.tsx` + test in `__tests__/surfaces.test.tsx`
- Create: `ui/src/updates/hostRestart.ts` (pure decision) + `__tests__/hostRestart.test.ts`
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Produces: `needsHostRestart({ uiVersion, hostVersion, hostChangedSinceHost }: {...}): boolean`; `controller.restartHost()`; `snapshot.hostVersion`.

- [ ] **Step 1: Failing tests**

```ts
// ui/src/updates/__tests__/hostRestart.test.ts
import { describe, expect, it } from "vitest";
import { needsHostRestart } from "../hostRestart";
describe("needsHostRestart", () => {
  it("is false when versions match or the host was not part of the update", () => {
    expect(needsHostRestart({ uiVersion: "0.3.0", hostVersion: "0.3.0", hostChanged: true })).toBe(false);
    expect(needsHostRestart({ uiVersion: "0.3.0", hostVersion: "0.2.0", hostChanged: false })).toBe(false);
    expect(needsHostRestart({ uiVersion: "0.3.0", hostVersion: null, hostChanged: true })).toBe(false);
  });
  it("is true for an older daemon after a host-changing update", () => {
    expect(needsHostRestart({ uiVersion: "0.3.0", hostVersion: "0.2.0", hostChanged: true })).toBe(true);
  });
});
```

Surface test: `<HostRestartBanner open liveCount={3} onRestart />` prints "Restart terminals to finish the update (3 will close)" and calls `onRestart` on click; renders nothing when `open` is false.

- [ ] **Step 2: Run** — expected FAIL.

- [ ] **Step 3: Implement**

```ts
// hostRestart.ts
export function needsHostRestart(i: { uiVersion: string; hostVersion: string | null; hostChanged: boolean }): boolean {
  return i.hostChanged && i.hostVersion !== null && i.hostVersion !== i.uiVersion;
}
```

`hostChanged` here means "the running UI came from an update whose span changed the host". Persist it: when Task 7's hook installs an update with `result.hostChanged`, it first writes `uiState.updates.pendingHostRestart = true` (add to the `updates` record in `uiState.ts`, boolean, optional). After a successful `restartHost()` clear it. App computes `needsHostRestart({ uiVersion: updates.version ?? "", hostVersion: snapshot.hostVersion, hostChanged: uiStateSnapshot.updates?.pendingHostRestart ?? false })`.

`WorkspaceController`: set `hostVersion: this.client.version` in the snapshot builder; add

```ts
  /** Stop the daemon and bring up the one installed beside this UI. Live sessions end. */
  restartHost = async (): Promise<void> => {
    await this.persistence.flush?.();
    this.client.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("bootstrap_host");
    this.uiState.update((s) => ({ ...s, updates: { ...s.updates, pendingHostRestart: false } }));
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    // Simplest correct reconnect: reload the webview; layout is host-side.
    window.location.reload();
    void getCurrentWindow;
  };
```

Check `bootstrap_host`'s argument shape in `bootstrap.rs` (it may take options) and pass what the app's boot path passes (find the existing `invoke("bootstrap_host"` in `bootstrapWorkspace.ts`). The auto-complete path: in App, when `needsHostRestart` is true and `liveSessionCount === 0`, call `controller.restartHost()` once (guard with a ref).

Forced + hostChanged (Task 8 modal "Update now"): App's handler runs `await controller.restartHost()` is WRONG there (the new daemon is not installed yet). Instead: `client.shutdown()` then `updates.install()`; the installer replaces files and relaunches the UI, which spawns the new daemon because none is live. Implement `controller.stopHostForUpdate(): Promise<void>` = flush + shutdown + 300 ms, and use it in the forced path when `result.hostChanged`.

- [ ] **Step 4: Run** all of `src/updates`, `src/workspace` + tsc — expected PASS / 0.

- [ ] **Step 5: Report hashes** (commit: `feat(updates): daemon version awareness and restart-to-finish banner`).

---

### Task 10: Bundle configuration, NSIS hook, sidecar naming

**Files:**
- Modify: `ui/src-tauri/tauri.conf.json:24-33`
- Create: `ui/src-tauri/nsis/hooks.nsh`
- Modify: `.gitignore` (add `ui/src-tauri/binaries/`)
- Modify: `ui/src-tauri/src/bootstrap.rs` (wherever `termx-output.exe` is located; add the msvc/gnu triple names, mirroring lines 167-219 for the host)

**Interfaces:**
- Produces: `npx tauri build` in `ui/` emits `ui/src-tauri/target/release/bundle/nsis/TermX_<version>_x64-setup.exe` containing `TermX.exe`, `termx-host-x86_64-pc-windows-msvc.exe`, `termx-output-x86_64-pc-windows-msvc.exe`.

- [ ] **Step 1: Config**

```json
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": ["icons/icon.ico", "icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.png"],
    "externalBin": ["binaries/termx-host", "binaries/termx-output"],
    "windows": {
      "webviewInstallMode": { "type": "downloadBootstrapper" },
      "nsis": {
        "installMode": "currentUser",
        "languages": ["English"],
        "displayLanguageSelector": false,
        "installerHooks": "./nsis/hooks.nsh"
      }
    }
  }
```

- [ ] **Step 2: Hook file**

```nsis
; ui/src-tauri/nsis/hooks.nsh — TermX installer hooks (Tauri NSIS template).
; PRE-INSTALL: the terminal daemon may be running; NSIS cannot overwrite a
; running exe but Windows lets us rename it. The UI deletes *.old on launch.
!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\termx-host-x86_64-pc-windows-msvc.exe.old"
  Rename "$INSTDIR\termx-host-x86_64-pc-windows-msvc.exe" "$INSTDIR\termx-host-x86_64-pc-windows-msvc.exe.old"
  Delete "$INSTDIR\termx-output-x86_64-pc-windows-msvc.exe.old"
  Rename "$INSTDIR\termx-output-x86_64-pc-windows-msvc.exe" "$INSTDIR\termx-output-x86_64-pc-windows-msvc.exe.old"
!macroend

; POST-INSTALL: a silent run came from TermX's own updater; bring it back.
!macro NSIS_HOOK_POSTINSTALL
  ${If} ${Silent}
    Exec '"$INSTDIR\TermX.exe"'
  ${EndIf}
!macroend
```

(`Rename` on a missing source is a no-op warning in NSIS; acceptable on first install.)

- [ ] **Step 3: Sidecar names**

In `bootstrap.rs`, find where `termx-output.exe` is resolved (grep `termx-output`); add `"termx-output-x86_64-pc-windows-msvc.exe"` and the gnu name to its candidate list exactly as the host list at line 167-219 does. Add a unit test next to the existing bootstrap tests: a temp dir containing only the msvc-named file resolves.

- [ ] **Step 4: Local proof (main thread, not agents; ~5 min)**

From the repo root: `cargo build --release -p termx-host -p termx-output`; copy `target\release\termx-host.exe` → `ui\src-tauri\binaries\termx-host-x86_64-pc-windows-msvc.exe` and likewise for output; from `ui/`: `npx tauri build`. Expected: `ui\src-tauri\target\release\bundle\nsis\TermX_0.2.0_x64-setup.exe` exists; `7z l` (or `Expand-Archive` is not applicable; use `& "$env:LOCALAPPDATA\tauri\NSIS\..."`? simplest: run the installer with `/S /D=<scratchpad>\TermX-test` into the scratchpad) and list the folder: three exes present, no `data\`, no json. Delete the scratchpad install afterwards. This does NOT touch `dist-portable\` or the running app.

- [ ] **Step 5: Report hashes** (commit: `build(bundle): NSIS installer with bundled daemon, pre-install rename hook, silent relaunch`).

---

### Task 11: Release script

**Files:**
- Create: `tools/release.ps1`, `tools/RELEASE-NOTES.template.md`
- Modify: `.gitignore` (nothing; `RELEASE-NOTES.md` at the root IS committed per release)

**Interfaces:**
- Produces: `tools/release.ps1 -Version X.Y.Z [-Force] [-Notes <path>]` → commit `chore(release): vX.Y.Z`, tag `vX.Y.Z`, push both.

- [ ] **Step 1: Write the script**

```powershell
# tools/release.ps1 — cut a TermX release: version, notes, commit, tag, push. CI builds and publishes.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$Force,
  [string]$Notes
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must be X.Y.Z" }
$tag = "v$Version"
if ((git status --porcelain | Measure-Object).Count -ne 0) { throw "Working tree is dirty. Commit or stash first." }
if ((git branch --show-current) -ne "main") { throw "Release from main only." }
if (git tag -l $tag) { throw "Tag $tag already exists." }
git fetch origin --tags | Out-Null
if (git ls-remote --tags origin $tag) { throw "Tag $tag already exists on origin." }

$previous = git describe --tags --abbrev=0 --match "v*" 2>$null
$hostChanged = $true
if ($previous) { git diff --quiet $previous -- host/; $hostChanged = ($LASTEXITCODE -ne 0) }

& (Join-Path $PSScriptRoot "version.ps1") -Version $Version
cargo update -w --offline 2>$null; if ($LASTEXITCODE -ne 0) { cargo update -w }
Push-Location (Join-Path $root "ui\src-tauri"); cargo update -w --offline 2>$null; if ($LASTEXITCODE -ne 0) { cargo update -w }; Pop-Location
Push-Location (Join-Path $root "ui")
try { npx vitest run src/__tests__/versionSync.test.ts; if ($LASTEXITCODE -ne 0) { throw "version sync test failed" } }
finally { Pop-Location }

$body = if ($Notes) { Get-Content -Raw -LiteralPath $Notes } else { Get-Content -Raw (Join-Path $PSScriptRoot "RELEASE-NOTES.template.md") }
$header = @()
if ($Force) { $header += "termx-update: force" }
if ($hostChanged) { $header += "termx-host: changed" }
$notesPath = Join-Path $root "RELEASE-NOTES.md"
[IO.File]::WriteAllText($notesPath, (($header -join "`n") + "`n`n" + $body.Trim() + "`n"))
if (-not $Notes) {
  Write-Host "Edit $notesPath now (keep the termx-* lines at the top), then press Enter."
  [void](Read-Host)
}
git add -A
git commit -m "chore(release): $tag"
git tag -a $tag -m "TermX $Version"
git push origin main
git push origin $tag
Write-Host "Pushed $tag. Watch: https://github.com/tastyppc-marketing/termx/actions"
```

`tools/RELEASE-NOTES.template.md`:

```markdown
## What's new

- 

## Install

Download **TermX-Setup-<version>-x64.exe** below and run it. Windows may show "Windows protected your PC": click **More info**, then **Run anyway**. Existing installs update in place. TermX also installs this update itself at your next launch.
```

- [ ] **Step 2: Dry-run test**

On a throwaway branch named `main` in a scratch clone (`git clone C:\Dev\TermX <scratchpad>\rel-test`), run `powershell -NoProfile -File tools\release.ps1 -Version 0.9.9 -Notes tools\RELEASE-NOTES.template.md` with `origin` pointed at a bare repo in the scratchpad (`git init --bare <scratchpad>\bare.git`; `git remote set-url origin <that>`). Expected: commit + tag land in the bare repo; `RELEASE-NOTES.md` starts with `termx-host: changed` (no previous tag → true). Delete the scratch clone.

- [ ] **Step 3: Report hashes** (commit: `feat(release): one-command release script`).

---

### Task 12: GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: release
on:
  push:
    tags: ["v*"]
permissions:
  contents: write
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: ui/package-lock.json }
      - name: Version from tag must match manifests
        shell: pwsh
        run: |
          $tag = "${{ github.ref_name }}".TrimStart("v")
          $conf = (Get-Content -Raw ui/src-tauri/tauri.conf.json | ConvertFrom-Json).version
          if ($conf -ne $tag) { throw "tag $tag != tauri.conf.json $conf" }
      - name: Install UI deps
        run: npm ci
        working-directory: ui
      - name: Gates
        shell: pwsh
        run: |
          Push-Location ui
          npx tsc -p tsconfig.app.json --noEmit --incremental false; if ($LASTEXITCODE) { exit 1 }
          npx vitest run; if ($LASTEXITCODE) { exit 1 }
          Pop-Location
          cargo test --workspace; if ($LASTEXITCODE) { exit 1 }
          Push-Location ui/src-tauri; cargo test; if ($LASTEXITCODE) { exit 1 }; Pop-Location
      - name: Build host binaries
        run: cargo build --release -p termx-host -p termx-output
      - name: Stage sidecars
        shell: pwsh
        run: |
          New-Item -ItemType Directory -Force ui/src-tauri/binaries | Out-Null
          Copy-Item target/release/termx-host.exe ui/src-tauri/binaries/termx-host-x86_64-pc-windows-msvc.exe
          Copy-Item target/release/termx-output.exe ui/src-tauri/binaries/termx-output-x86_64-pc-windows-msvc.exe
      - name: Build installer
        run: npx tauri build
        working-directory: ui
      - name: Sign (no-op until a certificate exists)
        shell: pwsh
        run: 'Write-Host "SIGN_COMMAND not configured; installer is unsigned"'
      - name: Rename, digest, clean-slate check
        id: pack
        shell: pwsh
        run: |
          $v = "${{ github.ref_name }}".TrimStart("v")
          $src = Get-ChildItem ui/src-tauri/target/release/bundle/nsis/*-setup.exe | Select-Object -First 1
          $out = "TermX-Setup-$v-x64.exe"
          Copy-Item $src.FullName $out
          $hash = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
          Add-Content RELEASE-NOTES.md "`ntermx-sha256: $hash"
          # Clean slate: extract silently into a temp dir and inspect.
          $probe = Join-Path $env:RUNNER_TEMP "termx-probe"
          Start-Process -FilePath (Resolve-Path $out) -ArgumentList "/S", "/D=$probe" -Wait
          $bad = Get-ChildItem $probe -Recurse | Where-Object { $_.Name -in @("portable.flag") -or $_.Extension -in @(".json", ".jsonl") -or ($_.PSIsContainer -and $_.Name -eq "data") }
          if ($bad) { $bad | ForEach-Object { Write-Host $_.FullName }; throw "installer carries state" }
          foreach ($f in @("TermX.exe", "termx-host-x86_64-pc-windows-msvc.exe", "termx-output-x86_64-pc-windows-msvc.exe")) {
            if (-not (Test-Path (Join-Path $probe $f))) { throw "missing $f in installer" }
          }
          "asset=$out" >> $env:GITHUB_OUTPUT
      - name: Publish release
        env: { GH_TOKEN: "${{ github.token }}" }
        shell: pwsh
        run: |
          gh release create "${{ github.ref_name }}" --title "TermX ${{ github.ref_name }}" --notes-file RELEASE-NOTES.md "${{ steps.pack.outputs.asset }}"
```

- [ ] **Step 2: Verify locally what can be verified**

`npx yaml-lint` is not installed; instead run `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))"` from the repo root (Python is available) — expected: no error. The end-to-end run happens on the first tag (Task 13 step 4).

- [ ] **Step 3: Report hash** (commit: `ci: build and publish the installer on v* tags`).

---

### Task 13: Documentation and first release

**Files:**
- Modify: `docs/RELEASE.md` (rewrite around the pipeline; keep the "never ship a bare-cargo UI build" warning and the portable staging section for dogfooding)
- Create: `docs/updates.md` (how the updater decides: markers, forced floor, daemon restart, error table copied from the spec)
- Modify: `README.md` if present (one "Install" paragraph pointing at the releases page)

- [ ] **Step 1: Write the docs** (content from the spec Parts 1, 3 and 5; the "Give someone TermX" section: invite as collaborator → sign in on github.com → open the newest release → run `TermX-Setup-<v>-x64.exe` → `gh auth login` once for in-app updates).

- [ ] **Step 2: Main-thread gate and commit** (`docs: release pipeline, updater behaviour, install instructions`).

- [ ] **Step 3: Cut 0.3.0 (main thread, Michael's approval already given for the feature; the release itself is his call to trigger)** — `powershell -NoProfile -File tools\release.ps1 -Version 0.3.0 -Notes <notes>`; watch the Actions run; when the release exists, confirm `gh release view v0.3.0 --json assets` lists `TermX-Setup-0.3.0-x64.exe` and the body has `termx-sha256:`.

- [ ] **Step 4: Michael's click-test** (from the spec's Testing section): fresh Windows user → installer → welcome screen → pick root → tab opens there; then `0.3.1` optional and `0.3.2 -Force` with a host change.

---

## Self-review

**Spec coverage:** Part 1 installer → Tasks 10, 12. Part 2 clean slate → Task 12 probe step; workspace root → Tasks 2, 3; welcome → Task 4. Part 3 selection/markers → Task 5; download/verify/install → Task 6; daemon policy → Task 9; UI states/settings/snooze → Tasks 7, 8; version display/About → Task 8. Part 4 version sync → Task 1. Part 5 release script → Task 11; workflow → Task 12; docs → Task 13. Error table → Tasks 6 (messages), 8 (pill/modal rendering).

**Placeholder scan:** none of "TBD/TODO/similar to". Every code step has code.

**Type consistency:** `UpdateResult` camelCase fields (`forced`, `hostChanged`, `sha256`, `assetName`, `notesUrl`) match between Task 5 (serde rename) and Tasks 7/8. `useUpdates` options `{ policy, snoozedVersion, onSnooze }` used identically in Tasks 7 and 8. `newTabCwdCandidates` fifth parameter `workspaceRoot` in Task 3 matches Task 2's field. `pendingHostRestart` lives in `uiState.updates` (Task 7 defines the record, Task 9 adds the boolean; Task 7's implementer adds `pendingHostRestart?: boolean` to the same record now so Task 9 only reads it).
