# SSH Sessions — Design (Saved-sessions batch 2)

Approved by Michael 2026-08-17 (chat, "Do it"). Extends the shipped
saved-sessions feature (see `2026-08-17-saved-sessions-design.md`) to VPSes:
one-click connect from an SSH host inventory, live remote cwd + conversation-id
tracking, and save/resume that SSHes in, cds, and resumes the exact remote
conversation — as if he never left.

## Decisions (Michael, 2026-08-17)

- **TermX-launched connections only are tracked** — accepted on the condition
  that connecting is so easy he never types `ssh` by hand: a one-click connect
  button per host. Hand-typed `ssh` stays an ordinary local pane.
- **Exact conversation-id capture, never guessing.** Capture the remote session
  id the moment claude/codex starts; reflect `/rename`d titles; the pin button
  captures "the whole nine yards". VPS-side installs are authorized if needed
  for robustness — v1 uses per-connection injection (nothing installed);
  an installable helper is the recorded plan-B only.
- **Hosts surface: both** — sidebar Hosts section AND new-terminal menu.
- **Credentials** (from batch-1 decisions): both keys and passwords selectable
  in Settings; default = store passwords, encrypted at rest automatically
  (DPAPI-style, no passphrase); encryption optional; keys/agent-only mode
  available. All 8 current hosts in `~/.ssh/config` are key-auth (IdentityFile),
  so passwords matter only for future hosts.

## 1. Hosts inventory

`ui/src/ssh/config.ts`: read-only parser for `~/.ssh/config` (path resolved at
runtime from the user profile — never hardcoded). Extracts `Host` blocks:
aliases (multi-alias lines like `Host TastyVPS tastyvps` produce one host with
the first alias primary), `HostName`, `User`, `IdentityFile`, comments/tabs
tolerated. Wildcard patterns (`Host *`) and `Match` blocks are skipped.
The file is Michael's; TermX never writes it. Read via a new allowlist-safe
Tauri command (`read_ssh_config`) since it lives outside the app-data dir.

Surfaces:
- **Sidebar "Hosts" section** (setting `sshHostsSidebar`, default true; sits
  under Saved): one row per alias, hover shows `user@hostname`, row click =
  connect in a new tab. Hover actions: "Set password…" (only shown when the
  password policy allows storing).
- **New-terminal options menu** (setting `sshHostsMenu`, default true): each
  host as a connect target.

## 2. Connect flow

`WorkspaceController.connectSshHost(alias, opts?)`, built on the proven
resume machinery (create local session → arm prompt wait → type command):

1. Create a local session (default profile, default cwd).
2. When the local shell is ready, type the connect command:
   `ssh -t <alias> '<bootstrap>'`
3. The bootstrap is a compact one-liner (base64-encoded payload decoded and
   eval'd remotely) built by `ui/src/ssh/bootstrap.ts` that, on the remote:
   - sets a `PROMPT_COMMAND` emitting the OSC 9;9 cwd report with the remote
     absolute path (same channel local shells use);
   - defines `claude` and `codex` shell functions that start a lightweight
     background watcher before exec'ing the real binary: the watcher polls the
     provider's transcript dir (`~/.claude/projects/<munged-cwd>/`, codex
     equivalent) for a new session file and emits one TermX-private OSC
     `9;78;<provider>;<session-id>` when it appears, then exits;
   - optionally `cd <dir>` (resume path);
   - `exec`s an interactive login shell.
4. The controller records the pane as an SSH pane: `sshPaneInfo(sessionId) →
   { host }`, kept for the pane's lifetime.

Remote cwd: `parseOsc9CwdReport` is extended to also accept rooted Unix paths
(`/…`). Local shells only ever report Windows paths (only powershell/cmd get
the injected hook), so a Unix-shaped report is unambiguous.

Id capture: `TerminalSessionBinding` learns the `9;78` subcommand and reports
`(sessionId, provider, conversationId)` to the controller, which keeps the
latest capture per session (`capturedConversation(sessionId)`). A new claude
launch in the same pane overwrites the previous capture.

Password hosts: if the stored policy has a password for the host, a prompt
watcher on the SSH pane watches for the `password:` prompt (bounded window
after the connect command) and types the stored password into the PTY — never
echoed, never in scrollback. No stored password → Michael types it himself;
the connection is still tracked.

## 3. Title / rename capture

