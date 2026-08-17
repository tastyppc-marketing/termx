# SSH Sessions Implementation Plan (saved-sessions batch 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-click SSH into `~/.ssh/config` hosts with live remote cwd + conversation-id tracking, so pinning an SSH pane saves host/remote-folder/exact-conversation and resume SSHes back in, cds, and runs `claude --resume <id>`.

**Architecture:** Three parallel lanes with hard file boundaries (the batch-1 model). Lane A: foundation (ssh config parser, bootstrap builder, credentials store, Rust commands, settings). Lane B: pure components with optional props (Hosts sidebar section + create-menu entries, SetPasswordDialog, SaveSessionDialog host line). Lane C: controller/binding (OSC extensions, connectSshHost, SSH-aware resumeSaved, output tap for password typing). Lane D (orchestrator): App wiring.

**Tech Stack:** TypeScript/React 19 (ui/src), Rust/Tauri 2 (ui/src-tauri), vitest, cargo. Windows DPAPI via windows-sys 0.61 (already a dependency).

**Spec:** `docs/superpowers/specs/2026-08-17-ssh-sessions-design.md`

## Global Constraints

- Never hardcode machine-absolute paths in code; resolve the SSH config path at runtime from the user profile.
- Never print a secret value (passwords, key material) in logs, notices, test output, or chat.
- Gates before any merge: `npx tsc -b` clean; `npx vitest run` fully green (baseline 1098/95 files — run SOLO, overlapping runs produce phantom failures); Rust changes: `cargo test -q -p termx-ui` from ui/src-tauri (baseline 181; grep the "test result" lines, plain tail catches doctest blocks only).
- A repo PostToolUse hook runs the full vitest suite after every file write (55s timeout). Ignore its noise; verify with your own solo runs.
- Every new Tauri command needs: the handler in lib.rs `generate_handler!`, its name in ui/src-tauri/build.rs, and its allow-permission in ui/src-tauri/capabilities/default.json (see the comment at lib.rs:26-28). Capabilities compile into the binary — behavioral verification requires a rebuild.
- Worktree agents: create the ui/node_modules junction with PowerShell `New-Item -ItemType Junction` (cmd mklink silently fails under Git Bash); NEVER `git stash`; NEVER remove your own worktree; before the orchestrator removes one, it severs the junction with `cmd //c rmdir`.
- vitest rewrites `deriveTokens.test.ts.snap` with LF (zero content diff) — never commit that churn.
- Remote-side assumptions (spec §2): remote has bash and coreutils (`mktemp`, `base64`, `find`); document, don't polyfill.

---

## Lane A — Foundation (no App.tsx, no Sidebar.tsx, no WorkspaceController.ts edits)

### Task A1: SSH config parser

**Files:**
- Create: `ui/src/ssh/types.ts`
- Create: `ui/src/ssh/config.ts`
- Test: `ui/src/ssh/__tests__/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // ui/src/ssh/types.ts
  export interface SshHost {
    readonly alias: string;            // primary alias (first token on the Host line)
    readonly aliases: readonly string[]; // all non-wildcard tokens, primary first
    readonly hostName: string | null;  // HostName value, when present
    readonly user: string | null;
    readonly identityFile: string | null;
  }
  // ui/src/ssh/config.ts
  export function parseSshConfig(text: string | null): SshHost[];
  ```
- Consumes: nothing.

