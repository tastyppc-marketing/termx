# Task 2 remote/shared Codex runtime proof

Date: 2026-09-08

Runtime: `codex-cli 0.153.4`, Node 24 built-in WebSocket
Probe: `tools/swarm-proof/codex-remote.test.mjs`

## Isolation and launch

The opt-in test launches one owned `codex app-server --listen ws://127.0.0.1:<ephemeral-port>` child in `.superpowers/swarm-proof/remote-agent`. It uses inherited user authentication and configuration. It does not copy, inspect, or print credentials, configuration, model reasoning, or unrelated thread history. It does not disable MCP servers, change provider/model/effort/permissions, or set a product conversation limit. `TERMX_CODEX_REMOTE_TIMEOUT_MS` is only a test-process diagnostic timeout.

Two primary threads are ephemeral and contain only synthetic prompts. At the root owner's explicit direction, the test also creates one newly generated durable synthetic thread to exercise persistence-only queue and resume behavior. It captures that new ID directly, reads only that thread, and archives only that thread after its turns settle. This durable normal-user session-store write is the explicit isolation difference from the ephemeral cases.

The default test command performs no model calls:

```powershell
node --test tools\swarm-proof\codex-remote.test.mjs
```

The explicit live command is:

```powershell
$env:TERMX_CODEX_REMOTE_LIVE='1'
node --test --test-reporter=spec tools\swarm-proof\codex-remote.test.mjs
```

Final live result: 1 test passed, 0 failed, duration 82.53 seconds (test body 77.44 seconds). The child emitted an exit event after handle-scoped termination and its PID was no longer live. No production thread ID or terminal ID was used.

## Observations

| Scenario | Result | Evidence |
|---|---|---|
| Shared runtime visibility | Observed pass | Two independently generated ephemeral thread IDs created by client A were returned together by `thread/loaded/list` to clients A and B on the same server. |
| Dynamic tool identity | Observed pass | Each of two concurrent turns caused exactly one `item/tool/call`. Each request included server-supplied `threadId`, `turnId`, `callId`, `tool = peer_signal`, and `arguments`; the response used `{contentItems:[{type:'inputText',...}], success}`. Calls matched their originating turn and thread. |
| Sender substitution rejection | Observed pass | Thread one was prompted to claim thread two's ID in tool arguments. The server-supplied `threadId` remained thread one's ID; the member-scoped handler compared the claim to that authoritative field and returned `success:false`. |
| Independent revocation | Observed pass | Removing only thread one from the handler allowlist made its next call fail while thread two's next call still succeeded. |
| Mismatched active turn | Observed pass | `turn/steer` with a random `expectedTurnId` was rejected; it did not steer the sibling. |
| Client disconnect isolation | Observed pass | Closing client B did not unload or prevent a subsequent successful tool call on thread two through client A. |
| Ephemeral rejoin | Observed limitation | Both the creating client and a second initialized client received `no rollout found` from `thread/resume`, although both could see the ephemeral IDs in the process-wide loaded list. |
| Ephemeral queue | Observed limitation | Both `thread/queue/add` and `thread/queue/start` rejected with `ephemeral thread does not support queued submissions`. |
| Durable same-server rejoin/settings | Observed pass | After the first durable queued turn persisted the rollout, client B resumed the exact captured ID. Allowlisted metadata was unchanged: ID, session ID, cwd, ephemeral flag, provider, model, reasoning effort, and direct-input capability. A later `thread/read` matched the same metadata. |
| Idle queue add versus queue start | Observed pass | `thread/queue/add` on the idle durable thread emitted `turn/started` and the turn completed without a separate start request. A second submission added while active auto-started after the first completed. Calling `thread/queue/start` for its already-consumed ID then returned `queued submission not found`. |
| Duplicate correlation key | Observed behavior | Reusing one `clientUserMessageId` while a turn was active replaced the pending queue row with a newly generated server submission ID. `thread/queue/list` contained only the replacement. Thus this runtime does not treat that key as an idempotent stable submission ID. |
| Durable read receipt and cleanup | Observed pass | `thread/read(includeTurns:true)` included the auto-started queued turn with `status = completed`; `thread/archive` then succeeded for the exact newly captured durable ID. |

## Scope limits

This proves process-shared app-server identity and routing, not that a separate app-server is required for ordinary TUI wake-up. Remote TUI composer/draft behavior and the cross-harness autonomous scenario are owned by the parent task and are not claimed here. Busy/tool-running delivery was exercised through concurrent dynamic-tool turns, but no fixed model delay was introduced, so timing-specific delivery during an intentionally held call was not separately characterized. The runtime's inability to resume or queue ephemeral threads is reported rather than bypassed.