Live rename streaming is not built. Instead the title is read fresh at the
moments it is shown:
- **Pin time** on an SSH pane: TermX runs a one-shot remote query over ssh
  (new Tauri command `ssh_probe(alias, command, timeoutMs)` → stdout) that
  reads the captured conversation's current title from its remote transcript
  (claude: last summary/title line of
  `~/.claude/projects/<munged>/<id>.jsonl`). A `/rename` done remotely is
  reflected in the save dialog. Probe failure degrades to the id as title —
  the save still works offline-ish.
- The probe is also the health check: it runs with a short timeout and never
  blocks the dialog from opening (title arrives async into the open dialog).

## 4. Data model

`SavedSession` gains the optional block (slot reserved in batch 1 — additive,
no migration):

```ts
ssh?: {
  readonly host: string;   // config alias; the config stays the source of truth
}
```

For an SSH save, `cwd` holds the REMOTE absolute path and `conversation.id`
holds the remotely-captured id. Store parse: junk `ssh` block degrades to a
local save (tolerant, like every other optional field).

Credentials file `ssh_credentials_v1.json` (new app-file allowlist entry):

```json
{ "version": 1,
  "hosts": { "<alias>": { "password": { "scheme": "dpapi" | "plain", "data": "<base64>" } } } }
```

## 5. Save & resume

- **Pin on an SSH pane** (`sshPaneInfo` present): dialog shows a host line
  ("SSH: root@myvps"), remote cwd prefilled from live tracking, conversation
  from the captured id with freshly probed title. Saves
  `{ssh: {host}, cwd: <remote>, conversation}`. Upsert-by-conversation-id
  unchanged.
- **Resume of an SSH entry**: reattach-if-alive unchanged (daemon session id).
  Fresh restore: validate the host still exists in the parsed config (gone →
  notice "Host <alias> is no longer in your SSH config."), create a local
  session, type the connect command with `cd <remote dir>` baked into the
  bootstrap, then — once the remote shell reports ready (first remote cwd
  report) — type `claude --resume <id>` / `codex resume <id>`; `--continue`
  is typed only when the entry has no captured id. `touchDaemonSession` and
  chat-linkage registration as in the local path. No `probeDir` for remote
  cwds (the remote cd failing surfaces in the terminal itself).

## 6. Credentials & settings

Settings gains an **SSH** group:
- `sshHostsSidebar` (true), `sshHostsMenu` (true) — surface toggles.
- `sshPasswordPolicy`: `"store"` (default) | `"never"` (keys/agent-only mode;
  hides Set password…, ignores stored ones).
- `sshEncryptPasswords` (true): DPAPI-encrypt stored passwords via new Tauri
  commands `protect_secret`/`unprotect_secret` (Windows CryptProtectData,
  user-scoped, automatic). Off = plaintext in the file, labeled plainly in
  the settings hint. Toggling re-writes existing entries in the new scheme.
- "Set password…" opens a small dialog (input type=password); the value goes
  straight to the credentials store, never into logs or state dumps.

## 7. Error handling

- Missing/unparseable ssh config → empty Hosts inventory, sections show a
  one-line hint; nothing crashes.
- Connect into a dead/unreachable host → the ssh error is simply visible in
  the terminal (it is a terminal); TermX adds nothing.
- Resume: unknown alias → notice (above); ssh fails after connect command →
  the resume wait times out quietly like a local resume whose prompt never
  appears (existing behavior), leaving the error on screen.
- `ssh_probe` failures degrade (id as title); they never block pin or resume.
- Credentials file corrupt → treated as empty; DPAPI unprotect failure for a
  host → behaves as "no stored password" plus one notice.

## 8. Testing

- Unit: config parser against real-shape fixtures (multi-alias, tabs,
  comments, wildcard skip, Match skip); bootstrap builder (payload encodes
  cd/hook/wrappers correctly, quoting torture tests); OSC 9;9 Unix-path
  acceptance (+ Windows behavior unchanged); OSC 9;78 parse; credentials
  store round-trip with scheme switching (DPAPI mocked in vitest, real in a
  Rust unit test); controller: connectSshHost typing, id capture recording,
  SSH save prefill, SSH resume command construction incl. --resume vs
  --continue fallback, unknown-alias refusal.
- Live gate (real VPS, `myvps` over Tailscale): one-click connect → remote
  cwd tracked → launch claude remotely → id captured → pin (title probed) →
  kill terminal → resume → same remote conversation on screen. Password path
  smoke-tested with a scratch entry (not a real credential in chat).
