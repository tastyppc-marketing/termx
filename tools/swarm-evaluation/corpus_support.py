"""Preparation checks and provenance shared by the retained evaluation recipes."""
import hashlib
import json
from pathlib import Path
import subprocess


def unittest_runner():
    return '''
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
'''


def unittest_results(stdout):
    records = [json.loads(line.removeprefix("EVAL_RESULTS=")) for line in stdout.splitlines()
               if line.startswith("EVAL_RESULTS=")]
    if len(records) != 1:
        raise ValueError("missing or duplicate structured grader result")
    return records[0]


def require_exact_results(records, expected, javascript=False):
    observed = {}
    for record in records:
        name = record["name"] if javascript else record["test"].split(".")[-1]
        state = ("passed" if record["passed"] else "failed") if javascript else record["status"]
        if name in observed:
            raise ValueError(f"duplicate grader result: {name}")
        observed[name] = state
    if observed != expected:
        raise ValueError(f"unexpected preparation result set: expected={expected!r}, actual={observed!r}")


def provenance(root, dest, generator, packets):
    return {
        "generator_sha256": hashlib.sha256(Path(generator).read_bytes()).hexdigest(),
        "support_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "parent_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
        "packet_commits": {name: subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=path, text=True).strip()
                           for name, path in packets.items()},
        "sha256": {str(path.relative_to(dest)).replace("\\", "/"): hashlib.sha256(path.read_bytes()).hexdigest()
                   for path in sorted(dest.rglob("*")) if path.is_file() and ".git" not in path.parts}
    }
