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
