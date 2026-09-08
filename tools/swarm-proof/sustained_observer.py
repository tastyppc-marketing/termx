"""Opt-in owned-child core observer; all outputs and databases are retained.

Requires psutil. Example: python tools/swarm-proof/sustained_observer.py LABEL
  --preload 25000 --seconds 600
The child directory must not exist. SQLite reads are diagnostics, never peer APIs.
"""
import argparse
import ctypes
from ctypes import wintypes
import datetime
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time
import sys
import psutil

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sources():
    paths = list((ROOT / "swarm-core").rglob("*.rs"))
    paths += [ROOT / "swarm-core/Cargo.toml", ROOT / "Cargo.toml", ROOT / "Cargo.lock", Path(__file__)]
    return {str(p.relative_to(ROOT)): digest(p) for p in sorted(paths)}


def diagnostic(path):
    if not path.exists():
        return None
    try:
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.2) as db:
            db.execute("BEGIN")
            return {table: db.execute("SELECT count(*) FROM " + table).fetchone()[0]
                    for table in ["messages", "current_deliveries", "mailbox_cursors", "acknowledgements", "delivery_attempts"]}
    except sqlite3.Error as error:
        return {"diagnostic_error": str(error)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("label")
    parser.add_argument("--preload", type=int, default=25000)
    parser.add_argument("--seconds", type=int, default=600)
    parser.add_argument("--command", nargs=argparse.REMAINDER)
    # Keep native argv's own `--` intact.
    raw = sys.argv[1:]
    native = raw.index("--command") if "--command" in raw else len(raw)
    args = parser.parse_args(raw[:native])
    args.command = raw[native + 1:] if native < len(raw) else None
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    directory = ROOT / "retired/test-artifacts/swarm-core" / (args.label + "-" + stamp)
    directory.mkdir(parents=True)
    env = os.environ.copy()
    env["CARGO_TARGET_DIR"] = str(ROOT / "target-swarm-validation")
    argv = args.command or [str(ROOT / "target-swarm-validation/release/examples/sustained.exe"),
                            str(directory / "fixture"), str(args.preload), str(args.seconds)]
    manifest = {"argv": argv, "cwd": str(ROOT), "source_sha256": sources(),
                "target": env["CARGO_TARGET_DIR"], "observer_psutil": psutil.__version__,
                "started_utc": stamp, "sample_seconds": 5}
    manifest["git_revision"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    manifest["rustc"] = subprocess.check_output(["rustc", "--version"], cwd=ROOT, text=True).strip()
    if Path(argv[0]).is_file():
        manifest["executable_sha256"] = digest(Path(argv[0]))
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2))
    for relative in manifest["source_sha256"]:
        destination = directory / "source" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((ROOT / relative).read_bytes())
    if Path(argv[0]).is_file():
        frozen_executable = directory / Path(argv[0]).name
        frozen_executable.write_bytes(Path(argv[0]).read_bytes())
        argv[0] = str(frozen_executable)
        manifest["argv"] = argv
        (directory / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(directory, flush=True)
    with (directory / "stdout.jsonl").open("w", encoding="utf-8") as out, (directory / "stderr.txt").open("w", encoding="utf-8") as err, (directory / "process.jsonl").open("w", encoding="utf-8") as samples:
        child = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=out, stderr=err)
        process = psutil.Process(child.pid)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        def creation_filetime():
            values = [wintypes.FILETIME() for _ in range(4)]
            if not kernel.GetProcessTimes(int(child._handle), *[ctypes.byref(value) for value in values]):
                raise ctypes.WinError(ctypes.get_last_error())
            return str((values[0].dwHighDateTime << 32) | values[0].dwLowDateTime)
        identity = {"pid": child.pid, "creation_time": process.create_time(), "creation_filetime": creation_filetime(), "executable": process.exe()}
        (directory / "identity.json").write_text(json.dumps(identity, indent=2))
        print(json.dumps(identity), flush=True)
        while child.poll() is None:
            try:
                assert psutil.Process(child.pid).create_time() == identity["creation_time"]
                assert creation_filetime() == identity["creation_filetime"]
                with process.oneshot():
                    memory = process.memory_info()._asdict()
                    sample = {"utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                              "identity": identity, "memory": memory, "cpu": process.cpu_times()._asdict(),
                              "handles": process.num_handles(), "threads": process.num_threads()}
                db = directory / "fixture/swarm.sqlite"
                sample["files"] = {suffix: Path(str(db)+suffix).stat().st_size if Path(str(db)+suffix).exists() else 0
                                   for suffix in ["", "-wal", "-shm"]}
                sample["diagnostic_sql_counts"] = diagnostic(db)
                samples.write(json.dumps(sample) + "\n")
                samples.flush()
            except psutil.NoSuchProcess:
                break
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        code = child.wait()
    result = {"native_exit": code, "identity": identity, "ended_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "sources_unchanged": sources() == manifest["source_sha256"],
              "final_diagnostic_sql_counts": diagnostic(directory / "fixture/swarm.sqlite")}
    if not args.command and code == 0:
        with (directory / "stdout.jsonl").open(encoding="utf-8") as rows:
            integrity = next(json.loads(row) for row in rows if '"event":"integrity"' in row)
        expected = integrity["retained_workload_expected"] + integrity["retained_boundary_expected"]
        result["retained_message_count_matches_model"] = result["final_diagnostic_sql_counts"]["messages"] == expected
        assert result["retained_message_count_matches_model"], "diagnostic retained-message count differs from independent workload accounting"
    (directory / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
    raise SystemExit(code)


if __name__ == "__main__":
    main()