- [ ] **Step 1: Write failing tests** — fixture mirrors Michael's real config shapes: comments (whole-line and after values), tab-indented blocks, multi-alias lines (`Host TastyVPS tastyvps` → one host, alias "TastyVPS", aliases both), wildcard `Host *` skipped, `Match` blocks skipped through to the next `Host`, keys case-insensitive (`HostName`/`hostname`), `IdentityFile ~/.ssh/x` kept verbatim, null text → `[]`, garbage text → `[]` without throwing, duplicate `Host` alias keeps the first.
- [ ] **Step 2: Run to verify FAIL** — `npx vitest run src/ssh/__tests__/config.test.ts`
- [ ] **Step 3: Implement** — line-based parse: trim; skip blank/comment; split first token as keyword (case-insensitive); `host` starts a block (tokens with `*` or `?` are dropped; a block with zero non-wildcard tokens is skipped); `match` starts an ignored block; inside a live block record `hostname`/`user`/`identityfile` (first value wins; strip trailing comments only when preceded by whitespace).
- [ ] **Step 4: Run to verify PASS** (same command)
- [ ] **Step 5: Commit** — `feat(ssh): parse ~/.ssh/config host inventory`

### Task A2: Rust command `read_ssh_config`

**Files:**
- Create: `ui/src-tauri/src/ssh.rs`
- Modify: `ui/src-tauri/src/lib.rs` (add `mod ssh;` + `ssh::read_ssh_config` to `generate_handler!`)
- Modify: `ui/src-tauri/build.rs` (add command name where the others are listed)
- Modify: `ui/src-tauri/capabilities/default.json` (add the generated allow permission, following the existing entries)
- Create: `ui/src/native/sshNative.ts`

**Interfaces:**
- Produces:
  ```rust
  #[tauri::command]
  pub fn read_ssh_config() -> Result<Option<String>, String>
  // Resolves %USERPROFILE%\.ssh\config (fall back to $HOME on non-Windows);
  // missing file or missing profile var → Ok(None); unreadable-but-present → Err.
  ```
  ```ts
  // ui/src/native/sshNative.ts
  export async function tauriReadSshConfig(): Promise<string | null>; // invoke("read_ssh_config"), errors → null
  ```
- Consumes: nothing.

- [ ] **Step 1: Rust unit test** in ssh.rs `#[cfg(test)]`: a helper `read_config_at(base: &Path)` (the command calls it with the resolved profile dir) returns Ok(None) for a missing file and the contents for a present one. Write test first, `cargo test -q -p termx-ui ssh` to see it fail.
- [ ] **Step 2: Implement** `read_config_at` + the thin command wrapper resolving the base from `std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))`.
- [ ] **Step 3: cargo test PASS**, register in lib.rs/build.rs/capabilities.
- [ ] **Step 4: Commit** — `feat(ssh): read_ssh_config command + native wrapper`

### Task A3: Rust commands `protect_secret` / `unprotect_secret` (DPAPI)

**Files:**
- Modify: `ui/src-tauri/src/ssh.rs`
- Modify: `ui/src-tauri/Cargo.toml` (windows-sys features: add `Win32_Security_Cryptography`, keep list sorted)
- Modify: lib.rs / build.rs / capabilities (register both commands)
- Modify: `ui/src/native/sshNative.ts`

**Interfaces:**
- Produces:
  ```rust
  #[tauri::command] pub fn protect_secret(plain: String) -> Result<String, String>   // → base64(DPAPI blob), user-scoped
  #[tauri::command] pub fn unprotect_secret(data: String) -> Result<String, String> // base64 blob → plain; wrong user/corrupt → Err
  ```
  ```ts
  export async function tauriProtectSecret(plain: string): Promise<string>;   // throws on failure
  export async function tauriUnprotectSecret(data: string): Promise<string>;  // throws on failure
  ```
- Consumes: nothing.

- [ ] **Step 1: Rust round-trip test** (`protect` then `unprotect` returns the input; unprotect of garbage base64 → Err). Runs on the Windows CI/dev box only — gate with `#[cfg(windows)]`.
- [ ] **Step 2: Implement** with `windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB}`: build a `CRYPT_INTEGER_BLOB` over the input bytes, call with null entropy/reserved/prompt, flags 0; copy the out blob to a Vec, `LocalFree` the out pointer (`Win32::Foundation::LocalFree` — feature already present or add `Win32_Foundation`); base64 via the `base64` crate if already a dependency, else hand-roll with `data_encoding`? — check Cargo.toml first and use whatever encoder termx already depends on; if none, add `base64 = "0.22"`.
- [ ] **Step 3: cargo test PASS**; register commands everywhere.
- [ ] **Step 4: Commit** — `feat(ssh): DPAPI protect/unprotect commands`

