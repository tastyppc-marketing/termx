"""Create retained synthetic packets; never overwrite a frozen corpus or run a model."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import textwrap
import time
from corpus_support import provenance, require_exact_results

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / "retired/test-artifacts/swarm-core" / f"pilot-python-{time.time_ns()}"


def write(relative, value):
    path = DEST / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    value = textwrap.dedent(value).lstrip("\n")
    if relative.endswith("grading/check.py"):
        value = value.replace("unittest.main()", '''
import json

class RecordedResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.outcomes = []
    def addSuccess(self, test):
        super().addSuccess(test)
        self.outcomes.append({"test": test.id(), "status": "passed"})
    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.outcomes.append({"test": test.id(), "status": "failed"})
    def addError(self, test, err):
        super().addError(test, err)
        self.outcomes.append({"test": test.id(), "status": "error"})

program = unittest.main(exit=False, testRunner=unittest.TextTestRunner(verbosity=2, resultclass=RecordedResult))
print("EVAL_RESULTS=" + json.dumps(program.result.outcomes))
raise SystemExit(0 if program.result.wasSuccessful() else 1)
''')
    path.write_text(value, encoding="utf-8")


write("control/packet/README.md", '''
# Stable display order

Implement `order_records(records)` in `display.py`. Work normally with your tools,
verify your changes, and leave a completed implementation in this repository.

Input is a list of dictionaries with an optional `name` value. A name is either a
string or None. Sort named records using `name.strip().casefold()` ascending;
place missing, None, empty and whitespace-only names last. Preserve input order
among equal comparison keys and among unnamed records. Return a new list without
changing the input list or any record; preserve the original record objects and
their original labels. An empty input returns an empty new list.

Run the visible checks with `python -B -m unittest -v`.
''')
write("control/packet/display.py", '''
def order_records(records):
    return sorted(records, key=lambda record: (record.get("name") or "").lower())
''')
write("control/packet/test_visible.py", '''
import unittest
from display import order_records


class Visible(unittest.TestCase):
    def test_names(self):
        source = [{"name": "beta"}, {"name": "Alpha"}]
        result = order_records(source)
        self.assertEqual([row["name"] for row in result], ["Alpha", "beta"])
        self.assertEqual([row["name"] for row in source], ["beta", "Alpha"])
''')
write("control/grading/check.py", '''
import copy
import importlib.util
from pathlib import Path
import sys
import unittest

spec = importlib.util.spec_from_file_location("candidate", Path(sys.argv.pop(1)) / "display.py")
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class Contract(unittest.TestCase):
    def test_trim_and_casefold(self):
        rows = [{"name": " z "}, {"name": "Straße"}, {"name": "STRASSE"}, {"name": " apple "}]
        self.assertEqual(candidate.order_records(rows), [rows[3], rows[1], rows[2], rows[0]])

    def test_blank_and_missing_last_stably(self):
        rows = [{}, {"name": "a"}, {"name": None}, {"name": " "}, {"name": ""}]
        self.assertEqual([id(row) for row in candidate.order_records(rows)],
                         [id(rows[i]) for i in [1, 0, 2, 3, 4]])

    def test_identity_labels_and_input_preserved(self):
        rows = [{"name": " beta "}, {"name": "alpha"}]
        original = copy.deepcopy(rows)
        ids = list(map(id, rows))
        result = candidate.order_records(rows)
        self.assertIsNot(result, rows)
        self.assertEqual(sorted(map(id, result)), sorted(ids))
        self.assertEqual(rows, original)
        self.assertEqual(list(map(id, rows)), ids)

    def test_keys_identity_and_missing(self):
        rows = [{"name": None}, {"name": " z "}, {"name": "Straße"},
                {"name": "STRASSE"}, {}, {"name": "\t "}, {"name": " apple "},
                {"name": "APPLE"}, {"name": ""}]
        before = copy.deepcopy(rows)
        original_ids = [id(row) for row in rows]
        result = candidate.order_records(rows)
        self.assertEqual([id(row) for row in result],
                         [original_ids[i] for i in [6, 7, 2, 3, 1, 0, 4, 5, 8]])
        self.assertIsNot(result, rows)
        self.assertEqual(rows, before)
        self.assertEqual([id(row) for row in rows], original_ids)

    def test_empty(self):
        rows = []
        result = candidate.order_records(rows)
        self.assertEqual(result, [])
        self.assertIsNot(result, rows)


unittest.main()
''')
write("control/reference/display.py", '''
def order_records(records):
    def key(record):
        name = record.get("name")
        normalized = "" if name is None else name.strip().casefold()
        return (not bool(normalized), normalized)
    return sorted(records, key=key)
''')

write("coalescer/packet/README.md", '''
# Repair the asynchronous coalescer

Repair `Coalescer` in `coalescer.py`. Work normally with your tools, verify the
behavior, and leave a completed implementation in this repository.

`await run(key, factory)` shares one in-flight asynchronous operation among
callers with the same key. `factory` is a callable returning an awaitable and
must be invoked once per in-flight key. Callers with different keys can progress
independently. Concurrent waiters receive the shared operation's result or
exception. Once that operation is finished (success or failure), a later call
starts a new operation; this is not a result cache.

Cancelling one caller's wait must not cancel the accepted operation or another
caller's wait. If every waiter abandons the wait, the accepted operation still
finishes, and its eventual exception must be retrieved to avoid unhandled-task
warnings. `await aclose()` refuses new calls and drains every operation already
accepted. Operation exceptions do not abort the drain. Calling `aclose` again is
safe. Any run after closing begins raises RuntimeError without calling factory.
The class is used on one asyncio event loop; no cross-thread API is required.

Use deterministic events/barriers for race checks. Run the visible checks with
`python -B -m unittest -v`.
''')
write("coalescer/packet/coalescer.py", '''
import asyncio


class Coalescer:
    def __init__(self):
        self._tasks = {}
        self._closed = False

    async def run(self, key, factory):
        if self._closed:
            raise RuntimeError("closed")
        if key not in self._tasks:
            self._tasks[key] = asyncio.create_task(factory())
        return await self._tasks[key]

    async def aclose(self):
        self._closed = True
        await asyncio.gather(*self._tasks.values(), return_exceptions=True)
''')
write("coalescer/packet/test_visible.py", '''
import asyncio
import unittest
from coalescer import Coalescer


class Visible(unittest.IsolatedAsyncioTestCase):
    async def test_shared_result(self):
        c = Coalescer()
        started, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def operation():
            calls.append(1)
            started.set()
            await release.wait()
            return 17

        first = asyncio.create_task(c.run("a", operation))
        await started.wait()
        second = asyncio.create_task(c.run("a", operation))
        await asyncio.sleep(0)
        release.set()
        self.assertEqual(await asyncio.gather(first, second), [17, 17])
        self.assertEqual(calls, [1])
        await c.aclose()
''')
write("coalescer/grading/check.py", '''
import asyncio
import gc
import importlib.util
from pathlib import Path
import sys
import unittest

spec = importlib.util.spec_from_file_location("candidate", Path(sys.argv.pop(1)) / "coalescer.py")
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class Contract(unittest.IsolatedAsyncioTestCase):
    async def test_failure_and_success_are_not_cached(self):
        c = candidate.Coalescer()
        calls = []
        async def operation():
            calls.append(1)
            if len(calls) == 1:
                raise ValueError("synthetic failure")
            return len(calls)
        with self.assertRaises(ValueError):
            await c.run("a", operation)
        try:
            retried = await c.run("a", operation)
        except ValueError:
            self.fail("completed failure remained cached and prevented retry")
        self.assertEqual(retried, 2)
        self.assertEqual(await c.run("a", operation), 3)
        await c.aclose()

    async def test_success_is_not_cached(self):
        c = candidate.Coalescer()
        calls = []
        async def operation():
            calls.append(1)
            return len(calls)
        self.assertEqual(await c.run("a", operation), 1)
        self.assertEqual(await c.run("a", operation), 2)
        await c.aclose()

    async def test_shared_failure_comes_from_one_invocation(self):
        c = candidate.Coalescer()
        started, release, joined = asyncio.Event(), asyncio.Event(), asyncio.Event()
        calls = []
        async def operation():
            calls.append(1)
            started.set()
            await release.wait()
            raise ValueError("shared failure")
        first = asyncio.create_task(c.run("a", operation))
        await started.wait()
        async def join():
            joined.set()
            return await c.run("a", operation)
        second = asyncio.create_task(join())
        await joined.wait()
        release.set()
        results = await asyncio.gather(first, second, return_exceptions=True)
        self.assertEqual(calls, [1])
        self.assertTrue(all(isinstance(result, ValueError) and result.args == ("shared failure",) for result in results))
        await c.aclose()

    async def _all_waiters_abandon(self, fail):
        loop = asyncio.get_running_loop()
        previous_handler = loop.get_exception_handler()
        unhandled = []
        loop.set_exception_handler(lambda _, context: unhandled.append(context.get("message", "")))
        try:
            c = candidate.Coalescer()
            started, joined, release, finished = (asyncio.Event() for _ in range(4))
            async def operation():
                started.set()
                try:
                    await release.wait()
                    if fail:
                        raise ValueError("abandoned failure")
                    return 9
                finally:
                    finished.set()
            first = asyncio.create_task(c.run("a", operation))
            await started.wait()
            async def join():
                joined.set()
                return await c.run("a", operation)
            second = asyncio.create_task(join())
            await joined.wait()
            first.cancel()
            second.cancel()
            await asyncio.gather(first, second, return_exceptions=True)
            survived = not finished.is_set()
            release.set()
            await asyncio.wait_for(finished.wait(), 2)
            self.assertTrue(survived, "accepted operation was cancelled with its waiters")
            # Drain scheduled completion callbacks, then release references and force
            # collection while the exception handler can observe unretrieved errors.
            for _ in range(2):
                barrier = loop.create_future()
                loop.call_soon(barrier.set_result, None)
                await barrier
            del first, second, c
            gc.collect()
            barrier = loop.create_future()
            loop.call_soon(barrier.set_result, None)
            await barrier
            gc.collect()
            self.assertEqual(unhandled, [])
        finally:
            loop.set_exception_handler(previous_handler)

    async def test_abandoned_success_finishes(self):
        await self._all_waiters_abandon(False)

    async def test_abandoned_failure_is_retrieved(self):
        await self._all_waiters_abandon(True)

    async def test_shutdown_never_invokes_late_factory(self):
        c = candidate.Coalescer()
        started, release = asyncio.Event(), asyncio.Event()
        async def operation():
            started.set()
            await release.wait()
        caller = asyncio.create_task(c.run("a", operation))
        await started.wait()
        closing = asyncio.create_task(c.aclose())
        loop = asyncio.get_running_loop()
        barrier = loop.create_future()
        loop.call_soon(barrier.set_result, None)
        await barrier
        calls = []
        def late():
            calls.append(1)
            raise AssertionError("closed coalescer invoked factory")
        with self.assertRaises(RuntimeError):
            await c.run("during", late)
        release.set()
        await asyncio.gather(caller, closing)
        with self.assertRaises(RuntimeError):
            await c.run("after", late)
        self.assertEqual(calls, [])

    async def test_one_cancelled_waiter_does_not_cancel_another(self):
        c = candidate.Coalescer()
        started, release, joined = asyncio.Event(), asyncio.Event(), asyncio.Event()
        calls = []
        async def operation():
            calls.append(1)
            started.set()
            await release.wait()
            return 42
        first = asyncio.create_task(c.run("a", operation))
        await started.wait()
        async def join():
            joined.set()
            return await c.run("a", operation)
        second = asyncio.create_task(join())
        await joined.wait()
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        release.set()
        try:
            second_result = await second
        except asyncio.CancelledError:
            self.fail("one caller cancelled another caller's accepted operation")
        self.assertEqual(second_result, 42)
        self.assertEqual(calls, [1])
        await c.aclose()

    async def test_independent_keys_and_shutdown(self):
        c = candidate.Coalescer()
        release = asyncio.Event()
        started = [asyncio.Event(), asyncio.Event()]
        completed = []
        async def operation(i):
            started[i].set()
            await release.wait()
            completed.append(i)
            if i == 0:
                raise ValueError("owned failure")
            return i
        callers = [asyncio.create_task(c.run(i, lambda i=i: operation(i))) for i in range(2)]
        await asyncio.wait_for(asyncio.gather(*(event.wait() for event in started)), 2)
        closing = asyncio.create_task(c.aclose())
        # FIFO call_soon barrier gives aclose a turn to establish its closed state.
        barrier = asyncio.get_running_loop().create_future()
        asyncio.get_running_loop().call_soon(barrier.set_result, None)
        await barrier
        self.assertFalse(closing.done())
        with self.assertRaises(RuntimeError):
            await c.run("late", lambda: operation(0))
        release.set()
        await closing
        results = await asyncio.gather(*callers, return_exceptions=True)
        self.assertIsInstance(results[0], ValueError)
        self.assertEqual(results[1], 1)
        self.assertEqual(sorted(completed), [0, 1])
        await c.aclose()


unittest.main()
''')
write("coalescer/reference/coalescer.py", '''
import asyncio


class Coalescer:
    def __init__(self):
        self._tasks = {}
        self._closed = False

    async def run(self, key, factory):
        if self._closed:
            raise RuntimeError("closed")
        task = self._tasks.get(key)
        if task is None:
            async def execute():
                try:
                    return await factory()
                finally:
                    self._tasks.pop(key, None)
            task = asyncio.create_task(execute())
            self._tasks[key] = task
            task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        return await asyncio.shield(task)

    async def aclose(self):
        self._closed = True
        await asyncio.gather(*tuple(self._tasks.values()), return_exceptions=True)
''')

expected_seed = {
    "control": {
        "test_blank_and_missing_last_stably": "failed",
        "test_empty": "passed",
        "test_identity_labels_and_input_preserved": "passed",
        "test_keys_identity_and_missing": "failed",
        "test_trim_and_casefold": "failed",
    },
    "coalescer": {
        "test_abandoned_failure_is_retrieved": "failed",
        "test_abandoned_success_finishes": "failed",
        "test_failure_and_success_are_not_cached": "failed",
        "test_independent_keys_and_shutdown": "passed",
        "test_one_cancelled_waiter_does_not_cancel_another": "failed",
        "test_shared_failure_comes_from_one_invocation": "passed",
        "test_shutdown_never_invokes_late_factory": "passed",
        "test_success_is_not_cached": "failed",
    },
}
results = []
for name in ["control", "coalescer"]:
    packet = DEST / name / "packet"
    subprocess.run(["git", "init", "-q", str(packet)], check=True)
    subprocess.run(["git", "-C", str(packet), "add", "."], check=True)
    subprocess.run(["git", "-C", str(packet), "commit", "-q", "-m", "Freeze synthetic pilot input"], check=True)
    commands = [
        ("visible_seed", [sys.executable, "-B", "-m", "unittest", "-v"], packet, 0),
        ("grading_seed", [sys.executable, "-B", str(DEST / name / "grading/check.py"), str(packet), "-v"], DEST, 1),
        ("grading_reference", [sys.executable, "-B", str(DEST / name / "grading/check.py"), str(DEST / name / "reference"), "-v"], DEST, 0),
    ]
    for label, command, cwd, expected in commands:
        run = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=20)
        write(f"{name}/evidence/{label}.txt", run.stdout + run.stderr)
        scored = [json.loads(line.removeprefix("EVAL_RESULTS=")) for line in run.stdout.splitlines() if line.startswith("EVAL_RESULTS=")]
        if label.startswith("grading"):
            if len(scored) != 1:
                raise ValueError("missing or duplicate structured result")
            expected_map = expected_seed[name] if label == "grading_seed" else {test: "passed" for test in expected_seed[name]}
            require_exact_results(scored[0], expected_map)
        results.append({"case": name, "check": label, "command": command, "exit_code": run.returncode,
                        "expected_exit": expected, "matches": run.returncode == expected,
                        "test_results": scored[0] if scored else None})

hashes = {}
for path in sorted(DEST.rglob("*")):
    if path.is_file() and ".git" not in path.parts:
        hashes[str(path.relative_to(DEST)).replace("\\", "/")] = hashlib.sha256(path.read_bytes()).hexdigest()
write("manifest.json", json.dumps({"python": sys.version, "results": results, "expected_seed": expected_seed,
      **provenance(ROOT, DEST, __file__, {name: DEST / name / "packet" for name in ["control", "coalescer"]}),
      "status": "two prepared cases; no model runs; review required before pilot"}, indent=2) + "\n")
print(json.dumps({"directory": str(DEST), "results": results}, indent=2))
if not all(result["matches"] for result in results):
    raise SystemExit(1)
