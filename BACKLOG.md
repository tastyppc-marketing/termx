# TermX Backlog

Deferred features for later sessions — in rough priority order. See `docs\superpowers\specs\2026-07-17-termx-design.md` §17 for context.

## 1. Terminal-to-terminal messaging
Sessions can send messages to each other. Rebuild of the old "smart team" plugin idea, done properly this time: reliable, minimal ceremony, no bugs-by-design. Foundation for #2 and #3.

## 2. `/forkit`
Typed in any session: opens a split pane, cd's into the correct directory, and launches `claude` or `codex` with requested flags (`--flex`, `--verbose`, `--full-control`, ...). Use case: split one working session into two chats without losing context or manually setting up the second terminal.

## 3. LLM cross-session context sharing
A session running an LLM can gather context from another session's LLM (better than manual copy-paste between two Claude Code sessions).

## 4. Smaller items
- Blocks for cmd.exe via prompt heuristics (no OSC 133 hooks exist there)
- Keybinding editor UI (config-file rebinding ships in v1)
- Installer / Start-menu integration (v1 ships as a portable folder)

## 5. M2 protocol/renderer work flagged by review round 2 (host is fine for M1)
- **Unsolicited lifecycle events**: push SessionCreated/SessionClosed/SessionExited to ALL authed clients (not just attached ones) so sidebars stay in sync without ListSessions polling.
- **Replay sanitization beyond ESC[6n**: the host strips/answers only DSR cursor queries. Other terminal-answerable queries a child app emitted (DA1 `ESC[c`, DSR 5n, OSC color queries) can sit in the ring; on replay xterm.js would auto-answer stale ones into the shell. M2 attach should feed replays through a sanitizer or use xterm.js hooks to suppress query answering during replay.
- **Replay can start mid-escape-sequence** (ring is a byte window) and cannot restore terminal modes set before the window. M2: reset terminal state (`RIS`-lite) before writing a replay, accept possibly-garbled first line, or move to a terminal-state snapshot model later.
- **Exited-but-unclosed sessions** keep their scrollback ring alive by design (so the UI can show a dead shell's last output). M2 UI must actually CloseSession when a dead tab is dismissed, else rings accumulate.
- **Structured errors**: `HostMsg::Error` is free text plus a context string; add optional `session_id` and a machine-readable code so the UI can route errors to the right pane without parsing prose.
- **M2 client note**: debounce SetLayout during drags — every SetLayout is a synchronous durable persist by design (that's what the LayoutSaved ack means).
