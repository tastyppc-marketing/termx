# T3 Code — Chat-Over-Coding-Agent Architecture Study

**Researched:** 2026-08-24 · **For:** TermX chat-view-over-terminal-sessions design (Rust ConPTY daemon + Tauri 2 / React 19 / xterm)

**Legend used throughout:**
- **[VERIFIED]** — read directly from T3 Code's source code or official docs (shallow clone of `main` at commit `9996038`, 2026-08-24).
- **[INFERRED]** — my reasoning from the code/docs. Plausible, but not stated by the maintainers.
- **[UNKNOWN]** — could not determine.

**Headline:** The project Michael saw is **T3 Code** (`github.com/pingdotgg/t3code`, ~20,300 stars), by Theo Browne (t3.gg) and Julius at T3 Tools Inc. It is **MIT licensed — the whole repo — so TermX may copy both patterns and code with notice.** It is *not* T3 Chat (that is Theo's separate, closed consumer LLM chat product). T3 Code calls itself an "agent harness control surface": a chat-style GUI over coding agents you already have installed. The single most important architectural answer for Michael: **Theo did not build his own agent harness.** Each agent runs through its vendor's official headless programmatic interface — Claude via the official `@anthropic-ai/claude-agent-sdk`, Codex via the `codex app-server` JSON-RPC protocol, Cursor and Grok via ACP (Zed's Agent Client Protocol), OpenCode via its SDK. Nobody drives a TUI and parses its output — which is independent confirmation that TermX's scrapped chat v3 approach (driving the Claude Code TUI) was fighting the industry-wide grain.

---

## 1. What The Project Actually Is + License

### Identity

**[VERIFIED]** `pingdotgg/t3code`, created 2026-02-08, TypeScript, actively developed (last push the day of this study; recent commit velocity is high — PR numbers in the 8000s). README: *"T3 Code is an 'agent harness control surface'. It enables control of the agents on your machine with a best-in-class mobile app (iOS, Android), web app and Electron-based desktop app."* Works with existing subscriptions on **Claude Code, Codex, Cursor, Grok Build (CLI `grok`), and OpenCode**. AGENTS.md claims **200,000+ users**.

**[VERIFIED]** Launched publicly in February 2026 built on the Codex CLI first (Theo on X: *"T3 Code is now available for everyone to use. Fully open source. Built on top of the Codex CLI"*); the other four providers were added over the following months. It was inspired by (their words) the Codex desktop app, Conductor, Claude Desktop, and Cursor Glass.

**[VERIFIED]** Not a business: *"'Wait, what are you selling me?' Nothing."* No paid tier, no account. You bring your own agent subscription. The one hosted piece is "T3 Connect" (a tunnel/relay for remote access, also in the repo under `infra/relay`), and it is out of the hot path — after connect, client traffic goes directly to your machine.

### License — the verdict

**[VERIFIED]** **MIT, repo-wide.** The `LICENSE` file at the repo root is the standard MIT text, *"Copyright (c) 2026 T3 Tools Inc."* GitHub's license detector agrees (`spdx_id: MIT`). No split licensing, no CLA gate for reading, no AGPL anywhere in the tree.

**Practical consequence for TermX: patterns AND code are both fair game**, provided the MIT notice accompanies any substantial copied portions. This is the opposite situation from the Warp study (AGPL, learn-only). Two caveats:

1. **[VERIFIED]** The repo vendors **libghostty-vt** (Ghostty's terminal core) as a WASM build for web terminal rendering, pinned in `native/libghostty-vt/VERSION` with *"the upstream `LICENSE` lives beside it."* Ghostty is MIT, so this is also copyable, but it carries its own upstream notice.
2. **[VERIFIED]** They are *"(mostly) not accepting contributions yet"* — irrelevant to copying out, but it means upstreaming TermX fixes is not a path.

---

## 2. What Drives The Agent (Michael's core question)

**Theo built an orchestration layer, not a harness.** The agent loop — the thing that talks to the model, runs tools, manages context — is always the vendor's own runtime, spoken to through its official machine interface:

| Provider | Transport | Evidence |
|---|---|---|
| Claude Code | **`@anthropic-ai/claude-agent-sdk` `^0.3.170`** — the official Agent SDK, `query()` API | `apps/server/package.json`; `apps/server/src/provider/Layers/ClaudeAdapter.ts` imports `query`, `CanUseTool`, `SDKMessage`, `PermissionMode` directly from the SDK |
| Codex | `codex app-server` JSON-RPC, via their own Effect client `packages/effect-codex-app-server` | `CodexAdapter.ts` imports from `effect-codex-app-server/schema` |
| Cursor CLI | **ACP** (Agent Client Protocol — Zed's open protocol), via their own Effect implementation `packages/effect-acp` | `CursorAdapter.ts` imports effect-acp |
| Grok Build | ACP, same `effect-acp` package | `GrokAdapter.ts` |
| OpenCode | `@opencode-ai/sdk` | `OpenCodeAdapter.ts` |

**[VERIFIED]** How the Claude session is created (`ClaudeAdapter.ts`, ~4,650 lines): one SDK `query()` per session with `includePartialMessages: true` (token-level streaming), `systemPrompt: { type: "preset", preset: "claude_code" }`, `canUseTool` callback for approvals, `permissionMode` mapped from T3's four user-facing modes, `resume: <sessionId>` for continuation, `additionalDirectories` granting the workspace plus a dedicated attachments dir (so pasted images can be Read without an approval prompt), and an injected HTTP MCP server named `t3-code` for T3's own tools. The Claude Code *binary* is still involved — the SDK spawns it via `pathToClaudeCodeExecutable` — but headless, in stream-JSON mode, never the TUI.

**[VERIFIED]** Approvals bridge: the SDK's `canUseTool` callback is turned into a first-class async request — the adapter emits a `request.opened` runtime event, the UI shows it, the user's decision comes back as an orchestration command (`thread.approval.respond`), and the callback promise resolves with allow/deny. `AskUserQuestion` and `ExitPlanMode` get special handling (`canUseTool/AskUserQuestion`, `canUseTool/ExitPlanMode`) so questions and plan-mode exits render as structured UI, not as generic tool approvals.

**[VERIFIED]** Interrupt: a client dispatches `thread.turn.interrupt`; the adapter interrupts the SDK stream fiber and classifies the result. It even distinguishes Claude's abort stamps (*"interrupting mid-tool-call yields … is_error: true, interrupting mid-stream yields 'aborted_streaming'"*) to report `interrupted` vs `failed` correctly.

**[INFERRED]** Why this matters for Michael's "did he build a whole harness?" question: the hard part of T3 Code is not the agent loop (delegated to vendors) but the **normalization layer** — five wildly different native event vocabularies mapped into one canonical schema (Section 4) so the UI is provider-agnostic. That is where their engineering went, and it is the part that is genuinely reusable thinking for TermX.

---

## 3. System Architecture

**[VERIFIED]** From `docs/internals/overview.md`:

```
┌────────────────────────────────────────────────┐
│ Clients: apps/web, apps/desktop, apps/mobile   │
│ shared runtime: packages/client-runtime        │
│  connection supervisor, RPC session, Atom state│
└──────────────────┬─────────────────────────────┘
                   │ Effect RPC over WebSocket (/ws)
                   │ contract: packages/contracts
┌──────────────────▼─────────────────────────────┐
│ apps/server  (Node, published as `npx t3`)     │
│  orchestration engine (event-sourced, SQLite)  │
│  provider driver registry (5 built-in drivers) │
│  checkpointing, VCS, terminals, filesystem     │
└──────────────────┬─────────────────────────────┘
                   │ per-driver transport (SDK / JSON-RPC / ACP)
┌──────────────────▼─────────────────────────────┐
│ Agent CLIs: Codex, Claude, Cursor, Grok,       │
│ OpenCode  — each vendor's own headless runtime │
└────────────────────────────────────────────────┘
```

- **The server is the execution boundary.** *"Every provider process, terminal, git operation, and filesystem read happens there, never in the client."* The Electron desktop app just bundles a server and loads the same web UI; the phone app is another client of the same WebSocket. This is what makes it "remote-ready" — the same property TermX's daemon/UI split already has.
- **The whole codebase is Effect-TS**, heavily: Effect Schema for every wire type, Effect RPC for the WebSocket, fibers/queues/streams server-side, `@effect/atom-react` client-side. **[INFERRED]** This is a taste choice, not a requirement of the architecture — the shapes port fine to plain TS or Rust.
- **Vocabulary** (their glossary): an **environment** is one running server + machine; a **project** is a workspace record rooted at a directory; a **thread** is the durable conversation; a **turn** is one user-to-agent cycle.

### The event-sourced core

**[VERIFIED]** The server never mutates app state directly. Clients dispatch typed **commands** (`thread.create`, `thread.turn.start`, `thread.approval.respond`, `thread.turn.interrupt`, …); a single worker fiber processes them one at a time (total order); a pure `decider.ts` turns command + state into **events**; one SQL transaction appends events, applies them to the in-memory read model via `projector.ts`, projects into persisted tables, and writes an idempotency receipt. Provider output flows back in as *internal* commands (`thread.message.assistant.delta`, `thread.session.set`) through the same pipe. Because persistence and projection share a transaction, *"the read model cannot durably disagree with the event log."* Command receipts make client retries idempotent — a resent command after a flaky connection cannot double-fire a turn.

### How streaming reaches the UI

**[VERIFIED]** Clients call the streaming RPC `orchestration.subscribeThread`. The stream's item type is a three-way union: `{kind:"snapshot", snapshot}` (full thread state), `{kind:"event", event}` (incremental), `{kind:"synchronized"}` (marker). So **late join, reconnect, and live-follow are one code path: snapshot, then deltas** — the same load-bearing idea as Warp's `event_no` resume, expressed at the read-model level instead of the byte level. A light `subscribeShell` stream drives the sidebar (thread shells — title, state, latest turn — without message bodies).

### Session persistence and resume — two layers, deliberately separate

1. **[VERIFIED]** **T3's own state** (threads, messages, activities, checkpoints, receipts) lives in the server's SQLite event store under T3 home (`~/.t3/userdata`, `state.sqlite`). Kill the server, restart, and every thread's full history projects back. Clients also keep offline caches of shell and thread snapshots (*"Shell and thread snapshots are available while offline"*), with the rule that *"cached … projections are never allowed to overwrite newer live data during a fast reconnect."*
2. **[VERIFIED]** **Provider conversation state** is resumed via an opaque per-provider `resumeCursor`. For Claude it is `{ threadId, resume: <claude session uuid>, resumeSessionAt: <last assistant message uuid>, turnCount }`, replayed into `query({ resume })` on the next turn — i.e. they lean on Claude Code's own session persistence rather than replaying the transcript themselves. The adapter validates the UUID before trusting it and tolerates the resume handshake's quirks (a late `system/init` + `result(num_turns: 0)` pair).

**[INFERRED]** This split is the right factoring for TermX too: the chat layer owns *display* history durably; the agent owns *model-context* history; a cursor ties them. Neither needs the other's format.

### Checkpoints: every turn is bracketed by hidden git refs

**[VERIFIED]** `CheckpointReactor` captures workspace state as **hidden Git refs** before and after each turn. `CheckpointDiffQuery` answers "what did this turn change" and "what did this whole thread change"; each checkpoint stores per-file additions/deletions; reverting restores **both the workspace and the provider conversation** (the resume cursor is rewound with it). In the UI this surfaces as a per-assistant-message diff stat + revert affordance and a Diff panel. Threads can also start in a **fresh git worktree per thread** (`worktreePath` on the thread model) for parallel agents on one repo.

---

## 4. The Canonical Event Model (the normalization layer)

**[VERIFIED]** `packages/contracts/src/providerRuntime.ts` defines the provider-neutral vocabulary every adapter must emit. This is the Rosetta stone of the codebase:

- **~50 runtime event types**: `session.started/configured/state.changed/exited`, `thread.started/state.changed/metadata.updated/token-usage.updated`, `turn.started/completed/aborted/plan.updated/diff.updated`, `item.started/updated/completed`, `content.delta`, `request.opened/resolved`, `user-input.requested/resolved`, `task.*` (subagents), `hook.*`, `tool.progress/summary`, `account.rate-limits.updated`, `model.rerouted`, plus realtime-audio events.
- **Canonical item types** (the things that appear in a conversation): `user_message`, `assistant_message`, `reasoning`, `plan`, and the tool-lifecycle family — `command_execution`, `file_change`, `mcp_tool_call`, `dynamic_tool_call`, `collab_agent_tool_call`, `web_search`, `image_view` — plus `review_entered/exited`, `context_compaction`, `error`.
- **Canonical request types** (things needing a human): `command_execution_approval`, `file_read_approval`, `file_change_approval`, `apply_patch_approval`, `exec_command_approval`, `mcp_elicitation_approval`, `tool_user_input`.
- **Content streams are typed**: a `content.delta` carries a `RuntimeContentStreamKind` — `assistant_text`, `reasoning_text`, `reasoning_summary_text`, `plan_text`, `command_output`, `file_change_output` — so the UI knows whether a chunk is prose, thinking, or terminal output without sniffing it.
- **Provenance is preserved**: every event may carry `raw: { source, payload }` where source is e.g. `claude.sdk.message`, `claude.sdk.permission`, `codex.app-server.notification`, `acp.jsonrpc`. Debugging never loses the native event.
- **Token usage is first-class**: `ThreadTokenUsageSnapshot` (used/max/input/cached/output/reasoning tokens, per-turn last-* variants) feeds a **context-window meter in the composer** (`ContextWindowMeter.tsx`).

**[VERIFIED]** Downstream of this, the orchestration read model stores a thread as: `messages` (plain `{role, text, streaming, turnId, attachments}` — markdown text only), `activities` (everything else: tone `info|tool|approval|error`, a human `summary` string, raw payload, turnId), `proposedPlans`, `checkpoints`, `session`. **[INFERRED]** The decision to keep chat messages *clean text* and push all tool noise into a parallel `activities` lane — rather than one interleaved blob — is what makes every downstream UI decision (collapsing, summarizing, minimap) cheap.

### Delivery-mode detail worth stealing

**[VERIFIED]** A thread can run in `buffered` assistant delivery mode: instead of streaming every delta to clients, text accumulates server-side and flushes (a) at 24,000 chars, or (b) **whenever an interaction opens — an approval or user-input request forces the buffered text out first**, so the user always has the context that led to the question. **[INFERRED]** Designed for phones/flaky links where per-token pushes are wasteful — directly relevant to TermX's future VPS/mobile story.

---

## 5. The Chat UI — What Makes It Feel Good

All from `apps/web/src` (React 19 + Vite; virtualized list is LegendList). The renderer split: `session-logic.ts` derives a **timeline** (messages | proposed-plan | turn-plan | work entries) from the thread read model; `MessagesTimeline.logic.ts` folds that into rows; `MessagesTimeline.tsx` (2,700 lines) renders. The concrete decisions Michael responded to:

1. **Tool noise collapses to one line by default.** `MAX_VISIBLE_WORK_LOG_ENTRIES = 1`. While the agent works, you see only the **live** entry (`work-live` row) — "Running `pnpm test`…" — with everything earlier folded behind a `work-toggle` row.

2. **Folded work gets an English sentence, not a count.** `summarizeToolGroup()` renders *"Read 4 files, ran 2 commands, and changed 1 file"* — grouped by action (read / edit / command / code-search / web-search / other), with edits counted by **distinct file** rather than raw tool calls, and superseded in-progress markers deduplicated so a start+finish pair counts once. Failure anywhere in the group flags the summary row (`hasFailure`).

3. **Whole turns fold too.** Older turns collapse behind `turn-fold` rows, so a long session reads as: my message → one-line summary of the work → the answer, repeated. The chat stays an *argument*, not a log.

4. **Approvals live at the composer, not buried in scrollback.** Pending approvals render as a compact panel **attached to the input box** (`ComposerPendingApprovalPanel`: the command/diff in a scrollable `<code>` block, an app name, and a `1/N` counter when several are queued), with approve/deny as the composer's primary actions. The place your eyes already are is the place the decision appears. Structured questions (`AskUserQuestion`) get a stepper — "Next question" → "Submit answers" — in the same spot.

5. **Streaming without scroll-jank.** Live-follow disarms the moment you scroll up and re-arms only within a **40px band** of the true bottom (`TIMELINE_FOLLOW_REARM_THRESHOLD_PX`), with an explicit comment that the framework's half-viewport "near end" default *"yanked \[users\] back down on the next stream chunk"* while reading history. Content column is capped at **768px** (`TIMELINE_CONTENT_MAX_WIDTH`).

6. **A timeline minimap.** A slim rail on the right maps every message; hover expands it into a hoverable index of the conversation; click jumps. Long agent sessions become navigable the way a scrollbar never makes them.

7. **Diffs and revert ride on the message.** Each assistant message row can carry `assistantTurnDiffSummary` (+N −M across files) and a `revertTurnCount`; clicking opens the lazy-loaded Diff panel; revert restores workspace *and* conversation to that checkpoint.

8. **Steer, don't just stop.** While a turn runs, the composer keeps accepting input — sending steers the running agent; Stop (`onInterrupt`) is beside it. (A code comment notes mobile deliberately keeps send-while-running available so *"a running turn could not be steered"* never happens.) There is also a **prompt stash** for parking a draft.

9. **Real terminals are one drawer away.** Every thread has a resizable bottom terminal drawer (server-owned PTYs, up to 4 per group, splits) rendered with **libghostty-vt compiled to WASM** on a Canvas — *"React does not participate in terminal frames."* Killer detail: you can **select terminal output and attach it as context to the next chat message** (`TerminalContextSelection` → composer chips). The chat and the terminal are one workspace, not two apps.

10. **Session state is glanceable everywhere.** Threads carry `running/settled` state up into the sidebar (active / pinned / snoozed / settled shelves — an inbox model for parallel agents), the composer shows the context-window meter and rate-limit state, and per-turn model/effort is recorded on `turn.started`.

Supporting cast: `/` command menu with provider slash-commands and skills merged in (`$` for skills, deduped against native commands), image paste/upload, four permission modes set per-thread from the composer (Supervised / Auto-accept edits / Auto / Full access — each adapter translates to its provider's native enforcement; Claude gets `permissionMode`, Codex gets approval policy + sandbox level), plan mode as a first-class `interactionMode` with proposed-plan cards and "Implement plan in new thread."

---

## 6. Reconnection & Remote (Michael's adoption blocker, their answer)

**[VERIFIED]** From `docs/internals/connection-runtime.md` — the whole reconnect policy lives in one client-side **connection supervisor** (`packages/client-runtime/src/connection/supervisor.ts`), and React components are forbidden from creating connections or retry loops:

- The RPC session factory performs **one attempt, no retry**; the supervisor owns all retry. Transient failures retry **forever** with exponential backoff capped at 16s; 30 stable seconds resets the ladder. Offline devices *wait for a signal* instead of burning timers.
- Foregrounding the app **probes** the existing session instead of reconnecting (*"a healthy session survives foregrounding"*); only a real background suspension (`application-active-reconnect`) replaces the socket outright.
- **Transport failures vs domain failures are handled differently**: a transport failure ends the subscription and waits for a replacement session; a domain failure resubscribes on the *same* session. *"A healthy transport is never torn down for a domain failure."*
- Connection state shown to the user is derived, honest, and fine-grained: `connected` means the socket opened *and* the initial config RPC succeeded; a live transport with a failed thread subscription shows "connected, sync error" — not a fake "reconnecting."
- Because the server is the source of truth and `subscribeThread` starts with a snapshot, **a reconnecting client loses nothing** — it re-snapshots and continues. Combined with offline caches, a phone can render the last-known thread instantly, then heal.

**[VERIFIED]** Remote access is three-tier: same-LAN direct, Tailscale (first-class wrapper package), or their hosted relay ("T3 Connect") for discovery/tunnel — with per-method auth scopes on the WebSocket (holding a socket ≠ authorization to call everything; `RPC_REQUIRED_SCOPE` maps each method to a scope).

---

## 7. What TermX Should Take

### (a) Applicable NOW — chat-view-over-terminal-sessions, no harness required

1. **The reconnect discipline is copyable today and touches nothing about agents.** One supervisor owning desired-state/retry/backoff (forever, 16s cap, reset after 30s stable); single-attempt session factory; probe-don't-reconnect on refocus; transport-vs-domain failure split; "connected" only after a real round-trip succeeds. This maps 1:1 onto TermX's existing daemon WebSocket and is aimed squarely at Michael's stated adoption blocker. MIT means the supervisor's state machine (`packages/client-runtime/src/connection/supervisor.ts`) can be ported, not just imitated.
2. **Snapshot-then-deltas as the only subscription shape.** `subscribeThread`/`subscribeShell` returning `snapshot | event | synchronized` makes late-join, reconnect, and live-follow one code path. TermX's chat read-layer over terminal sessions should speak exactly this shape from the daemon, whatever the payload is.
3. **The timeline UX pack** — these are pure-frontend decisions TermX can apply to *any* event source, including a coarse one:
   - default-collapse work to one live line; fold history behind an English summary sentence ("Read 4 files and ran 2 commands"), counting edits by distinct file;
   - fold whole past turns; keep the transcript an argument, not a log;
   - 768px content column; 40px follow re-arm band so streaming never yanks a reading user down;
   - the hover-expanding timeline minimap for long sessions;
   - pending approvals/questions anchored **at the composer**, with a 1/N queue counter.
4. **Two-lane thread model: clean `messages` + parallel `activities`.** Even a read-layer should never interleave tool noise into message text. Whatever TermX can extract from a session (and Claude Code's own on-disk session transcripts — the JSONL files under `~/.claude/projects/` — are a structured, harness-free source for exactly the `messages`/tool-use lane; the pane keeps owning input), store prose and work-events in separate lanes keyed by turn.
5. **Terminal-selection-as-context.** Select text in the terminal pane → it becomes a context chip on the chat composer → lands in the next prompt. T3 Code proves the interaction; TermX already owns real terminals, so this is arguably *easier* in TermX and is a differentiator no chat-only tool can match.
6. **Sidebar-as-inbox for parallel sessions.** Thread shells (title, running/settled, latest-turn state) streamed separately from bodies; active/pinned/snoozed/settled shelves. Maps directly onto TermX's sidebar-groups work — a session that "raises its hand" (approval pending, turn finished) is the organizing signal.
7. **Ghostty-as-library prior art.** They render terminals on web via `libghostty-vt` → WASM → Canvas with React excluded from the frame path, restoring scrollback with the PTY callback detached so stale device queries can't reply into the live shell. Worth a note in TermX's renderer file even if xterm stays.

### (b) Only if/when Michael builds his own harness (or SDK-drives sessions) later

1. **The Claude Agent SDK integration recipe, whole.** `ClaudeAdapter.ts` is a working, battle-tested map of `query()` options (resume, includePartialMessages, canUseTool, permissionMode ↔ user-facing modes, additionalDirectories, injected MCP server, preset system prompt), abort-reason classification, resume-cursor validation, and the AskUserQuestion/ExitPlanMode special cases. When TermX eventually wants SDK-driven sessions, start here — it is MIT and it already handles the edge cases chat v3 died on.
2. **The canonical provider-runtime vocabulary** (`providerRuntime.ts`): the ~50 event types, item types, request types, and typed content-stream kinds, with `raw` provenance on every event. Adopting this schema (or a subset) as the daemon's chat-event contract future-proofs a multi-agent TermX (Claude + Codex + Grok are all CLIs Michael already runs).
3. **The event-sourced orchestration core**: single-fiber command queue, pure decider, projector in the same SQL transaction, idempotent command receipts, drainable workers for deterministic tests. This is the "harness-adjacent" server machinery — overkill for a read-layer, right-sized for a control-layer.
4. **Turn-bracketing checkpoints as hidden git refs** with per-turn diff/revert that rewinds workspace *and* conversation together, and worktree-per-thread for parallel agents.
5. **Buffered assistant delivery** (24k-char spill + flush-on-interaction) for the VPS/mobile future.
6. **effect-acp**: a complete MIT TypeScript ACP implementation. If TermX ever wants to control agents through a neutral protocol instead of per-vendor SDKs, this package plus the Cursor/Grok adapters show how far ACP gets you today.

### (c) Forbidden / learn-only

**Nothing in this repo is license-forbidden.** MIT across the tree (including the vendored ghostty artifacts, which are themselves MIT with an upstream notice to carry). The only obligations and cautions:

1. **Carry notices**: include T3 Tools Inc.'s MIT notice with any substantial copied code, and Ghostty's if the WASM/vt artifacts are taken.
2. **Do not confuse T3 Code with T3 Chat.** T3 Chat is Theo's separate closed-source consumer product; nothing from it is available, and none of this study covers it.
3. **[INFERRED] Don't import the Effect-TS ecosystem as a side effect of copying.** The valuable IP here is shapes and policies, not the framework. Porting the supervisor or the schema into TermX's existing React/Rust idioms keeps the win without adopting a large new dependency and its learning curve.
4. **Don't upstream-depend**: they are explicitly not accepting feature contributions, and the project is alpha with high churn — copy at a pinned commit, note the commit hash next to anything ported.

---

## 8. Sources

**Primary — source code (MIT; clone at commit `9996038`, 2026-08-24):**
- [pingdotgg/t3code](https://github.com/pingdotgg/t3code) — `LICENSE`, `README.md`, `AGENTS.md`
- `docs/internals/overview.md`, `providers.md`, `connection-runtime.md`, `workspace-layout.md`, `remote.md`; `docs/architecture/terminal-renderers.md`; `docs/user/permission-modes.md`, `composer.md`, `thread-sidebar.md`
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`, `Drivers/ClaudeDriver.ts`, `apps/server/package.json`
- `packages/contracts/src/providerRuntime.ts`, `orchestration.ts`, `rpc.ts`
- `apps/web/src/session-logic.ts`, `components/chat/MessagesTimeline.logic.ts`, `components/chat/ComposerPendingApprovalPanel.tsx`, `components/chat/ComposerPrimaryActions.tsx`, `components/ThreadTerminalDrawer.tsx`
- Local study clone: `C:\Users\mjfos\AppData\Local\Temp\claude\C--Dev\7e673402-8c77-471b-bbda-fa825fd7a42e\scratchpad\t3code`

**Announcements & third-party:**
- [Theo on X — "T3 Code is now available for everyone to use. Fully open source."](https://x.com/theo/status/2030071716530245800)
- [T3 Code site](https://t3.codes) · [web app](https://app.t3.codes)
- [Better Stack — T3 Code: An Open-Source GUI for Managing AI Coding Agents](https://betterstack.com/community/guides/ai/t3-code/)
- [T3 Code FAQ (t3codedocs.com)](https://t3codedocs.com/faq) — pricing/licensing confirmation (third-party site; license verified from the repo itself)