### Task A4: Credentials store

**Files:**
- Create: `ui/src/ssh/credentials.ts`
- Test: `ui/src/ssh/__tests__/credentials.test.ts`
- Modify: `ui/src/native/appFiles.ts` (AppFileName union + `"ssh_credentials_v1.json"`)
- Modify: `ui/src-tauri/src/storage.rs` (`ALLOWED_FILES: [&str; 6]`, rename the count test to `allowlist_is_exactly_the_six_app_files`)

**Interfaces:**
- Produces:
  ```ts
  export interface SshCredentialsStore {
    ready(): Promise<void>;
    flush(): Promise<void>;
    /** Decrypted password for the alias, or null (none stored / unprotect failed). */
    passwordFor(alias: string): Promise<string | null>;
    /** Stores per the scheme argument; overwrites. */
    setPassword(alias: string, plain: string, encrypt: boolean): Promise<void>;
    removePassword(alias: string): Promise<void>;
    hasPassword(alias: string): boolean;         // sync, from the hydrated snapshot
    /** Re-writes every entry in the new scheme (settings toggle flip). */
    reencryptAll(encrypt: boolean): Promise<void>;
    subscribe(listener: () => void): () => void; // notifies on any change
  }
  export function createSshCredentialsStore(
    files: AppFileStore,
    crypto: { protect(plain: string): Promise<string>; unprotect(data: string): Promise<string> },
  ): SshCredentialsStore;
  ```
  File shape (spec §4): `{ "version": 1, "hosts": { "<alias>": { "password": { "scheme": "dpapi" | "plain", "data": "<base64-or-plain>" } } } }` — `plain` scheme stores the raw string in `data`.
- Consumes: `AppFileStore` from `ui/src/native/appFiles.ts`.

- [ ] **Step 1: Failing tests** — round-trip both schemes (fake crypto = reversible marker fns), tolerant parse (corrupt file → empty, junk host entry dropped), `passwordFor` returns null when unprotect throws, `reencryptAll` converts schemes, writes are immediate (this is a user action — same policy as the saved store after the batch-1 blocker), never logs the plain value (assert the fake AppFileStore contents contain the marker-encrypted form when encrypt=true).
- [ ] **Step 2-4:** FAIL → implement (model on `ui/src/saved/store.ts`: hydrate-once, serialized write chain, immediate writes) → PASS.
- [ ] **Step 5: Commit** — `feat(ssh): credentials store with optional DPAPI at rest`

### Task A5: Bootstrap builder

**Files:**
- Create: `ui/src/ssh/bootstrap.ts`
- Test: `ui/src/ssh/__tests__/bootstrap.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** The full local command to type into a fresh shell: `ssh -t <alias> '<one-liner>'`. */
  export function sshConnectCommand(alias: string, opts?: { remoteCwd?: string }): string;
  /** Exposed for tests: the decoded remote rcfile script. */
  export function remoteRcScript(opts?: { remoteCwd?: string }): string;
  ```
  Contract (spec §2): the one-liner is
  `tmp=$(mktemp); echo <BASE64> | base64 -d > "$tmp"; exec bash --rcfile "$tmp" -i`
  and the rcfile script, in order: (1) `[ -f ~/.bashrc ] && . ~/.bashrc`; (2) `rm -f` its own tmp file (path via `$TERMX_RC` exported before exec — simpler: embed `rm -f "$tmp"` is impossible after exec, so instead the one-liner passes the path in an env var: `TERMX_RC="$tmp" exec bash --rcfile "$tmp" -i` and the rcfile ends with `rm -f "$TERMX_RC"`); (3) `PROMPT_COMMAND='printf "\033]9;9;%s\033\\\\" "$PWD"'` set AFTER sourcing bashrc; (4) `claude()` and `codex()` wrapper functions per the code below; (5) optional `cd <remoteCwd>` (single-quoted, embedded single quotes escaped `'\''`).
  Wrapper shape (claude; codex identical with `~/.codex/sessions` and provider `codex`):
  ```bash
  claude() {
    local stamp; stamp=$(mktemp)
    (
      for _ in $(seq 1 240); do
        sleep 0.5
        local hit; hit=$(find "$HOME/.claude/projects" -name '*.jsonl' -newer "$stamp" 2>/dev/null | head -1)
        if [ -n "$hit" ]; then
          local base; base=$(basename "$hit" .jsonl)
          printf '\033]9;78;claude;%s\033\\' "$base" > /dev/tty
          break
        fi
      done
      rm -f "$stamp"
    ) 2>/dev/null &
    command claude "$@"
  }
  ```
  (`local` outside a function body is invalid — inside the subshell use plain variables; the test asserts the emitted script has no `local` inside `( … )`.)
