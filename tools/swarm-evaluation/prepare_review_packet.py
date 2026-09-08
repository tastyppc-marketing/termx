"""Retain a review packet and independent witnesses; no model execution or cleanup."""
from pathlib import Path
import difflib
import hashlib
import json
import subprocess
import sys
import textwrap
import time
from corpus_support import provenance, require_exact_results, unittest_results, unittest_runner

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / "retired/test-artifacts/swarm-core" / f"pilot-review-{time.time_ns()}"


def write(relative, value):
    path = DEST / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    value = textwrap.dedent(value).lstrip("\n")
    if relative == "grading/witnesses.py":
        value = value.replace("unittest.main()", unittest_runner())
    path.write_text(value, encoding="utf-8")


original = '''\
class Outbox:
    def __init__(self):
        self.messages = {}
        self.keys = {}
        self.pending = set()
        self.acks = set()

    def send(self, sender, key, recipients, body):
        dedup = (sender, key)
        if dedup in self.keys:
            return self.keys[dedup]
        message = len(self.messages) + 1
        recipients = set(recipients)
        self.messages[message] = {"sender": sender, "recipients": recipients, "body": body}
        self.keys[dedup] = message
        self.pending.update((message, recipient) for recipient in recipients)
        return message

    def flush(self, transport):
        for message, recipient in list(self.pending):
            transport(message, recipient, self.messages[message]["body"])
            self.pending.remove((message, recipient))

    def acknowledge(self, message, recipient):
        if recipient not in self.messages[message]["recipients"]:
            raise ValueError("not a recipient")
        self.acks.add((message, recipient))

    def acknowledged(self, message, recipient):
        return (message, recipient) in self.acks
'''
proposed = '''\
class Outbox:
    def __init__(self):
        self.messages = {}
        self.keys = {}
        self.pending = set()
        self.acks = set()

    def send(self, group, sender, key, recipients, body):
        dedup = (sender, key)
        if dedup in self.keys:
            return self.keys[dedup]
        message = len(self.messages) + 1
        recipients = set(recipients)
        self.messages[message] = {"group": group, "sender": sender,
                                  "recipients": recipients, "body": body}
        self.keys[dedup] = message
        self.pending.update((message, recipient) for recipient in recipients)
        return message

    def message(self, message):
        record = dict(self.messages[message])
        record["recipients"] = set(record["recipients"])
        return record

    def flush(self, transport):
        for message, recipient in sorted(self.pending):
            self.pending.remove((message, recipient))
            transport(message, recipient, self.messages[message]["body"])

    def acknowledge(self, message, recipient):
        if recipient not in self.messages[message]["recipients"]:
            raise ValueError("not a recipient")
        self.acks.add(message)

    def acknowledged(self, message, recipient):
        return recipient in self.messages[message]["recipients"] and message in self.acks
'''
reference = proposed.replace("dedup = (sender, key)", "dedup = (group, sender, key)").replace(
    '            self.pending.remove((message, recipient))\n            transport(message, recipient, self.messages[message]["body"])',
    '            transport(message, recipient, self.messages[message]["body"])\n            self.pending.remove((message, recipient))'
).replace("self.acks.add(message)", "self.acks.add((message, recipient))").replace(
    'return recipient in self.messages[message]["recipients"] and message in self.acks',
    'return (message, recipient) in self.acks'
)
write("packet/original.py", original)
write("packet/outbox.py", proposed)
write("reference/outbox.py", reference)
write("packet/proposed.patch", "".join(difflib.unified_diff(original.splitlines(True), proposed.splitlines(True), fromfile="original.py", tofile="outbox.py")))
write("packet/README.md", '''
# Review the group-aware outbox patch

Review `proposed.patch` and the complete proposed implementation `outbox.py`.
`original.py` is the previous single-group implementation. Work normally with
your tools, inspect context, and run tests or write scratch reproductions as
useful. Submit `FINDINGS.md` with each correctness finding's location, concrete
trigger, consequence, suggested repair and severity (high, medium or low).
High means lost or misrouted accepted work, medium means incorrect per-recipient
status without loss of the stored work, and low means a smaller correctness
defect. Do not modify the proposed source.
Unsupported concerns should not be reported as established defects.

The new API adds explicit group identity and deterministic flush order. The
service is an in-memory synchronous component, not a transport authentication
boundary or durable database. Calls do not overlap or re-enter. Inputs are
well-formed strings, recipient sets are nonempty, and recipients are unique
after normalization. Access to internal dictionaries is for implementation
only; callers use the public methods. Changes to malformed-input handling,
threading or disk persistence are outside this patch's contract.

Requirements:

- An identical send retry with the same group, sender and client key returns the
  original ID without creating another delivery. The same sender/key in a
  different group is independent. Reusing a key with a changed semantic payload
  within one group is forbidden by the caller contract and is not evaluated.
- Sending snapshots the recipient set. `message(id)` returns a defensive copy,
  including its recipient set, so changing the result does not mutate the outbox.
- `flush(transport)` visits pending `(message, recipient)` pairs in ascending
  tuple order. The callable either returns normally (known accepted) or throws
  before accepting (known not delivered). A failed pair remains pending for a
  later flush. The exception may propagate and stop that flush. Completed pairs
  need not be repeated. There is no ambiguous-after-submission outcome in this
  synthetic transport contract.
- An acknowledgement affects only that message's named eligible recipient.
  Another recipient's status stays unchanged. A non-recipient is rejected.

Run the visible checks with `python -B -m unittest -v`.
''')
write("packet/test_visible.py", '''
import unittest
from outbox import Outbox


class Visible(unittest.TestCase):
    def test_send_flush_and_ack(self):
        outbox = Outbox()
        recipients = ["bob"]
        message = outbox.send("blue", "alice", "k", recipients, "hello")
        recipients.append("carol")
        self.assertEqual(outbox.send("blue", "alice", "k", ["bob"], "hello"), message)
        record = outbox.message(message)
        record["recipients"].clear()
        self.assertEqual(outbox.message(message)["recipients"], {"bob"})
        sent = []
        outbox.flush(lambda *args: sent.append(args))
        outbox.flush(lambda *args: sent.append(args))
        self.assertEqual(sent, [(message, "bob", "hello")])
        outbox.acknowledge(message, "bob")
        self.assertTrue(outbox.acknowledged(message, "bob"))
        with self.assertRaises(ValueError):
            outbox.acknowledge(message, "carol")
''')
write("grading/witnesses.py", '''
import importlib.util
from pathlib import Path
import sys
import unittest

spec = importlib.util.spec_from_file_location("candidate", Path(sys.argv.pop(1)) / "outbox.py")
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class Witnesses(unittest.TestCase):
    def test_independent_group_key(self):
        o = candidate.Outbox()
        one = o.send("blue", "alice", "k", ["bob"], "first")
        two = o.send("green", "alice", "k", ["carol"], "second")
        self.assertNotEqual(one, two)
        self.assertEqual(o.message(two)["group"], "green")
        self.assertEqual(o.message(two)["body"], "second")

    def test_transport_failure_retains_pending(self):
        o = candidate.Outbox()
        message = o.send("blue", "alice", "k", ["bob"], "hello")
        def failing(*args):
            raise OSError("rejected before acceptance")
        with self.assertRaises(OSError):
            o.flush(failing)
        sent = []
        o.flush(lambda *args: sent.append(args))
        self.assertEqual(sent, [(message, "bob", "hello")])

    def test_recipient_ack_is_independent(self):
        o = candidate.Outbox()
        message = o.send("blue", "alice", "k", ["bob", "carol"], "hello")
        o.acknowledge(message, "bob")
        self.assertTrue(o.acknowledged(message, "bob"))
        self.assertFalse(o.acknowledged(message, "carol"))


unittest.main()
''')
write("grading/SCORING.md", '''
Use the frozen gold-catalog.json and its executable witnesses after FINDINGS.md
is frozen. Hide arm identity, model names, latency and usage from the scorer.
The scorer reports its mechanism matches with cited finding text and a reason;
an automated scorer is labeled automated, not blinded human judgment.

A correct finding identifies the mechanism and a valid trigger/consequence under
the disclosed contract. Accept equivalent wording and nearby locations in the
same responsible function. A wrong suggested repair or omitted location does not
erase a demonstrated correct defect; report those field-quality failures
separately. Do not give correctness credit to a vague concern without a concrete
valid mechanism. Multiple descriptions of one mechanism count once. Compound
findings describing different mechanisms are assessed separately.

Report TP, FP, missed defect IDs, precision TP/(TP+FP) (null when no findings),
and recall TP/3. Report severity agreement separately for matched defects: a
missing severity is missing, not silently correct. Report presence/correctness of
requested location, trigger, consequence and repair as separate fields. Do not
invent a combined weighted score or tune penalties after seeing an arm.

An unsupported distinct defect assertion is one FP. Repeating the same assertion
does not multiply the penalty. Suggestions clearly labeled optional and outside
the contract are neither correctness credit nor FP. A claim labeled a real
contract violation but relying on excluded concurrency, malformed inputs, disk
durability, authentication or ambiguous transport outcomes is unsupported.

If an additional valid defect is discovered, verify it with a deterministic
witness, preserve the original catalog, append an adjudication record, and
rescore all arms consistently with the same revised denominator. Never dismiss a
real defect because it was not seeded. No comparative model runs yet.
''')
write("grading/gold-catalog.json", json.dumps([
    {"id": "group_retry_namespace", "location": "outbox.py: Outbox.send, dedup construction and keys lookup",
     "trigger": "same sender and client key in two different groups",
     "consequence": "second group returns the first group's message ID and creates no independent delivery",
     "repair": "include group identity in the dedup key for lookup and storage", "severity": "high",
     "witness": "Witnesses.test_independent_group_key"},
    {"id": "pre_acceptance_failure_loses_pending", "location": "outbox.py: Outbox.flush, removal before transport call",
     "trigger": "transport throws before accepting a pending pair, then caller retries flush",
     "consequence": "failed pair is no longer pending and the accepted work is lost from retry routing",
     "repair": "remove the pair only after transport returns normally, preserving it on exception", "severity": "high",
     "witness": "Witnesses.test_transport_failure_retains_pending"},
    {"id": "recipient_ack_contamination", "location": "outbox.py: Outbox.acknowledge and Outbox.acknowledged",
     "trigger": "one of multiple eligible recipients acknowledges a message",
     "consequence": "another recipient is incorrectly reported acknowledged",
     "repair": "store and query acknowledgements by both message and recipient", "severity": "medium",
     "witness": "Witnesses.test_recipient_ack_is_independent"}
], indent=2) + "\n")
packet = DEST / "packet"
subprocess.run(["git", "init", "-q", str(packet)], check=True)
subprocess.run(["git", "-C", str(packet), "add", "."], check=True)
subprocess.run(["git", "-C", str(packet), "commit", "-q", "-m", "Freeze synthetic review input"], check=True)
results = []
for label, command, cwd, expected in [
    ("visible_seed", [sys.executable, "-B", "-m", "unittest", "-v"], packet, 0),
    ("witness_seed", [sys.executable, "-B", str(DEST / "grading/witnesses.py"), str(packet), "-v"], DEST, 1),
    ("witness_reference", [sys.executable, "-B", str(DEST / "grading/witnesses.py"), str(DEST / "reference"), "-v"], DEST, 0),
]:
    run = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=20)
    write(f"evidence/{label}.txt", run.stdout + run.stderr)
    scored = None
    if label.startswith("witness"):
        scored = unittest_results(run.stdout)
        names = ["test_independent_group_key", "test_transport_failure_retains_pending", "test_recipient_ack_is_independent"]
        require_exact_results(scored, {name: "failed" if label == "witness_seed" else "passed" for name in names})
    results.append({"check": label, "command": command, "exit_code": run.returncode,
                    "expected_exit": expected, "matches": run.returncode == expected, "test_results": scored})
write("manifest.json", json.dumps({"python": sys.version,
      **provenance(ROOT, DEST, __file__, {"review": packet}), "results": results,
      "status": "prepared; no model runs; review required"}, indent=2) + "\n")
print(json.dumps({"directory": str(DEST), "results": results}, indent=2))
if not all(row["matches"] for row in results):
    raise SystemExit(1)
