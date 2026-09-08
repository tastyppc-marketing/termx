# First Windows cross-harness collaboration proof

Date: 2026-09-08. Scope: Stage 0 of the approved [design](../specs/2026-09-08-cross-harness-collaboration-design.md).

**Result:** Discretionary collaboration worked between a real Codex/Astra session and a real Claude Code/Fable session. Each independently read peer context, sent findings, challenged an assumption, and refined its answer. A later agent-chosen message woke an idle peer without a human submission or message approval. This is a feasibility milestone, not a shipped TermX feature or completion of the full Stage 0 matrix.

The application and terminal host were not changed or deployed. Tests used newly created conversations in synthetic folders. No preexisting user conversation was messaged or resumed. Ordinary harnesses necessarily saved these synthetic conversations in their normal session stores; the probe workspace, tool configuration, and audit artifacts were isolated under the ignored `.superpowers/swarm-proof/` directory. Normal authentication was used without copying credentials into the repository or report.

## Observed capability matrix

| Path or behavior | Observation | What this proves / limitation |
| --- | --- | --- |
| Ordinary Windows Codex 0.153.4, empty new conversation | `codex queue` failed with `no rollout found for thread id`. | An unsaved thread is not queue-ready merely because its TUI is open. |
| Same ordinary Codex TUI after its first saved turn | The native queue command accepted a message; the original process started a turn and replied with the unique test marker. | A remote app-server launch is not necessary for this observed existing-TUI receive path. This does not establish an externally attachable control endpoint. |
| Codex composer draft | A native peer message was answered while `DRAFT_UNSENT_92C1` stayed in the composer. | Native delivery did not submit, replace, or clear the draft. |
| Codex running tool | A message was queued while a 15-second Python tool was still running. The tool finished successfully, then the peer message was processed. | This observed queue path preserved the running tool and deferred the message. |
| Claude Code 2.1.263, scoped inbound `accept` | Authenticated native peer input woke the original process; the response contained the unique marker. | Receive/wake works through the native named pipe using the peer credential. The child credential was not used. |
| Claude exact-session mismatch | A frame with a different session ID produced no test response; a correctly addressed frame subsequently worked. | Negative characterization against the same verified endpoint; this is not a complete malformed-frame/failure matrix. |
| Claude composer draft | Claude answered native input while `UNSENT_CLAUDE_DRAFT_A819` remained in the composer. | Native delivery preserved the draft. |
| Direct shell helper | Windows management queries failed in Codex's sandbox; a later native implementation passed identity checking but could not write an audit outside the writable folder. Claude's auto classifier denied the shell-based peer-context read. | A shell helper is not a dependable no-prompt baseline under these ordinary permissions. No escalation or permission bypass was used to force it through. |
| Scoped MCP tools, ordinary Codex and Claude TUIs | Both discovered the three tools, read the other conversation, and sent messages without individual approval prompts. | A one-time grant of specific collaboration tools works. This test installed them during a deliberate handoff of disposable sessions, not by hot-enrolling an arbitrary running session. |
| Shared Codex WebSocket runtime | Two ephemeral threads invoked dynamic tools with server-supplied thread/turn/call identities; sender substitution was rejected and one peer could be revoked independently. | Dynamic tools provide a thread-aware adapter path. A shared MCP process PID alone remains insufficient. |
| Ephemeral Codex runtime limitations | Native queue operations rejected ephemeral threads; live rejoin through `thread/resume` reported no rollout. | Ephemeral results must not be generalized to durable conversations. See the opt-in live test for the separately exercised durable path. |
| Durable Codex same-server rejoin | A second initialized client resumed the exact newly generated durable thread after persistence, read its completed queued turn, and archived that exact thread. Returned effective model/provider, effort, service tier, cwd/workspace roots, instruction-source paths, approval/reviewer, sandbox, and active permission profile matched. | Rejoin and these returned settings matched for this owned thread. Full configuration-source and custom-launch parity remain unproved. |
| Durable Codex queue lifecycle | Idle `thread/queue/add` started a turn without a separate start request; a pending submission started after an active turn. Starting an already-consumed queue ID returned not-found. | Some submissions auto-start. Reconcile each native submission ID independently; native acceptance alone does not prove consumption. |
| Codex duplicate client correlation while definitely active | With a real dynamic-tool call held open, two additions using the same `clientUserMessageId` produced two distinct pending native queue rows. | The native queue did not deduplicate this pair. The broker needs its own idempotent commit and reconciliation; an ambiguous native outcome cannot be retried blindly. |
| Exact pending-row cancellation | The probe deleted only its second duplicate submission ID and verified that the first remained pending before releasing the held tool. | This observed cancellation was scoped to an exact broker-owned test entry. It is not a complete pause/remove race proof. |
| Codex active-turn mismatch | A wrong expected turn ID was rejected with the specific mismatch error while a real dynamic-tool handler was held open; the original turn continued after release. | This tests an actual active turn, without relying on a sleep or accepting a generic idle-thread error. |