- Consumes: nothing.

- [ ] **Step 1: Failing tests** — `sshConnectCommand("myvps")` starts with `ssh -t myvps '` and the quoted payload decodes (Buffer.from(b64, "base64")) to a script containing the bashrc source line, the PROMPT_COMMAND OSC 9;9 line, both wrapper functions with `9;78;claude;` / `9;78;codex;` markers, and NO `cd` line; with `remoteCwd: "/root/my app"` the decoded script `cd`s with correct single-quote escaping; alias validation: aliases must match `/^[A-Za-z0-9._-]+$/` (anything else throws — an alias is never shell-interpolated raw); the outer one-liner contains no unescaped single quotes from the payload (base64 alphabet guarantees it — assert the payload segment matches `/^[A-Za-z0-9+/=]+$/`).
- [ ] **Step 2-4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** — `feat(ssh): connect bootstrap builder (remote cwd hook + id-capture wrappers)`

### Task A6: Settings + SettingsSurface SSH section

**Files:**
- Modify: `ui/src/settings/settings.ts` (+ its test file, following how `savedPaneButton` was added)
- Modify: `ui/src/settings/SettingsSurface.tsx` (+ test)
- Modify: `ui/src/saved/types.ts` + `ui/src/saved/store.ts` (+ store test)

**Interfaces:**
- Produces (settings, tolerant-parsed like every other key):
  ```ts
  sshHostsSidebar: boolean;              // default true
  sshHostsMenu: boolean;                 // default true
  sshPasswordPolicy: "store" | "never";  // default "store"
  sshEncryptPasswords: boolean;          // default true
  ```
  SettingsSurface gains an 8th section "SSH" with the four controls (two toggles, a two-option radio/select for the policy, a toggle for encryption whose hint states plainly: off = passwords stored in plain text).
  Saved model (spec §4):
  ```ts
  // ui/src/saved/types.ts
  export interface SavedSshRef { readonly host: string; }
  // SavedSession gains: readonly ssh?: SavedSshRef;
  ```
  `parseSavedSessions` accepts an `ssh` object with a non-empty string `host` (else the field degrades away, entry kept); `save()` input gains optional `ssh?: SavedSshRef` passed through whole-input like `conversation`; serialization round-trips it.
- Consumes: nothing new.

- [ ] Steps: failing tests for each parse default + round-trip → implement → PASS → commit `feat(ssh): settings, SSH settings section, SavedSession.ssh block`.

---

## Lane B — Components (pure/optional props; owns Sidebar.tsx; NO App.tsx, workspace/, terminal/ edits)

### Task B1: Hosts sidebar section

**Files:**
- Modify: `ui/src/sidebar/Sidebar.tsx` (+ `Sidebar.css`)
- Test: `ui/src/sidebar/__tests__/SidebarHosts.test.tsx`

