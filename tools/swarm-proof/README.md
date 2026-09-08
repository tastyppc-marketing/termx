# Windows collaboration probes

These are development probes for the [approved design](../../docs/superpowers/specs/2026-09-08-cross-harness-collaboration-design.md), not an installed TermX feature. Read the [observed results and remaining gates](../../docs/superpowers/reports/2026-09-08-swarm-windows-proof.md) before interpreting a passing test.

Run the dependency-free transport tests with Node 24 or newer:

```powershell
node --test tools/swarm-proof/rpc.test.mjs
node --test tools/swarm-proof/codex-remote.test.mjs
```

The second command skips live integration by default. Explicitly enable the shared-runtime test on Windows with an installed, authenticated Codex CLI:

```powershell
$env:TERMX_CODEX_EXE = 'C:\path\to\codex.exe'
$env:TERMX_CODEX_REMOTE_LIVE = '1'
node --test tools/swarm-proof/codex-remote.test.mjs
Remove-Item Env:\TERMX_CODEX_REMOTE_LIVE
```

The opt-in run starts its own loopback app-server, makes real model calls, and uses normal CLI authentication and configuration. Scratch files live below `.superpowers/swarm-proof/remote-agent`. Ephemeral and newly created durable test threads are distinct cases; the test does not attach to an existing user conversation. Native methods and expected behavior are version-specific (observed Codex 0.153.4).

`rpc.mjs` correlates requests, preserves bounded events for later waits, and rejects ambiguous/disconnected transport states. It does not authenticate peers, implement a durable mailbox, or establish that an agent consumed a message. The live adapter owns framing, process lifecycle, and its native capability assertions.

The exploratory ordinary-TUI/Claude MCP bridge was intentionally kept in ignored local scratch storage; its observations are documented in the report. Product code must implement the stronger authorization, persistence, and context contracts in the design instead of treating a disposable helper as the broker.