## The agent-chosen interaction

The agents were given a shared synthetic question: how should a sender recover after losing an acknowledgement? Each had complementary hypothetical evidence. Neither was required to send a certain number of messages, take a specific role, use a prescribed discussion pattern, or reply to every message.

The probe exposed `list_peers`, `read_peer_context`, and `send_message`. Calling identity came from the tool process's verified ancestry and exact native process creation time. The tools accepted no sender ID. Peer reads selected only the two generated conversation IDs and excluded internal reasoning; the prototype returned a recent view with completeness metadata, not a production paginated history service.

The scoped MCP run produced these events (UTC):

| Time | Evidence |
| --- | --- |
| 09:59:26 | Codex chose to read Claude's recorded context. |
| 09:59:30 | Claude chose to read Codex's recorded context. |
| 09:59:39 | Codex sent a substantive correction: an unknown lookup result does not prove nonexecution, so lookup-first alone cannot prevent duplicate effects. |
| 09:59:53 | Claude sent a revised design incorporating a claim-before-act requirement and the distinction between queue acceptance and completed effects. |
| 10:00:09 | Claude sent a closing clarification. |
| 10:00:25 | Claude finished its current turn. |
| 10:00:51 | Codex independently sent a further refinement about queue evidence and crash recovery. The native Claude transcript recorded this exact message as a peer-origin user item. |
| 10:01:05 | Claude answered the new message, accepted the refinements, and decided no further peer reply was needed. |
| 10:01:09 | Claude finished the awakened turn. |

Codex likewise drained Claude's queued messages after finishing its own active turn, preserving their order. No controller relayed model answers between these tool calls. The controller supplied setup corrections during the earlier failing shell experiment and a broad introduction for the MCP run; there were no controller submissions between the MCP context reads and the later idle wake.

The discussion's proposed retry policy is synthetic agent output, not a new TermX limit. The transport observation about duplicate correlations in the initial prompt was a hypothetical input to this discussion, not an empirical claim about the tested native queue.

## Identity, provenance, and delivery lessons

Windows WMI/CIM rounded one creation timestamp from `134333340743496937` to `134333340743496930`. Exact comparison against the native FILETIME therefore rejected a valid process. The probe switched to `CreateToolhelp32Snapshot` plus `GetProcessTimes`, retaining the full value. Production identity code must not compare a rounded management timestamp against an exact native timestamp or weaken the check with a time tolerance.

The Claude transport verified the named-pipe server PID using `GetNamedPipeServerProcessId`, checked the process generation and peer-key generation, and supplied the expected session UUID. It used the native peer token, never the own-child token. Socket write success was reported only as `transport-written`; Codex CLI success was reported as `native-queued`. Neither was called an agent acknowledgement or comprehension.

Claude persists native input differently depending on when it arrives: the busy-path message appeared as an attachment, whereas the later idle message became a user item with peer origin. Tool results can also quote message IDs from a context read. A receipt detector must inspect record type and provenance; a text search for a UUID can mistake a quoted tool result for direct delivery.

Codex's tested CLI queue persists its input as a user message; the test supplied a clearly marked peer envelope, but that label alone does not establish a native peer trust class. For production, use the queue for a fixed broker-authored inbox notification and return the actual peer body through the scoped mailbox tool. Do not embed peer-controlled instructions, names, or topic text into that user-role wake notification. This makes the design's existing coalesced-notification preference important to source attribution as well as delivery efficiency. Native input/approval boundaries still require explicit tests.

The two disposable sessions were deliberately closed before resuming their same conversation IDs with the MCP configuration. Their process generations were then rebound explicitly in the test manifest. This proves a controlled setup path, not hot registration, automatic inheritance by a replacement process, or a complete production continuation transaction.

## Configuration and model coverage

Codex used the installed 0.153.4 binary and the existing OpenAI route, `gpt-6-astra`, `xhigh`, and priority service. Its ordinary TUI displayed Workspace permissions with approval requests enabled before the test. The resumed MCP run still reported the same model and effort. No model/provider/ordinary-permission override was added for message delivery.