**Interfaces:**
- Consumes: `SshHost` from `ui/src/ssh/types.ts` (lane A — merged first; until then code against the shape in this plan).
- Produces:
  ```ts
  export interface SidebarHosts {
    enabled: boolean;                       // settings.sshHostsSidebar
    menuEnabled: boolean;                   // settings.sshHostsMenu (used by B2)
    hosts: readonly SshHost[];
    onConnect(alias: string): void;
    /** Present only when the password policy allows storing. */
    onSetPassword?(alias: string): void;
    /** Aliases that currently have a stored password (badge + "Change password…" label). */
    withPassword?: ReadonlySet<string>;
  }
  // SidebarProps gains: hosts?: SidebarHosts;
  ```
  Render (model on the Saved section exactly): section `data-testid="hosts-section"` below Saved; row `data-testid="host-row"` `data-host-alias="<alias>"`, shows alias + a muted `user@hostname` line (hostname null → alias only), row `title` = `ssh <alias>`; row click / Enter = `onConnect(alias)`; hover action 🔑 (`aria-label="Set password for <alias>"`, label "Change password…" when `withPassword` has the alias) only when `onSetPassword` present; empty inventory + enabled → one-line hint "Hosts from your SSH config appear here."; `enabled: false` or prop absent → nothing.
- [ ] Steps: failing tests (render/gating/connect/keyboard/set-password visibility per policy/empty hint) → implement → PASS → commit `feat(ssh): sidebar Hosts section`.

### Task B2: Create-menu host entries

**Files:**
- Modify: `ui/src/sidebar/Sidebar.tsx` (the `openMenu({kind:"create"})` menu — find where kind "create" renders its items and append a Hosts group)
- Test: extend `ui/src/sidebar/__tests__/SidebarHosts.test.tsx`

**Interfaces:**
- Consumes: `SidebarHosts` from B1 (menu shows when `hosts?.hosts.length > 0` AND a new `menuEnabled: boolean` field on `SidebarHosts` — add it in B1: `menuEnabled` carries `settings.sshHostsMenu`).
- Produces: menu items labeled `ssh <alias>` (testid `create-menu-host-<alias>`) that call `onConnect(alias)` and close the menu.
- [ ] Steps: failing test (menu lists hosts when menuEnabled, hidden when off, click connects) → implement → PASS → commit `feat(ssh): hosts in the new-terminal menu`.

### Task B3: SetPasswordDialog

**Files:**
- Create: `ui/src/ssh/SetPasswordDialog.tsx` + `.css`
- Test: `ui/src/ssh/__tests__/SetPasswordDialog.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface SetPasswordDialogProps {
    open: boolean;
    alias: string;
    hasExisting: boolean;                  // shows "Replace stored password" copy + Remove button
    onSave(password: string): void;        // non-empty, NOT trimmed (passwords may end in spaces)
    onRemove?(): void;
    onCancel(): void;
  }
  export function SetPasswordDialog(props: SetPasswordDialogProps): JSX.Element | null;
  ```
  Modal manners cloned from SaveSessionDialog (backdrop, focus trap, Esc cancel, Enter saves); input `type="password"` `data-testid="ssh-password-input"`, autofocus; Save disabled when empty; buttons `ssh-password-save` / `ssh-password-remove` / `ssh-password-cancel`. The dialog never displays the existing value.
- [ ] Steps: failing tests → implement → PASS → commit `feat(ssh): set-password dialog`.

### Task B4: SaveSessionDialog host line

**Files:**
- Modify: `ui/src/saved/SaveSessionDialog.tsx`
- Test: extend `ui/src/saved/__tests__/SaveSessionDialog.test.tsx`

**Interfaces:**
- Produces: `SaveSessionPrefill` gains `readonly sshLabel: string | null;` (null = local save; e.g. `"SSH: root@myvps"`). When non-null render `<p data-testid="save-session-ssh">{sshLabel}</p>` above the conversation line, and the Folder label reads "Remote folder". All existing callers compile via a default: make the field optional (`sshLabel?: string | null`).
- [ ] Steps: failing tests → implement → PASS → commit `feat(ssh): save dialog shows the SSH host`.

