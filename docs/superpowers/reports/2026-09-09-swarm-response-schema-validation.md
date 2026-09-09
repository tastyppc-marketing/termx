# Borrowed peer response schema checkpoint

This host-library slice validates the actual version-1 peer reply envelope and all nine ordinary peer result DTOs without constructing payload trees or decoded large strings. It checks correlation, operation/outcome agreement, required/unknown fields, nested enum shapes, exact integers, decoded UTF-8 lengths and existing array limits. Errors remain errors; only the currently emitted error detail shapes are accepted. `FetchContext` uses a separate protected publication flow.

The public API is `inspect_peer_response`, `BorrowedPeerResponse::{payload_json,outcome_kind,is_error}`, and `peer_response_frame_limit` in `host/src/swarm/response.rs`. Whole-frame JSON validation runs first. Complete frame ceilings match the current host RPC classes: 128 KiB control, 2 MiB plus 64 KiB metadata, and 8 MiB plus 64 KiB send/message results. These checks do not replace native prefix-time bounds or pre-dispatch memory admission.

The returned value borrows the exact immutable payload span. It proves syntax/schema/correlation, not authentication or authorization. Native verified frame ownership and helper dispatch remain integration work. The 8 KiB scratch value is an analytical conservative allowance for fixed state and the bounded schema call graph, not measured peak memory. There are no new dependencies or Cargo changes.

Root read the implementation, reconciled all three changed source files against their frozen copies, verified eight preserved non-owned inputs, and independently reran the 11 focused tests: native exit 0 on September 9 at 08:26:43 UTC. Tests cover all nine typed success outcomes, all error codes and source availability variants, strict correlation/schema failures, integer endpoints, Unicode, exact/+1 frame and nested array caps, and the actual 8,031,440-byte outgoing page with 614,671 JSON work nodes. Current-source strict focused Clippy and owned-file rustfmt checks also have verified native exit 0.

Evidence root: `retired/test-artifacts/swarm-response-schema/20260909T080000000000Z` in the `swarm-response-schema` worktree. Source freeze: `20260909T0825125689472Z-source-freeze/source-manifest.json`. Root reconciliation SHA-256: `397c27e2c5658798ab4f50c2baac463b10e1aded30a8bc421453a7e3d18a516c`.

Source SHA-256:

- `host/src/swarm/response.rs`: `95ce2dc657a35e504f3f76bbe4c8586b253c6aa254ae41a837cbb8879bc695da`.
- `host/tests/swarm_response.rs`: `df8060cb8634e1cb716483507abea9047b2ebfae463b6ff0893ed710c116dbd6`.
- `host/src/swarm/mod.rs`: `6d5cfa5f8539228857832c2330b4fb0a45e7ecf00d1bebf1915606d0c15ca0fa`.

The missing-API RED, intermediate compiler/style errors, and behavioral negative-zero failure are retained. Negative zero now fails exact integer validation; test fixture and style corrections did not change existing core DTOs or expected behavior.

Full host tests, docs, strict all-target and production release lint, and release build are deferred to the coordinated combined host run with inventory and transport changes. This checkpoint is not an installed feature or end-to-end acceptance.
