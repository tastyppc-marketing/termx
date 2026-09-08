# Retained host testing

The test-preservation prerequisite is complete at `5c1b12c`. Host tests now keep
their fixtures under the worktree's `retired/test-artifacts/host` directory.
All 96 former TempDir sites and one NamedTempFile site use retained storage.
Exact synthetic files displaced by failure tests move to retained locations.

Test-only cleanup hooks validate and preserve regular files before removal and
stop on unpreservable links or metadata errors. Copies check opened regular-file
handles, original path ancestors and byte limits. Controlled tree snapshots have
entry/directory/byte bounds and retain partial copies on failure. These are
non-atomic test-fixture snapshots; concurrent writes can still change a source
within its bound.

Real-binary tests start hidden children suspended, assign the exact process to a
private Windows job, then resume it. Cleanup waits are bounded and preserve
diagnostics, including startup failure. The regression verifies parent and
descendant termination while a separately owned sentinel remains alive. It uses
controlled waits, so natural process expiry cannot substitute for cleanup.

The change is confined to test code, cfg(test) hooks and package formatting.
Release cleanup behavior and normal host startup are unchanged. Existing
formatting drift was corrected after retaining the pre-format source files.

SOL implemented the changes. Root reviewed file preservation, and an independent
reviewer checked process ownership; the identified failure paths were corrected
before final approval. The final frozen source passed **206 tests**, package
formatting, strict all-target Clippy and release binary builds. All four native
exits were zero, from 20:33:11 through 20:34:27 UTC on 2026-09-08.

Evidence root:
`retired/test-artifacts/host/test-preservation-20260908T1948064018277Z-113752`.
The final aggregate is `20260908T203439215868Z-final-evidence/manifest.json`,
SHA-256 `f0526a93a1fd057dfb6b046af733295e7626f39140c66488e09eec34b97c4506`.
Root reconciled 16 source/manifest inputs and retained copies with Git, eight
logs, command exits, test counts and three retained release artifacts. The
dedicated Cargo target was reused; earlier artifacts and failed/superseded
reports were preserved separately.

The retained host executable is 3,249,152 bytes, SHA-256
`f154866ada10f7d36ed8faf214684cf8f7164f417dde16fbd10529c8657648fa`.
It was not installed over the running application. Companion runtime integration
and native collaboration acceptance remain subsequent work in the
[integration plan](../plans/2026-09-08-swarm-companion-integration.md).
