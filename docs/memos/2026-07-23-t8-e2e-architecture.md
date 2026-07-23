# T8 e2e architecture — decision memo

*Produced by an Opus 4.8 research agent 2026-07-23; adopted by the supervisor as the T8 implementation basis.*

## Decision: split-guarantee, no window automation. Do NOT use tauri-driver/WebdriverIO.

`HostClient.connect` takes an injectable `webSocketFactory` (`ui/src/host/client.ts`) and the client is pure transport (zero DOM). Unit tests inject a fake; the T8 test injects **Node's real WebSocket** (v24 global, no new runtime dep). The seam already ships.

"Kill UI → relaunch → reattach" decomposes into:
- **(A) Host survives a client vanishing, scrollback intact** — already green in `host/tests/e2e.rs` (abrupt WS drop, marker replay to a second client).
- **(B) Shipping UI transport rebuilds state from replay** — the only un-automated piece; needs no window.

tauri-driver/WebdriverIO rejected: pre-alpha driver; WebdriverIO owns the app lifecycle (force-kill invalidates the session — exactly T8's move); documented Windows msedgedriver orphan flake (tauri#8610); WebView2↔driver version-matching tax; and it would prove the DOM, not the host/transport that carry the guarantee.

## Layers

- **L1 (exists):** `cargo test -p termx-host` — survival, replay, orphan-free teardown.
- **L2 (T8 core, build):** `ui/src/host/__tests__/reattach.e2e.test.ts` (`// @vitest-environment node`) + `ui/vitest.e2e.config.ts` (node env, 30s timeout, includes `src/**/*.e2e.test.ts`) + npm script `test:e2e`. Spawns real `termx-host.exe` (resolved from `import.meta.url`, poll runtime.json — no absolute paths), drives the real `HostClient`. One devDep: `@xterm/headless@6.0.0` — feed accumulated bytes into a headless Terminal and assert the marker **line** via `buffer.active.getLine(n).translateToString()` (proves scrollback, not just bytes).
- **L3 (manual, ~60s):** one `tauri dev` window force-kill/relaunch smoke.

## L2 test cases

1. **Reattach reconstructs scrollback** — client A creates 2 sessions (cmd + powershell), distinct marker each, drops socket without close; client B (same port/token, host NOT respawned) auths, sees both alive, attaches with replay, each headless buffer contains its marker. *(ship-gate)*
2. **Host outlived the UI** — host PID from runtime.json still alive between drop and reconnect; runtime.json byte-identical. *(ship-gate)*
3. **Layout survives** — A `setLayout(layout_v1 blob)`; B `getState()` returns it identically.
4. **Replay→live handoff, no gap** — after B reattaches, new input produces live output contiguous after replay with no `onLostScrollback` at the boundary (exercises overlap-trim against a real ring).
5. **Dead-tab dismissal frees the ring** — exit one shell; on reattach `alive:false`; `CloseSession` → `session_closed`; ListSessions omits it. *(ship-gate; BACKLOG §5 obligation)*

Attach calls sequential (client constraint). Time-bounded polling, never fixed sleeps. Verify: `npm run test:e2e` AND `cargo test -p termx-host` both green.