---

## Lane C — Controller & binding (owns WorkspaceController.ts, TerminalSessionBinding.ts, TerminalPane.tsx, AttachmentHub.ts, uiState.ts, bootstrapWorkspace.ts; NO App.tsx, Sidebar.tsx edits)

### Task C1: OSC parser extensions

**Files:**
- Modify: `ui/src/terminal/TerminalSessionBinding.ts`
- Test: extend `ui/src/terminal/__tests__/cwdReport.test.ts` + new `ui/src/terminal/__tests__/conversationCapture.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // parseOsc9CwdReport also accepts rooted Unix paths: /^\/[^\0]*$/ after the
  // existing quote-strip; Windows behavior unchanged.
  export function parseOsc9ConversationCapture(data: string):
    { provider: "claude" | "codex"; id: string } | null;
  // "9;78;claude;<id>" — id must match /^[A-Za-z0-9-]+$/ (resumeCommand's rule); else null.
  // TerminalSessionBindingOptions gains:
  //   onConversationCaptured?: (capture: { provider: "claude" | "codex"; id: string }) => void;
  // dispatched from the same OSC 9 handler, live output only (replayFinished),
  // checked BEFORE the cwd parse (it starts "9;78;", cwd is "9;9;").
  ```
- [ ] Steps: failing tests (Unix path accepted + reported; `9;78` parse incl. junk/provider validation; replayed capture suppressed like output reports) → implement → PASS → commit `feat(ssh): remote cwd + conversation-capture OSC parsing`.

### Task C2: TerminalPane plumbing

**Files:**
- Modify: `ui/src/terminal/TerminalPane.tsx`

