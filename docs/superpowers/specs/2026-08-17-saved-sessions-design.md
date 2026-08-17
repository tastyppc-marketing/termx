# Saved Sessions — Design (Batch 1: local)

Approved by Michael 2026-08-17 (chat). The feature that moves him off Warp:
pin a session (name + optional description, snapshot of cwd + linked
conversation), and resume it after a TermX restart, daemon kill, or reboot.

## Decisions (Michael, 2026-08-17)

- **Resume = reattach if alive.** If the daemon still runs the terminal the
  save came from, resume focuses/attaches it. Only when it is gone does resume
  spawn a fresh shell, cd, and type `claude --resume <id>` / `codex resume <id>`.
  Never duplicates.
- **Save surfaces are configurable.** Three toggles in Settings: pane toolbar
  pin button (default ON), sidebar Saved list (default ON), conversations-rail
  save action (default OFF). Any combination.
- **Batch split.** This spec is local sessions only. Batch 2 adds SSH: host
  inventory from `~/.ssh/config`, SSH-aware save/restore
  (`ssh -t host "cd ... && claude --resume ..."`), credential policy in
  Settings (default: store passwords encrypted at rest — DPAPI-style,
  automatic; encryption optional; keys/agent-only mode also available).
  The data model below is SSH-ready (batch 2 adds an optional `ssh` block,
  no migration).

## Data model

New machine-written file `saved_sessions_v1.json` in the TermX app-data dir,
via the existing allowlisted `read_app_file`/`write_app_file` commands.
Same discipline as `ui_state_v1.json`: tolerant per-field parse (junk degrades,
never crashes), debounced writes, corrupt file → empty list.

```ts
// ui/src/saved/types.ts
export type SavedProvider = "claude" | "codex";

export interface SavedConversationRef {
  readonly provider: SavedProvider;
  readonly id: string;    // conversation id, [A-Za-z0-9-]+ (resumeCommand validates)
  readonly title: string; // display fallback
}

export interface SavedSession {
  readonly id: string;                     // uuid, TermX-generated
  readonly name: string;
  readonly description?: string;
  readonly cwd: string;                    // absolute local dir
  readonly conversation?: SavedConversationRef; // absent = bare-shell save (cd only)
  readonly lastDaemonSessionId?: number;   // for reattach-if-alive
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}
```

File shape: `{ "version": 1, "saved": SavedSession[] }`.

Upsert rule: saving when an entry with the same `conversation.id` exists
UPDATES that entry (name/description prefilled from it) instead of duplicating.
Bare-shell saves (no conversation) always create a new entry.

## Store contract (frozen — all lanes code against this)

```ts
// ui/src/saved/store.ts
export interface SavedSessionsStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly SavedSession[];       // stable ref between changes
  /** Upsert by conversation.id when present; returns the stored entry. */
  save(input: {
    name: string;
    description?: string;
    cwd: string;
    conversation?: SavedConversationRef;
    lastDaemonSessionId?: number;
  }): SavedSession;
  /** Rename / re-describe. Unknown id is a no-op. */
  update(id: string, patch: { name?: string; description?: string }): void;
  remove(id: string): void;
  /** Record the daemon session a resume just attached/created. */
  touchDaemonSession(id: string, daemonSessionId: number): void;
}
export function createSavedSessionsStore(files: AppFileStore): SavedSessionsStore;
```

## Settings additions

```
savedPaneButton: boolean        default true   // pin button in pane toolbar
savedSidebarList: boolean       default true   // Saved section in sidebar
savedConversationsRail: boolean default false  // save action on conversation rows
```

Tolerant parse like every other setting; a "Saved sessions" group in
SettingsSurface with the three toggles.

## Save flow

Pin button in the split-pane floating toolbar (next to split/close, gated on
`savedPaneButton`) opens a small dialog:

- **Name** — prefilled with the linked conversation's title, else the cwd's
  last path segment. Required, non-empty.
- **Description** — optional multiline.
- **Folder** — prefilled from `controller.sessionCwd(sessionId)`, editable.
- **Conversation** — resolved exactly like the chat view links panes
  (explicit resume key, else cwd match via `resolveLinkage`); shown as a line
  ("Resumes: <title>" or "No conversation — restores the folder only").

Save writes through `store.save(...)` with
`lastDaemonSessionId = <pane's session id>`. The conversations-rail variant
(gated on `savedConversationsRail`) saves straight from a conversation row:
cwd = record.cwd, conversation = the record, no daemon session.

## Resume flow

Sidebar gains a **Saved** section at the top (gated on `savedSidebarList`):
each row shows name, folder tail, provider badge when a conversation is
attached, description on hover/title. Row click resumes; hover actions:
edit (name/description), delete (confirm).

`WorkspaceController.resumeSaved(entry)`:

1. **Reattach**: if `entry.lastDaemonSessionId` names a session the daemon
   still runs, open/focus a tab attached to that session (existing
   session-open machinery) and stop. No duplicate terminals.
2. **Fresh restore**: probe `entry.cwd`; folder gone → notice, refuse
   (claude conversations are cwd-keyed; a bare-shell save with a vanished
   folder also refuses). Create the session with that cwd, await the shell
   prompt (existing `armResumeWait` machinery), then type the resume command
   from `resumeCommand(entry.conversation)` — or nothing for a bare-shell
   save. Record the new daemon session id via `touchDaemonSession`, and the
   resume key in `resumedTabs` so chat linkage is exact.

## Error handling

- Corrupt/missing store file → empty list, app unaffected.
- Vanished folder, dead daemon session mid-resume, unsendable command → the
  existing notice system, same wording style as `resumeSession`.
- Store writes are debounced and atomic (existing `write_app_file` temp+rename).

## Testing

- Store: parse/serialize round-trip, junk tolerance, upsert-by-conversation,
  update/remove, debounced persistence (fake AppFileStore).
- Controller: reattach-when-alive vs fresh-restore vs refusal paths.
- Components: dialog prefill + validation; Saved section rendering, gating by
  settings, edit/delete.
- Live gate: save a real session, kill only its terminal, resume → same
  conversation continues in the right folder; reattach path verified against
  a live daemon session.
