"""Retain one immutable verification run for the offline observer prototype."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
from typing import Any


SOURCE_NAMES = (
    "completion_observer.py",
    "test_completion_observer.py",
    "evidence_runner.py",
    "README.md",
)


def _utc() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def _write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _source_inventory(source_root: Path) -> list[dict[str, Any]]:
    return [
        {
            "path": name,
            "bytes": (source_root / name).stat().st_size,
            "sha256": _sha256(source_root / name),
        }
        for name in SOURCE_NAMES
    ]


def _run(
    *,
    name: str,
    argv: list[str],
    cwd: Path,
    run_dir: Path,
    environment: dict[str, str],
) -> dict[str, Any]:
    stdout = run_dir / f"{name}.stdout.log"
    stderr = run_dir / f"{name}.stderr.log"
    started = _utc()
    with stdout.open("xb") as stdout_stream, stderr.open("xb") as stderr_stream:
        completed = subprocess.run(
            argv,
            cwd=cwd,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=stdout_stream,
            stderr=stderr_stream,
            check=False,
        )
    ended = _utc()
    return {
        "name": name,
        "argv": argv,
        "cwd": str(cwd),
        "started_utc": started,
        "ended_utc": ended,
        "native_exit": completed.returncode,
        "stdout": stdout.name,
        "stdout_sha256": _sha256(stdout),
        "stderr": stderr.name,
        "stderr_sha256": _sha256(stderr),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True)
    arguments = parser.parse_args(argv)

    source_root = Path(__file__).resolve().parent
    repository = source_root.parents[2]
    evidence_parent = (repository / "retired/test-artifacts/swarm-core").resolve(strict=True)
    run_dir = Path(arguments.run_dir).resolve(strict=False)
    if run_dir.parent != evidence_parent or not run_dir.name.startswith("evaluation-observer-"):
        parser.error("run directory must be a new evaluation-observer-* child of the retained root")
    run_dir.mkdir()

    source_before = _source_inventory(source_root)
    environment = os.environ.copy()
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    environment["EVALUATION_OBSERVER_FIXTURE_ROOT"] = str(run_dir / "owned-fixtures")
    relative_source = source_root.relative_to(repository)
    test_command = [
        sys.executable,
        "-B",
        "-m",
        "unittest",
        "discover",
        "-s",
        str(relative_source),
        "-p",
        "test_completion_observer.py",
    ]
    ruff_command = [
        sys.executable,
        "-m",
        "ruff",
        "check",
        *(str(relative_source / name) for name in SOURCE_NAMES if name.endswith(".py")),
    ]
    commands = [
        _run(
            name="01-unittest",
            argv=test_command,
            cwd=repository,
            run_dir=run_dir,
            environment=environment,
        ),
        _run(
            name="02-ruff",
            argv=ruff_command,
            cwd=repository,
            run_dir=run_dir,
            environment=environment,
        ),
    ]
    source_after = _source_inventory(source_root)
    source_stable = source_before == source_after
    _write_json(run_dir / "commands.json", commands)
    _write_json(
        run_dir / "source-hashes.json",
        {"before": source_before, "after": source_after, "stable": source_stable},
    )
    manifest = {
        "schema_version": 1,
        "purpose": "offline completion observer prototype verification",
        "created_utc": _utc(),
        "repository": str(repository),
        "source_root": str(source_root),
        "python": sys.version,
        "platform": platform.platform(),
        "commands": commands,
        "source_stable_during_commands": source_stable,
        "result": "pass"
        if source_stable and all(command["native_exit"] == 0 for command in commands)
        else "fail",
        "limits": {
            "native_adapter": "not exercised",
            "model_calls": 0,
            "network_access": "not used by prototype or tests",
        },
    }
    _write_json(run_dir / "run-manifest.json", manifest)
    evidence_files = sorted(
        path for path in run_dir.iterdir() if path.is_file() and path.name != "evidence-hashes.json"
    )
    _write_json(
        run_dir / "evidence-hashes.json",
        [
            {"path": path.name, "bytes": path.stat().st_size, "sha256": _sha256(path)}
            for path in evidence_files
        ],
    )
    print(json.dumps({"run_dir": str(run_dir), "result": manifest["result"]}, sort_keys=True))
    return 0 if manifest["result"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