**Interfaces:**
- Produces: `TerminalPane` prop `onConversationCaptured?: (sessionId: number, capture: { provider: "claude" | "codex"; id: string }) => void` forwarded into the binding options via the same ref pattern as `onCwd` (lines ~194/334).
- [ ] Steps: extend an existing TerminalPane test to assert forwarding → implement → PASS → commit (fold into C1's commit is fine: `feat(ssh): pane forwards conversation captures`).

### Task C3: AttachmentHub output tap

**Files:**
- Modify: `ui/src/workspace/AttachmentHub.ts`
- Test: extend its test file

**Interfaces:**
- Produces:
  ```ts
  /** Observe a session's decoded live output without attaching a terminal.
   *  Multiple taps allowed; dispose to stop. Used by the ssh password watcher. */
  tapOutput(sessionId: number, listener: (text: string) => void): { dispose(): void };
  ```
  Implementation: a `Map<number, Set<listener>>`; invoke alongside the existing `callbacks.onOutput` dispatch with the SAME decoded text payload the terminal path gets (reuse the existing decode; if the hub dispatches bytes, decode once with a shared TextDecoder per session). Tap listeners never throw outward (wrap in try/catch like `invokeConsumer`).
- [ ] Steps: failing test (tap sees output, dispose stops it, taps survive terminal detach) → implement → PASS → commit `feat(ssh): attachment output tap`.

### Task C4: connectSshHost + SSH pane state

**Files:**
- Modify: `ui/src/workspace/WorkspaceController.ts`
- Modify: `ui/src/workspace/uiState.ts` (+ test)
- Modify: `ui/src/workspace/bootstrapWorkspace.ts`
- Test: `ui/src/workspace/__tests__/connectSsh.test.ts`

**Interfaces:**
- Consumes: `sshConnectCommand` (A5), `SshHost` (A1), `tapOutput` (C3).
- Produces:
  ```ts
  // WorkspaceControllerOptions gains:
  //   sshPasswords?: { passwordFor(alias: string): Promise<string | null> };
  // Public:
  connectSshHost(host: SshHost, opts?: { groupId?: string | null }): Promise<void>;
  sshPaneInfo(sessionId: number): { host: string } | null;
  capturedConversation(sessionId: number): { provider: "claude" | "codex"; id: string } | null;
  reportCapturedConversation(sessionId: number, capture: { provider: "claude" | "codex"; id: string }): void;
  ```
  `connectSshHost`: create a local session (default profile, null cwd chain), open its tab, `armResumeWait` for the LOCAL prompt (existing constants), then send `sshConnectCommand(host.alias)\r`; record `sshPanes.set(sessionId, { host: host.alias })` and mirror to uiState (below). If `sshPasswords` yields a password for the alias: `tapOutput` the session for ≤60s, buffer the tail (last 512 chars), on first match of `/password[^\n]*:\s*$/i` send `password + "\r"` ONCE and dispose the tap; dispose on session exit and on timeout. The password variable is function-local and never stored on the controller.
  uiState: `sshPanes?: { [sessionId: string]: { host: string; capturedProvider?: "claude" | "codex"; capturedId?: string } }` — tolerant parse; written on connect and on capture; pruned wherever dead sessions already get pruned from `chatPanes` (follow that exact mechanism); hydrated into the controller maps at construction via a new option `initialSshPanes?` that `bootstrapWorkspace` fills from the uiState snapshot.
  `reportCapturedConversation` overwrites the previous capture for that session (newest wins) and mirrors to uiState.
- [ ] Steps: failing tests (connect types the command after prompt-ready; pane recorded; capture recorded + persisted shape; password typed once on prompt match, not without a stored password, tap disposed; hydration restores sshPaneInfo) → implement → PASS → commit `feat(ssh): connectSshHost, ssh pane state, password watcher`.

### Task C5: SSH-aware resumeSaved + title probe wrapper

**Files:**
- Modify: `ui/src/workspace/WorkspaceController.ts`
- Modify: `ui/src/conversations/resume.ts` (+ test)
- Create: `ui/src/native/sshProbe.ts`
- Modify: `ui/src-tauri/src/ssh.rs` (+ lib.rs/build.rs/capabilities) — command `ssh_probe`
- Test: `ui/src/workspace/__tests__/resumeSavedSsh.test.ts`

**Interfaces:**
- Consumes: `SavedSession.ssh` (A6), `sshConnectCommand` (A5), parsed hosts (passed in — see below).
- Produces:
  ```ts
  // resume.ts:
  export function remoteResumeCommand(conversation: SavedConversationRef | undefined): string | null;
  // claude: `claude --resume <id>` (id validated) ; codex: `codex resume <id>` ;
  // undefined conversation → null (bare remote shell) ; invalid id → "claude --continue"
  // is NOT silently substituted — invalid id returns null-with-notice at the caller,
  // BUT a conversation ref whose id passed capture validation is always valid here;
  // the --continue fallback applies only to entries with NO conversation AND a
  // stored provider hint — which the model does not carry, so: no conversation = bare shell.
  ```
  ```rust
  #[tauri::command]
  pub async fn ssh_probe(alias: String, command: String, timeout_ms: u64) -> Result<String, String>
  // spawns: ssh -o BatchMode=yes -o ConnectTimeout=5 <alias> <command>
  // (alias validated /^[A-Za-z0-9._-]+$/ server-side too); kills at timeout; stdout on 0, Err otherwise.
  ```
  ```ts
  // ui/src/native/sshProbe.ts
  export async function tauriSshProbe(alias: string, command: string, timeoutMs: number): Promise<string | null>; // Err → null
  /** Title of a remote claude conversation: greps the transcript's last summary. */
  export async function probeRemoteTitle(alias: string, provider: "claude" | "codex", id: string): Promise<string | null>;
  // claude command: sh -c 'f=$(find ~/.claude/projects -name "<id>.jsonl" | head -1); [ -n "$f" ] && grep -o "\"summary\":\"[^\"]*\"" "$f" | tail -1 | cut -d\" -f4'
  // codex: return null in v1 (codex titles are index-side; the id is the display fallback).
  ```
  `resumeSaved` for an entry with `ssh`: skip `probeDir`; validate the alias against a `hostsProvider` option (`WorkspaceControllerOptions.sshHosts?: { byAlias(alias: string): SshHost | null }`) — unknown → notice `Host <alias> is no longer in your SSH config.`; create local session; reuse `openResumedTab` with command = `sshConnectCommand(alias, { remoteCwd: entry.cwd })`; then arm a SECOND `armResumeWait(sessionId, 45_000, true)` that settles on the first remote (Unix-path) cwd report and, on "ready", send `remoteResumeCommand(entry.conversation)\r` when non-null; register `resumedTabs`/`recordDaemonSession` exactly as local; also `sshPanes.set` so the restored pane is pin-able again. On "elapsed"/"gone": no notice beyond what the terminal already shows (spec §7) except the existing openResumedTab failure notices.
- [ ] Steps: failing tests (remoteResumeCommand table; ssh resume types connect-then-resume in order with the two waits; unknown alias refuses with the exact notice; bare remote shell types only the connect command; reattach path untouched) → implement → PASS; Rust: probe test behind `#[cfg(windows)]` marked `#[ignore]` (needs a live host — run manually) → commit `feat(ssh): ssh-aware resume + remote title probe`.

---

## Lane D — Integration (orchestrator only; App.tsx + final wiring)

### Task D1: App wiring

**Files:**
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/workspace/bootstrapWorkspace.ts` (hosts + credentials hydration — coordinate: lane C owns this file; D rebases after C merges)
- Test: `ui/src/__tests__/App.sshHosts.test.tsx`

Wiring, following the batch-1 saved-sessions integration pattern exactly (refs before `actionsFor`, optional-prop spreads, gating booleans in memo deps):
- Bootstrap: parse `tauriReadSshConfig()` → `parseSshConfig` at workspace bootstrap; expose `BootstrappedWorkspace.sshHosts?: readonly SshHost[]` and `BootstrappedWorkspace.sshCredentials?: SshCredentialsStore` (created with `tauriProtectSecret`/`tauriUnprotectSecret`, respecting `settings.sshEncryptPasswords` at write time and `reencryptAll` on toggle flip — the flip handler lives in the settings surface wiring).
- Sidebar: `sidebarHosts` memo → `SidebarHosts` (enabled from `settings.sshHostsSidebar`, `menuEnabled` from `settings.sshHostsMenu`, `onConnect: (alias) => void controller.connectSshHost(hostByAlias(alias))`, `onSetPassword` gated on `settings.sshPasswordPolicy === "store"`, `withPassword` from the credentials store snapshot).
- SetPasswordDialog host state + handlers (`setPassword(alias, value, settings.sshEncryptPasswords)`).
- TerminalPane: pass `onConversationCaptured: (sessionId, capture) => controller.reportCapturedConversation(sessionId, capture)`.
- Save prefill (`openSaveForPane`): when `controller.sshPaneInfo(sessionId)` is non-null → prefill `sshLabel` (`SSH: ${user}@${host}` from the parsed host, alias-only fallback), conversation from `controller.capturedConversation(sessionId)` (title = id immediately; fire `probeRemoteTitle` and update the OPEN dialog's prefill title when it resolves — the dialog re-seeds only on open, so pass the async title through the same savePrompt state with a `setSavePrompt` update guarded on the dialog still being open for the same session), cwd = live (remote) sessionCwd, save carries `ssh: { host }`.
- Controller options: `sshPasswords: workspace.sshCredentials`, `sshHosts: { byAlias }`.
- Tests: hosts section gating + connect call; ssh save prefill (mock controller sshPaneInfo/capturedConversation) carries ssh block; password dialog write path.

### Task D2: Ship

Gates (Global Constraints) → attributed commits → Fable adversarial fork (functionality AND usability, batch-1 style) → fixes → `npx tauri build --no-bundle` → verify `custom_protocol`/no-dev → stage dist-portable rename-aside → live gate per spec §8 against `myvps` → handoff delta → tell Michael to restart.
