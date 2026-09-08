"""Prepare and validate a retained multi-file JavaScript compatibility packet."""
from pathlib import Path
import hashlib
import json
import subprocess
import textwrap
import time
from corpus_support import provenance, require_exact_results

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / "retired/test-artifacts/swarm-core" / f"pilot-cursor-{time.time_ns()}"


def write(relative, value):
    path = DEST / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(value).lstrip("\n"), encoding="utf-8")


write("packet/README.md", '''
# Source-aware exact cursors

Implement the cursor protocol across parser.mjs, state.mjs and client.mjs. Work
normally with your tools, verify changes, and leave a completed implementation.
No packages beyond Node's standard library are needed. Run visible checks with
`node --test visible.test.mjs`.

The old API accepted a nonnegative safe-integer cursor. New readers must continue
accepting that input, but all new cursor outputs and client requests use
`{version: 1, source: "alpha", sequence: "0"}`. Compatibility means old inputs
remain readable; old clients that require numeric outputs need an upgrade.

`parseCursor(value, expectedSource)` returns this normalized object. Undefined
and null mean sequence zero. An explicit numeric zero also means zero. Sequence
is an unsigned 64-bit integer encoded as canonical decimal text, from "0" to
"18446744073709551615" inclusive. Reject leading zeroes, signs, whitespace,
fractions, unsafe numeric input, negative values, overflow, malformed objects,
and unsupported versions with TypeError. A well-shaped cursor naming another
source throws an Error with code "STALE_SOURCE". Source strings are nonempty
ASCII identifiers supplied by the caller; do not reinterpret a different source.

`Store(source, records)` receives records whose sequence fields are unique,
positive canonical decimal strings within that range, in arbitrary order.
`read({source, cursor, limit})` rejects a different request source with
STALE_SOURCE. Limit defaults to 2 and must be an integer from 1 to 100; invalid
limits throw TypeError. Read ascending records strictly after the cursor, up to
limit, without mutating records or losing integer precision. Return
`{source, items, next}` where next is a normalized cursor at the final returned
sequence, or the requested position if no rows match. Never regress the cursor
on an empty page.

`Client(service, source)` calls the asynchronous service with that request shape.
`read(options)` uses its last successful response cursor when cursor is omitted;
an explicitly supplied zero or null resets it to the beginning. The first read
starts at zero. Every outgoing cursor uses the normalized new representation.
Validate response source and next cursor before updating saved position; a stale
or malformed response must leave the previous successful position intact. This
fixture assumes service item payloads are valid and calls are sequential.

All source identities and data are synthetic; these IDs are not credentials.
''')
write("packet/parser.mjs", '''
export function parseCursor(value, source) {
  if (value == null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("cursor");
  return value;
}
''')
write("packet/state.mjs", '''
import { parseCursor } from "./parser.mjs";

export class Store {
  constructor(source, records) { this.source = source; this.records = records; }
  read({ source, cursor, limit = 2 }) {
    const position = parseCursor(cursor, source);
    const items = [...this.records].sort((a, b) => a.sequence - b.sequence)
      .filter(row => row.sequence > position).slice(0, limit);
    return { source: this.source, items, next: items.length ? Number(items.at(-1).sequence) : position };
  }
}
''')
write("packet/client.mjs", '''
export class Client {
  constructor(service, source) { this.service = service; this.source = source; this.cursor = undefined; }
  async read(options = {}) {
    const result = await this.service({ source: this.source,
      cursor: options.cursor || this.cursor, limit: options.limit });
    this.cursor = result.next;
    return result;
  }
}
''')
write("packet/visible.test.mjs", '''
import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "./state.mjs";
import { Client } from "./client.mjs";

test("legacy input and ordinary client paging", async () => {
  const store = new Store("alpha", [{ sequence: "3" }, { sequence: "1" }, { sequence: "2" }]);
  assert.deepEqual(store.read({ source: "alpha", cursor: 1 }).items.map(r => r.sequence), ["2", "3"]);
  const client = new Client(async request => store.read(request), "alpha");
  assert.deepEqual((await client.read()).items.map(r => r.sequence), ["1", "2"]);
  assert.deepEqual((await client.read()).items.map(r => r.sequence), ["3"]);
});
''')
write("reference/parser.mjs", '''
export function stale() { return Object.assign(new Error("source changed"), { code: "STALE_SOURCE" }); }
export function parseCursor(value, source) {
  if (value == null) return { version: 1, source, sequence: "0" };
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("cursor");
    return { version: 1, source, sequence: String(value) };
  }
  if (typeof value !== "object" || Array.isArray(value) || value.version !== 1 ||
      typeof value.source !== "string" || !value.source ||
      typeof value.sequence !== "string" || !/^(0|[1-9][0-9]*)$/.test(value.sequence) ||
      BigInt(value.sequence) > 18446744073709551615n) throw new TypeError("cursor");
  if (value.source !== source) throw stale();
  return { version: 1, source, sequence: value.sequence };
}
''')
write("reference/state.mjs", '''
import { parseCursor, stale } from "./parser.mjs";

export class Store {
  constructor(source, records) { this.source = source; this.records = records; }
  read({ source, cursor, limit = 2 }) {
    if (source !== this.source) throw stale();
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit");
    const position = parseCursor(cursor, source);
    const items = this.records.filter(row => BigInt(row.sequence) > BigInt(position.sequence))
      .sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1).slice(0, limit);
    const next = { version: 1, source, sequence: items.length ? items.at(-1).sequence : position.sequence };
    return { source: this.source, items, next };
  }
}
''')
write("reference/client.mjs", '''
import { parseCursor, stale } from "./parser.mjs";

export class Client {
  constructor(service, source) { this.service = service; this.source = source; this.cursor = undefined; }
  async read(options = {}) {
    const supplied = Object.hasOwn(options, "cursor") ? options.cursor : this.cursor;
    const cursor = parseCursor(supplied, this.source);
    const result = await this.service({ source: this.source, cursor, limit: options.limit });
    if (result.source !== this.source) throw stale();
    const next = parseCursor(result.next, this.source);
    this.cursor = next;
    return { ...result, next };
  }
}
''')
write("grading/check.mjs", '''
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const root = process.argv[2];
const { parseCursor } = await import(pathToFileURL(resolve(root, "parser.mjs")));
const { Store } = await import(pathToFileURL(resolve(root, "state.mjs")));
const { Client } = await import(pathToFileURL(resolve(root, "client.mjs")));
const cursor = sequence => ({ version: 1, source: "alpha", sequence });
const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); }
}
await check("legacy and omitted positions normalize", () => {
  for (const value of [undefined, null, 0]) assert.deepEqual(parseCursor(value, "alpha"), cursor("0"));
  assert.deepEqual(parseCursor(42, "alpha"), cursor("42"));
});
await check("malformed cursor field types reject", () => {
  for (const value of [{ ...cursor("1"), sequence: 1 }, { ...cursor("1"), sequence: null },
      { version: 1, source: "alpha" }, { version: 1, sequence: "1" },
      { ...cursor("1"), source: "" }, { ...cursor("1"), source: 7 },
      { ...cursor("1"), version: "1" }])
    assert.throws(() => parseCursor(value, "alpha"), TypeError);
});
await check("cursor source mismatch is stale", () => {
  assert.throws(() => parseCursor({ ...cursor("1"), source: "beta" }, "alpha"), { code: "STALE_SOURCE" });
});
await check("store source mismatch is stale", () => {
  const store = new Store("alpha", [{ sequence: "1" }]);
  assert.throws(() => store.read({ source: "beta", cursor: 0 }), { code: "STALE_SOURCE" });
});
await check("store exact ordering and canonical next", () => {
  const records = ["9007199254740993", "9007199254740992"].map(sequence => ({ sequence }));
  const before = structuredClone(records);
  const page = new Store("alpha", records).read({ source: "alpha", cursor: 9007199254740991 });
  assert.deepEqual(page.items.map(row => row.sequence), ["9007199254740992", "9007199254740993"]);
  assert.deepEqual(page.next, cursor("9007199254740993"));
  assert.equal(page.source, "alpha");
  assert.deepEqual(records, before);
});
await check("ordinary store output uses new representation", () => {
  const store = new Store("alpha", [{ sequence: "1" }]);
  assert.deepEqual(store.read({ source: "alpha", cursor: 0 }).next, cursor("1"));
  assert.deepEqual(store.read({ source: "alpha", cursor: 8 }).next, cursor("8"));
});
await check("client normalizes first request", async () => {
  const requests = [];
  const client = new Client(async request => {
    requests.push(request);
    return { source: "alpha", items: [], next: cursor("0") };
  }, "alpha");
  await client.read();
  assert.deepEqual(requests[0].cursor, cursor("0"));
});
await check("explicit zero resets client position", async () => {
  const store = new Store("alpha", ["1", "2", "3"].map(sequence => ({ sequence })));
  const client = new Client(async request => store.read(request), "alpha");
  await client.read();
  assert.equal((await client.read({ cursor: 0, limit: 1 })).items[0].sequence, "1");
});
await check("service rejection preserves client position", async () => {
  let fail = false;
  const seen = [];
  const client = new Client(async request => {
    seen.push(request.cursor);
    if (fail) throw new Error("synthetic unavailable service");
    return { source: "alpha", items: [], next: cursor("7") };
  }, "alpha");
  await client.read();
  fail = true;
  await assert.rejects(() => client.read(), /synthetic unavailable service/);
  fail = false;
  await client.read();
  assert.deepEqual(seen.slice(1), [cursor("7"), cursor("7")]);
});
await check("parser exact range and invalid forms", () => {
  for (const sequence of ["0", "9007199254740993", "18446744073709551615"])
    assert.deepEqual(parseCursor(cursor(sequence), "alpha"), cursor(sequence));
  for (const value of [undefined, null, 0]) assert.deepEqual(parseCursor(value, "alpha"), cursor("0"));
  assert.deepEqual(parseCursor(42, "alpha"), cursor("42"));
  for (const sequence of ["", "00", "01", "+1", "-1", " 1", "1 ", "1.2", "18446744073709551616"])
    assert.throws(() => parseCursor(cursor(sequence), "alpha"), TypeError);
  for (const value of [NaN, Infinity, -1, 1.5, 9007199254740992, "1", {}, [], { ...cursor("1"), version: 2 }])
    assert.throws(() => parseCursor(value, "alpha"), TypeError);
  assert.throws(() => parseCursor({ ...cursor("1"), source: "beta" }, "alpha"), { code: "STALE_SOURCE" });
});
await check("exact end-to-end paging, empty high cursor, explicit reset", async () => {
  const records = ["9007199254740993", "1", "9007199254740992", "18446744073709551615"].map(sequence => ({ sequence }));
  const before = structuredClone(records);
  const store = new Store("alpha", records);
  const requests = [];
  const client = new Client(async request => { requests.push(structuredClone(request)); return store.read(request); }, "alpha");
  assert.deepEqual((await client.read({ cursor: cursor("9007199254740991"), limit: 1 })).items.map(r => r.sequence), ["9007199254740992"]);
  assert.deepEqual((await client.read({ limit: 1 })).items.map(r => r.sequence), ["9007199254740993"]);
  assert.deepEqual((await client.read({ limit: 1 })).next, cursor("18446744073709551615"));
  const empty = await client.read();
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.next, cursor("18446744073709551615"));
  for (const reset of [0, null]) assert.equal((await client.read({ cursor: reset, limit: 1 })).items[0].sequence, "1");
  assert.ok(requests.every(request => request.cursor.version === 1 && typeof request.cursor.sequence === "string"));
  assert.deepEqual(records, before);
});
await check("invalid limits and source do not silently proceed", () => {
  const store = new Store("alpha", [{ sequence: "1" }]);
  for (const limit of [0, -1, 101, 1.5, NaN, "2", null])
    assert.throws(() => store.read({ source: "alpha", limit }), TypeError);
  assert.throws(() => store.read({ source: "beta", cursor: 0 }), { code: "STALE_SOURCE" });
});
await check("rejected response preserves prior successful client position", async () => {
  const seen = [];
  let mode = "ok";
  const client = new Client(async request => {
    seen.push(request.cursor);
    if (mode === "stale") return { source: "beta", items: [], next: { ...cursor("99"), source: "beta" } };
    if (mode === "bad") return { source: "alpha", items: [], next: { ...cursor("99"), version: 4 } };
    return { source: "alpha", items: [], next: cursor("7") };
  }, "alpha");
  await client.read();
  mode = "stale";
  await assert.rejects(() => client.read(), { code: "STALE_SOURCE" });
  mode = "bad";
  await assert.rejects(() => client.read(), TypeError);
  mode = "ok";
  await client.read();
  assert.deepEqual(seen.slice(1), [cursor("7"), cursor("7"), cursor("7")]);
});
console.log(JSON.stringify(results, null, 2));
process.exitCode = results.every(result => result.passed) ? 0 : 1;
''')
packet = DEST / "packet"
subprocess.run(["git", "init", "-q", str(packet)], check=True)
subprocess.run(["git", "-C", str(packet), "add", "."], check=True)
subprocess.run(["git", "-C", str(packet), "commit", "-q", "-m", "Freeze synthetic compatibility input"], check=True)
expected_seed = {
    "legacy and omitted positions normalize": "failed",
    "malformed cursor field types reject": "passed",
    "cursor source mismatch is stale": "failed",
    "store source mismatch is stale": "failed",
    "store exact ordering and canonical next": "failed",
    "ordinary store output uses new representation": "failed",
    "client normalizes first request": "failed",
    "explicit zero resets client position": "failed",
    "service rejection preserves client position": "passed",
    "parser exact range and invalid forms": "failed",
    "exact end-to-end paging, empty high cursor, explicit reset": "failed",
    "invalid limits and source do not silently proceed": "failed",
    "rejected response preserves prior successful client position": "failed",
}
results = []
for label, command, cwd, expected in [
    ("visible_seed", ["node", "--test", "visible.test.mjs"], packet, 0),
    ("grading_seed", ["node", str(DEST / "grading/check.mjs"), str(packet)], DEST, 1),
    ("grading_reference", ["node", str(DEST / "grading/check.mjs"), str(DEST / "reference")], DEST, 0),
]:
    run = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=20)
    write(f"evidence/{label}.txt", run.stdout + run.stderr)
    scored = None
    if label.startswith("grading"):
        scored = json.loads(run.stdout)
        expected_map = expected_seed if label == "grading_seed" else {name: "passed" for name in expected_seed}
        require_exact_results(scored, expected_map, javascript=True)
    results.append({"check": label, "command": command, "exit_code": run.returncode,
                    "expected_exit": expected, "matches": run.returncode == expected, "test_results": scored})
write("manifest.json", json.dumps({"node": subprocess.check_output(["node", "--version"], text=True).strip(),
      **provenance(ROOT, DEST, __file__, {"cursor": packet}), "expected_seed": expected_seed,
      "results": results, "status": "prepared; no model runs; review required"}, indent=2) + "\n")
print(json.dumps({"directory": str(DEST), "checks": [{"name": row["check"], "matches": row["matches"]} for row in results]}, indent=2))
if not all(row["matches"] for row in results):
    raise SystemExit(1)