Claude used the actual PowerShell `claude` wrapper, installed 2.1.263, and its default Fable 5.1 model with high effort and auto permission mode. Session-scoped `crossSessionInbound: accept` was set for the test. The MCP run added only the test server and explicit allow rules for its three tools. User-wide settings were not changed.

The user's Claude/Astra launch command was requested during the work; it was not available when these results were recorded. Therefore Claude/Astra routing parity remains unverified. The working experiment demonstrates different harnesses and different models, not that particular custom route.

## Reproduction and retained artifacts

The dependency-free RPC helper and an opt-in shared-runtime characterization test are retained in [`tools/swarm-proof`](../../../tools/swarm-proof/README.md). The live test requires explicit activation and uses the installed CLI and normal authentication; default test runs do not call a model.

The ordinary-TUI experiment was driven through disposable PTY sessions using these native entry points:

```text
codex --no-alt-screen -C <synthetic-folder>
codex queue --thread <exact-generated-thread-id> --message <peer-envelope>
claude --session-id <generated-id> --settings <scoped-settings.json>
```

The MCP setup used project-scoped Codex configuration with `default_tools_approval_mode = "approve"` on the test server and exactly three enabled tools. Claude loaded the test MCP configuration at launch and received explicit `--allowedTools` entries for those three tools. These settings granted the collaboration surface; they did not disable normal command approvals or mislabel sending as read-only. References: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude MCP configuration](https://code.claude.com/docs/en/mcp).

The disposable Python/PowerShell bridge, generated peer manifest, raw terminal captures, and synthetic-session audit remain ignored local experiment artifacts. They are not packaged adapters. The production broker still needs server-side membership enforcement, durable transactions, generation fencing, and the complete context contract in the design.

All 31 captured processes belonging to the final pair of test sessions exited. The original TermX host remained running. The first pair's original process IDs were verified exited before their MCP handoff. No TermX binary was replaced.

The retained RPC helper passed 17 tests. The shared-runtime characterization is opt-in; its default run skips model calls. Review exposed two weak timing assumptions in the first live probe: its duplicate-key check did not hold the first submission pending, and its mismatched-turn check ran while idle. A stronger probe holds a real dynamic-tool call open. That experiment disproved the initial replacement inference by observing two pending rows with the same client key. The finding is retained rather than treating the original passing run as sufficient evidence.

The corrected live run passed 1/1 in 71.27 seconds. The live probe uses its owned app-server child handle for termination and checks that the child exited. It archives only its newly created durable synthetic thread; archiving retains that synthetic history in the normal user store. Separate native snapshots captured 31, 44, and 44 process generations in earlier failing runs, and 45 in the final passing run. Every captured generation was verified exited after its respective run. Independent code review and exact commands are recorded with this milestone's implementation plan.

Subsequent review hardening added five tests for malformed JSON/binary frames and required metadata presence/shape. The combined default suite passed 22 tests with one live skip. A fresh live run of those validators passed 1/1 in 82.39 seconds; all 45 captured process generations from that run also exited. Both review findings were independently re-reviewed as resolved. The published checkpoint and continued internal-core work remain distinct from a shipped collaboration feature.

## Remaining gates before shipping

- Session-scoped activation of tools and inbound policy in arbitrary already-running sessions, without a deliberate restart/handoff; managed/project policy precedence and full accept/hold/refuse matrix.
- Claude/Astra custom launch parity, plus a full effective configuration-source and permission comparison across supported setup paths.
- Pending approval/input states, interruption semantics, queue retry/deduplication races, lost native acknowledgements, pause/remove races, and process/source replacement.
- Successful explicit `thread/queue/start` of a pending row and turn-identifier behavior for repeated client keys. The retained probe establishes two pending rows, removes its second exact row, and separately characterizes automatic starts and rejection after consumption; it does not infer these missing behaviors from event timeouts.
- The production owner handshake, independent broker authorization, durable mailbox, message reconciliation, context paging/compaction/shared-source handling, and visible pause/disconnect controls.
- Real native remote-TUI composer and approval ownership behavior if that activation path is offered. Headless WebSocket results do not cover it.

The original host baseline run had 168 passing library tests and one failure in `ring_eviction_spills_to_the_history_file`. Its isolated rerun passed. The unchanged test stops polling at the first history/ring boundary match, which does not guarantee that the requested shell output has arrived; this is a timing-sensitive baseline result, not evidence that swarm code changed terminal behavior. No broad host stability claim is made from this proof.
