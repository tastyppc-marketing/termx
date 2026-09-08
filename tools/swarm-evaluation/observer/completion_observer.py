"""Fail-closed offline completion observer for owned synthetic evaluation arms.

The module consumes caller-supplied evidence.  It does not discover sessions,
send messages, access graders, use the network, or claim that its input is native.
An integration adapter must establish those properties before a pilot may use it.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import Enum
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from typing import Any


CONFIRMATION_NS = 1_000_000_000
ARM_DEADLINE_NS = 60 * 60 * 1_000_000_000
MAX_ACQUISITION_NS = 1_000_000_000
MAX_EVIDENCE_AGE_NS = 10_000_000_000
MAX_FILES = 20_000
MAX_DIRECTORIES = 10_000
MAX_TREE_ENTRIES = 30_000
MAX_PATH_BYTES = 4 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TREE_BYTES = 512 * 1024 * 1024
_RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_GIT_METADATA = ".git"


class EvidenceAvailability(str, Enum):
    AVAILABLE = "available"
    MISSING = "missing"
    UNAVAILABLE = "unavailable"
    UNCERTAIN = "uncertain"
    HELD = "held"
    REFUSED = "refused"


class ObserverState(str, Enum):
    WAITING = "waiting"
    CANDIDATE = "candidate"
    FROZEN = "frozen"
    CENSORED = "censored"


def _identifier(value: object) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= 256
        and not any(ord(character) < 32 for character in value)
    )


def _nonnegative_integer(value: object) -> bool:
    return type(value) is int and value >= 0


@dataclass(frozen=True, order=True)
class ParticipantIdentity:
    session_id: str
    boot_id: str
    binding_revision: int

    def __post_init__(self) -> None:
        if not _identifier(self.session_id) or not _identifier(self.boot_id):
            raise ValueError("invalid participant identity")
        if not _nonnegative_integer(self.binding_revision):
            raise ValueError("invalid participant binding revision")


@dataclass(frozen=True)
class StateRevisions:
    inventory_revision: int
    delivery_revision: int
    run_revision: int

    def __post_init__(self) -> None:
        if not all(
            _nonnegative_integer(value)
            for value in (self.inventory_revision, self.delivery_revision, self.run_revision)
        ):
            raise ValueError("state revisions must be nonnegative integers")


@dataclass(frozen=True)
class ParticipantEvidence:
    identity: ParticipantIdentity
    availability: EvidenceAvailability
    latest_task_input_revision: int
    latest_delivered_wake_revision: int
    final_after_task_revision: int
    final_after_wake_revision: int
    normal_final: bool
    normal_final_response_id: str | None
    active_model_work: int
    active_tool_work: int
    active_delegated_work: int

    def __post_init__(self) -> None:
        if not isinstance(self.identity, ParticipantIdentity):
            raise ValueError("invalid participant identity evidence")
        if not isinstance(self.availability, EvidenceAvailability):
            raise ValueError("invalid evidence availability")
        revisions = (
            self.latest_task_input_revision,
            self.latest_delivered_wake_revision,
            self.final_after_task_revision,
            self.final_after_wake_revision,
        )
        counts = (self.active_model_work, self.active_tool_work, self.active_delegated_work)
        if not all(_nonnegative_integer(value) for value in revisions + counts):
            raise ValueError("revisions and work counts must be nonnegative integers")
        if self.final_after_task_revision > self.latest_task_input_revision:
            raise ValueError("final task revision exceeds latest observed task input")
        if self.final_after_wake_revision > self.latest_delivered_wake_revision:
            raise ValueError("final wake revision exceeds latest observed delivered wake")
        if type(self.normal_final) is not bool:
            raise ValueError("normal_final must be a boolean")
        if self.normal_final and not _identifier(self.normal_final_response_id):
            raise ValueError("normal final evidence requires its exact response identity")


@dataclass(frozen=True)
class NativeObservation:
    acquisition_sequence: int
    acquired_started_ns: int
    acquired_completed_ns: int
    broker_availability: EvidenceAvailability
    queue_availability: EvidenceAvailability
    broker_boot_id: str | None
    state_revisions: StateRevisions | None
    participants: tuple[ParticipantEvidence, ...]
    queued_notices: int | None
    in_flight_notices: int | None

    def __post_init__(self) -> None:
        if not all(
            _nonnegative_integer(value)
            for value in (
                self.acquisition_sequence,
                self.acquired_started_ns,
                self.acquired_completed_ns,
            )
        ) or self.acquired_completed_ns < self.acquired_started_ns:
            raise ValueError("invalid evidence acquisition interval")
        if not isinstance(self.broker_availability, EvidenceAvailability):
            raise ValueError("invalid broker evidence availability")
        if not isinstance(self.queue_availability, EvidenceAvailability):
            raise ValueError("invalid queue evidence availability")
        if not isinstance(self.participants, tuple) or not all(
            isinstance(participant, ParticipantEvidence) for participant in self.participants
        ):
            raise ValueError("participants must be a tuple of ParticipantEvidence")
        if self.broker_availability is EvidenceAvailability.AVAILABLE:
            if not _identifier(self.broker_boot_id) or not isinstance(
                self.state_revisions, StateRevisions
            ):
                raise ValueError("available broker evidence requires exact boot and revisions")
        if self.queue_availability is EvidenceAvailability.AVAILABLE:
            if not _nonnegative_integer(self.queued_notices) or not _nonnegative_integer(
                self.in_flight_notices
            ):
                raise ValueError("available queue evidence requires exact nonnegative counts")


@dataclass(frozen=True)
class ObservationResult:
    state: ObserverState
    reason: str
    completion_credit: bool
    first_candidate_at_ns: int | None = None
    candidate_at_ns: int | None = None
    frozen_at_ns: int | None = None
    snapshot_sha256: str | None = None
    artifact_dir: str | None = None
    late_artifact_dir: str | None = None
    failed_artifact_dir: str | None = None


@dataclass(frozen=True)
class _Metadata:
    device: int
    inode: int
    mode: int
    size: int
    modified_ns: int


@dataclass(frozen=True)
class _SnapshotEntry:
    relative_path: str
    content: bytes
    sha256: str


@dataclass(frozen=True)
class _TreeSnapshot:
    entries: tuple[_SnapshotEntry, ...]
    sha256: str
    total_bytes: int


class TreeUnavailable(ValueError):
    """The selected task tree could not be captured safely and coherently."""


class ArtifactPublicationFailed(OSError):
    """No authoritative scored artifact was committed."""

    def __init__(
        self, failed_artifact_dir: Path | None, reason: str, *, publication_refused: bool = False
    ):
        self.failed_artifact_dir = failed_artifact_dir
        self.reason = reason
        self.publication_refused = publication_refused
        super().__init__(reason)


def _is_reparse_or_symlink(path: Path, info: os.stat_result | None = None) -> bool:
    if path.is_symlink():
        return True
    current = info if info is not None else path.lstat()
    attributes = getattr(current, "st_file_attributes", 0)
    return bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def _metadata(info: os.stat_result) -> _Metadata:
    return _Metadata(
        device=info.st_dev,
        inode=info.st_ino,
        mode=info.st_mode,
        size=info.st_size,
        modified_ns=info.st_mtime_ns,
    )


def _checked_existing_root(value: Path | str) -> Path:
    """Reject linked/reparse components before canonicalizing an owned root."""
    unresolved = Path(os.path.abspath(os.fspath(value)))
    current = Path(unresolved.anchor)
    try:
        for component in unresolved.parts[1:]:
            current /= component
            info = current.lstat()
            if _is_reparse_or_symlink(current, info):
                raise ValueError("root path contains a reparse or symlink component")
    except OSError as error:
        raise ValueError("root path must already exist") from error
    canonical = unresolved.resolve(strict=True)
    if not canonical.is_dir():
        raise ValueError("root path must be a directory")
    return canonical


def _collect_metadata(root: Path) -> dict[str, _Metadata]:
    try:
        root_info = root.lstat()
    except OSError as error:
        raise TreeUnavailable("incomplete_tree") from error
    if _is_reparse_or_symlink(root, root_info) or not stat.S_ISDIR(root_info.st_mode):
        raise TreeUnavailable("reparse_or_symlink")

    result: dict[str, _Metadata] = {}
    root_metadata = _metadata(root_info)
    pending = [(root, root_metadata)]
    directories = 1
    entries = 0
    total_bytes = 0
    total_path_bytes = 0
    try:
        while pending:
            directory, expected_directory = pending.pop()
            current_directory = directory.lstat()
            if (
                _is_reparse_or_symlink(directory, current_directory)
                or not stat.S_ISDIR(current_directory.st_mode)
                or _metadata(current_directory) != expected_directory
            ):
                raise TreeUnavailable("unstable_tree")
            with os.scandir(directory) as iterator:
                for child in iterator:
                    entries += 1
                    if entries > MAX_TREE_ENTRIES:
                        raise TreeUnavailable("too_many_entries")
                    path = Path(child.path)
                    relative = path.relative_to(root)
                    relative_path = relative.as_posix()
                    total_path_bytes += len(relative_path.encode("utf-8"))
                    if total_path_bytes > MAX_PATH_BYTES:
                        raise TreeUnavailable("path_inventory_too_large")
                    if len(relative.parts) == 1 and relative.name == _GIT_METADATA:
                        continue
                    # pathlib.lstat carries stable Windows file identity fields
                    # that DirEntry.stat may leave as zero on this interpreter.
                    info = path.lstat()
                    if child.is_symlink() or _is_reparse_or_symlink(path, info):
                        raise TreeUnavailable("reparse_or_symlink")
                    if stat.S_ISDIR(info.st_mode):
                        directories += 1
                        if directories > MAX_DIRECTORIES:
                            raise TreeUnavailable("too_many_directories")
                        pending.append((path, _metadata(info)))
                    elif stat.S_ISREG(info.st_mode):
                        if info.st_size > MAX_FILE_BYTES:
                            raise TreeUnavailable("file_too_large")
                        total_bytes += info.st_size
                        if total_bytes > MAX_TREE_BYTES:
                            raise TreeUnavailable("tree_too_large")
                        result[relative_path] = _metadata(info)
                        if len(result) > MAX_FILES:
                            raise TreeUnavailable("too_many_files")
                    else:
                        raise TreeUnavailable("unsupported_file_type")
    except TreeUnavailable:
        raise
    except (OSError, ValueError) as error:
        raise TreeUnavailable("incomplete_tree") from error
    return result


def _open_entry(path: Path):
    """Open barrier kept small so race regressions can swap only owned fixtures."""
    return path.open("rb")


def _opened_final_path(stream) -> Path:
    if os.name != "nt":
        try:
            return Path(os.readlink(f"/proc/self/fd/{stream.fileno()}")).resolve(strict=True)
        except OSError as error:
            raise TreeUnavailable("final_path_unavailable") from error

    import ctypes
    from ctypes import wintypes
    import msvcrt

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    get_final_path = kernel32.GetFinalPathNameByHandleW
    get_final_path.argtypes = (wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD)
    get_final_path.restype = wintypes.DWORD
    handle = msvcrt.get_osfhandle(stream.fileno())
    capacity = 32_768
    buffer = ctypes.create_unicode_buffer(capacity)
    length = get_final_path(handle, buffer, capacity, 0)
    if length == 0 or length >= capacity:
        raise TreeUnavailable("final_path_unavailable")
    value = buffer.value
    if value.startswith("\\\\?\\UNC\\"):
        value = "\\\\" + value[8:]
    elif value.startswith("\\\\?\\"):
        value = value[4:]
    try:
        return Path(value).resolve(strict=True)
    except OSError as error:
        raise TreeUnavailable("final_path_unavailable") from error


def _path_is_within(path: Path, root: Path) -> bool:
    normalized_path = os.path.normcase(str(path))
    normalized_root = os.path.normcase(str(root))
    try:
        return os.path.commonpath((normalized_path, normalized_root)) == normalized_root
    except ValueError:
        return False


def _read_entry(path: Path, expected: _Metadata, root: Path) -> bytes:
    """Read one regular file while binding the path and opened object metadata."""
    try:
        before = path.lstat()
        if _is_reparse_or_symlink(path, before) or _metadata(before) != expected:
            raise TreeUnavailable("unstable_tree")
        with _open_entry(path) as stream:
            opened = os.fstat(stream.fileno())
            if not _path_is_within(_opened_final_path(stream), root):
                raise TreeUnavailable("path_escape")
            if _metadata(opened) != expected or not stat.S_ISREG(opened.st_mode):
                raise TreeUnavailable("unstable_tree")
            content = stream.read(MAX_FILE_BYTES + 1)
            after = os.fstat(stream.fileno())
        if len(content) > MAX_FILE_BYTES or _metadata(after) != expected:
            raise TreeUnavailable("unstable_tree")
        return content
    except TreeUnavailable:
        raise
    except OSError as error:
        raise TreeUnavailable("incomplete_tree") from error


def snapshot_tree(root: Path) -> _TreeSnapshot:
    """Capture all task files except the explicitly excluded root .git metadata."""
    first = _collect_metadata(root)
    entries = []
    tree_hash = hashlib.sha256()
    for relative_path in sorted(first):
        content = _read_entry(root / Path(relative_path), first[relative_path], root)
        content_hash = hashlib.sha256(content).hexdigest()
        path_bytes = relative_path.encode("utf-8")
        tree_hash.update(len(path_bytes).to_bytes(8, "big"))
        tree_hash.update(path_bytes)
        tree_hash.update(len(content).to_bytes(8, "big"))
        tree_hash.update(content)
        entries.append(_SnapshotEntry(relative_path, content, content_hash))
    if _collect_metadata(root) != first:
        raise TreeUnavailable("unstable_tree")
    return _TreeSnapshot(tuple(entries), tree_hash.hexdigest(), sum(len(entry.content) for entry in entries))


def _within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _observation_dict(observation: NativeObservation) -> dict[str, Any]:
    participants = []
    for evidence in sorted(observation.participants, key=lambda item: item.identity):
        row = asdict(evidence)
        row["availability"] = evidence.availability.value
        participants.append(row)
    return {
        "acquisition_sequence": observation.acquisition_sequence,
        "acquired_started_ns": observation.acquired_started_ns,
        "acquired_completed_ns": observation.acquired_completed_ns,
        "broker_availability": observation.broker_availability.value,
        "queue_availability": observation.queue_availability.value,
        "broker_boot_id": observation.broker_boot_id,
        "state_revisions": asdict(observation.state_revisions)
        if observation.state_revisions is not None
        else None,
        "participants": participants,
        "queued_notices": observation.queued_notices,
        "in_flight_notices": observation.in_flight_notices,
    }


def _fingerprint(observation: NativeObservation, snapshot: _TreeSnapshot) -> str:
    completed_state = _observation_dict(observation)
    # These prove a fresh bounded read, but are not part of the state whose
    # stability is being confirmed.
    del completed_state["acquisition_sequence"]
    del completed_state["acquired_started_ns"]
    del completed_state["acquired_completed_ns"]
    document = {"native_observation": completed_state, "task_tree": snapshot.sha256}
    encoded = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _write_json(path: Path, value: object) -> None:
    encoded = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")
    with path.open("xb") as stream:
        stream.write(encoded)


def _write_snapshot(destination: Path, snapshot: _TreeSnapshot) -> None:
    destination.mkdir()
    for entry in snapshot.entries:
        target = destination.joinpath(*entry.relative_path.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(entry.content)


def _snapshot_inventory(snapshot: _TreeSnapshot) -> dict[str, object]:
    return {
        "files": [
            {
                "path": entry.relative_path,
                "bytes": len(entry.content),
                "sha256": entry.sha256,
            }
            for entry in snapshot.entries
        ],
        "snapshot_sha256": snapshot.sha256,
        "total_bytes": snapshot.total_bytes,
    }


class CompletionObserver:
    """Observe an arm without prompting it and freeze one scored task snapshot."""

    def __init__(
        self,
        *,
        expected_participants: tuple[ParticipantIdentity, ...],
        task_root: Path | str,
        retention_root: Path | str,
        run_id: str,
        first_task_submission_ns: int,
        confirmation_ns: int = CONFIRMATION_NS,
        arm_deadline_ns: int = ARM_DEADLINE_NS,
    ) -> None:
        if not isinstance(expected_participants, tuple) or not expected_participants:
            raise ValueError("at least one exact participant is required")
        if not all(isinstance(item, ParticipantIdentity) for item in expected_participants):
            raise ValueError("invalid expected participant")
        if len(set(expected_participants)) != len(expected_participants):
            raise ValueError("duplicate expected participant")
        if not _RUN_ID.fullmatch(run_id):
            raise ValueError("invalid run_id")
        if not _nonnegative_integer(first_task_submission_ns):
            raise ValueError("invalid first task submission time")
        if not _nonnegative_integer(confirmation_ns) or confirmation_ns < CONFIRMATION_NS:
            raise ValueError("confirmation interval must be at least one second")
        if not _nonnegative_integer(arm_deadline_ns) or arm_deadline_ns != ARM_DEADLINE_NS:
            raise ValueError("prototype requires the registered 60-minute deadline")

        task = _checked_existing_root(task_root)
        retention = _checked_existing_root(retention_root)
        if _within(retention, task) or _within(task, retention):
            raise ValueError("task and retention roots must not overlap")
        if (retention / run_id).exists():
            raise FileExistsError("retained observer artifact already exists")
        first_attempt = retention / f"{run_id}.publication-attempt-0001"
        if first_attempt.exists():
            raise FileExistsError("retained observer publication attempt already exists")

        self._expected = tuple(sorted(expected_participants))
        self._task_root = task
        self._retention_root = retention
        self._run_id = run_id
        self._first_submission_ns = first_task_submission_ns
        self._confirmation_ns = confirmation_ns
        self._deadline_ns = arm_deadline_ns
        self._candidate_fingerprint: str | None = None
        self._first_candidate_at_ns: int | None = None
        self._candidate_at_ns: int | None = None
        self._candidate_acquired_completed_ns: int | None = None
        self._frozen_at_ns: int | None = None
        self._scored_snapshot_sha256: str | None = None
        self._artifact_dir: Path | None = None
        self._terminal_state: ObserverState | None = None
        self._late_sequence = 0
        self._last_retained_tree_sha256: str | None = None
        self._last_late_artifact_dir: Path | None = None
        self._publication_sequence = 0
        self._last_failed_artifact_dir: Path | None = None
        self._publication_refused = False
        self._publication_refused_snapshot_sha256: str | None = None
        self._last_acquisition_sequence: int | None = None
        self._last_acquisition_completed_ns: int | None = None

    def _freshness_reason(self, observation: NativeObservation, now_ns: int) -> str | None:
        if observation.acquired_started_ns < self._first_submission_ns:
            return "acquisition_predates_task_submission"
        if observation.acquired_completed_ns > now_ns:
            return "acquisition_from_future"
        if observation.acquired_completed_ns - observation.acquired_started_ns > MAX_ACQUISITION_NS:
            return "acquisition_interval_unbounded"
        if now_ns - observation.acquired_completed_ns > MAX_EVIDENCE_AGE_NS:
            return "acquisition_too_old"
        if (
            self._last_acquisition_sequence is not None
            and observation.acquisition_sequence <= self._last_acquisition_sequence
        ):
            return "stale_acquisition_sequence"
        if (
            self._last_acquisition_completed_ns is not None
            and observation.acquired_started_ns < self._last_acquisition_completed_ns
        ):
            return "overlapping_acquisition_interval"
        self._last_acquisition_sequence = observation.acquisition_sequence
        self._last_acquisition_completed_ns = observation.acquired_completed_ns
        return None

    def _quiet_reason(self, observation: NativeObservation) -> str | None:
        if observation.broker_availability is not EvidenceAvailability.AVAILABLE:
            return f"broker_evidence_{observation.broker_availability.value}"
        if observation.queue_availability is not EvidenceAvailability.AVAILABLE:
            return f"queue_evidence_{observation.queue_availability.value}"
        identities = tuple(sorted(item.identity for item in observation.participants))
        if len(identities) != len(set(identities)) or identities != self._expected:
            return "participant_identity_mismatch"
        if observation.queued_notices != 0 or observation.in_flight_notices != 0:
            return "native_notices_not_drained"
        for evidence in observation.participants:
            label = evidence.identity.session_id
            if evidence.availability is not EvidenceAvailability.AVAILABLE:
                return f"participant_{label}_evidence_{evidence.availability.value}"
            if not evidence.normal_final:
                return f"participant_{label}_no_normal_final"
            if evidence.final_after_task_revision != evidence.latest_task_input_revision:
                return f"participant_{label}_final_before_latest_task"
            if evidence.final_after_wake_revision != evidence.latest_delivered_wake_revision:
                return f"participant_{label}_final_before_latest_wake"
            if (
                evidence.active_model_work != 0
                or evidence.active_tool_work != 0
                or evidence.active_delegated_work != 0
            ):
                return f"participant_{label}_active_work"
        return None

    def _result(
        self,
        state: ObserverState,
        reason: str,
        *,
        snapshot_sha256: str | None = None,
        late_artifact_dir: Path | None = None,
        failed_artifact_dir: Path | None = None,
    ) -> ObservationResult:
        return ObservationResult(
            state=state,
            reason=reason,
            completion_credit=state is ObserverState.FROZEN,
            first_candidate_at_ns=self._first_candidate_at_ns,
            candidate_at_ns=self._candidate_at_ns,
            frozen_at_ns=self._frozen_at_ns,
            snapshot_sha256=snapshot_sha256,
            artifact_dir=str(self._artifact_dir) if self._artifact_dir else None,
            late_artifact_dir=str(late_artifact_dir) if late_artifact_dir else None,
            failed_artifact_dir=str(failed_artifact_dir) if failed_artifact_dir else None,
        )

    def _create_artifact(
        self,
        *,
        state: ObserverState,
        now_ns: int,
        observation: NativeObservation,
        snapshot: _TreeSnapshot | None,
        reason: str,
    ) -> Path:
        self._publication_sequence += 1
        attempt = self._retention_root / (
            f"{self._run_id}.publication-attempt-{self._publication_sequence:04d}"
        )
        artifact = self._retention_root / self._run_id
        snapshot_name = "scored-snapshot" if state is ObserverState.FROZEN else "partial-snapshot"
        try:
            attempt.mkdir()
        except OSError as error:
            # The path was never exclusively created by this call, so it must
            # not be named as retained evidence or mutated with a marker.
            raise ArtifactPublicationFailed(None, type(error).__name__) from error

        preparation = {
            "schema": "observer-publication-preparation/v1",
            "publication_status": "unpublished_preparation",
            "authoritative": False,
            "completion_credit": False,
            "intended_state": state.value,
            "observed_at_ns": now_ns,
            "snapshot_sha256": snapshot.sha256 if snapshot else None,
        }
        manifest = {
            "schema": "observer-artifact-manifest/v2",
            "schema_version": 2,
            "publication": {
                "authoritative_only_at": f"{self._run_id}/observer-manifest.json",
                "commit_boundary": "final_manifest_filename_rename",
                "preparation_and_pending_files_authoritative": False,
            },
            "state": state.value,
            "reason": reason,
            "first_task_submission_ns": self._first_submission_ns,
            "first_candidate_at_ns": self._first_candidate_at_ns,
            "candidate_at_ns": self._candidate_at_ns,
            "candidate_acquired_completed_ns": self._candidate_acquired_completed_ns,
            "frozen_at_ns": now_ns if state is ObserverState.FROZEN else None,
            "observed_at_ns": now_ns,
            "confirmation_interval_ns": self._confirmation_ns,
            "arm_deadline_ns": self._deadline_ns,
            "completion_credit": state is ObserverState.FROZEN,
            "snapshot_sha256": snapshot.sha256 if snapshot else None,
            "native_observation": _observation_dict(observation),
            "coverage": {
                "input_provenance": "caller_supplied_unverified_adapter_evidence",
                "live_native_completion": "unverified",
                "provider_atomic_snapshot": "not_claimed",
                "grader_access": "none",
                "model_messages_sent": 0,
            },
        }
        try:
            _write_json(attempt / "publication-preparation.json", preparation)
            if snapshot is not None:
                _write_snapshot(attempt / snapshot_name, snapshot)
                _write_json(
                    attempt / f"{snapshot_name}-files.json", _snapshot_inventory(snapshot)
                )
            attempt.rename(artifact)
        except OSError as error:
            self._last_failed_artifact_dir = attempt
            try:
                _write_json(
                    attempt / "publication-failure.json",
                    {
                        "classification": "incomplete_unscored_publication_attempt",
                        "observed_at_ns": now_ns,
                        "error_type": type(error).__name__,
                    },
                )
            except OSError:
                pass
            raise ArtifactPublicationFailed(attempt, type(error).__name__) from error

        pending_manifest = artifact / "observer-manifest.commit-pending.json"
        try:
            _write_json(pending_manifest, manifest)
            pending_manifest.rename(artifact / "observer-manifest.json")
        except OSError as error:
            self._last_failed_artifact_dir = artifact
            try:
                _write_json(
                    artifact / "publication-failure.json",
                    {
                        "classification": "final_manifest_commit_refused",
                        "observed_at_ns": now_ns,
                        "error_type": type(error).__name__,
                    },
                )
            except OSError:
                pass
            raise ArtifactPublicationFailed(
                artifact, type(error).__name__, publication_refused=True
            ) from error
        return artifact

    def _observe_after_freeze(
        self, observation: NativeObservation, now_ns: int
    ) -> ObservationResult:
        try:
            snapshot = snapshot_tree(self._task_root)
        except TreeUnavailable as error:
            return self._result(
                ObserverState.FROZEN,
                f"post_freeze_tree_unavailable:{error}",
                snapshot_sha256=self._scored_snapshot_sha256,
            )
        if snapshot.sha256 == self._last_retained_tree_sha256:
            reason = (
                "late_snapshot_already_retained"
                if self._last_late_artifact_dir is not None
                else "scored_snapshot_already_frozen"
            )
            return self._result(
                ObserverState.FROZEN,
                reason,
                snapshot_sha256=self._scored_snapshot_sha256,
                late_artifact_dir=self._last_late_artifact_dir,
            )
        self._late_sequence += 1
        late_root = self._artifact_dir / "late-writes"
        late = late_root / f"observation-{self._late_sequence:04d}-{now_ns}-{snapshot.sha256[:16]}"
        owns_late = False
        try:
            late_root.mkdir(exist_ok=True)
            late.mkdir()
            owns_late = True
            _write_snapshot(late / "snapshot", snapshot)
            _write_json(late / "snapshot-files.json", _snapshot_inventory(snapshot))
            _write_json(
                late / "late-observation.json",
                {
                    "observed_at_ns": now_ns,
                    "snapshot_sha256": snapshot.sha256,
                    "scored_snapshot_sha256": self._scored_snapshot_sha256,
                    "native_observation": _observation_dict(observation),
                    "classification": "post_freeze_task_tree_change_not_scored",
                },
            )
        except OSError as error:
            failed_artifact = late if owns_late else None
            self._last_failed_artifact_dir = failed_artifact
            return self._result(
                ObserverState.FROZEN,
                f"late_write_retention_failed:{type(error).__name__}",
                snapshot_sha256=self._scored_snapshot_sha256,
                failed_artifact_dir=failed_artifact,
            )
        self._last_retained_tree_sha256 = snapshot.sha256
        self._last_late_artifact_dir = late
        return self._result(
            ObserverState.FROZEN,
            "late_write_retained_separately",
            snapshot_sha256=self._scored_snapshot_sha256,
            late_artifact_dir=late,
        )

    def observe(self, observation: NativeObservation, *, now_ns: int) -> ObservationResult:
        if not isinstance(observation, NativeObservation):
            raise ValueError("observation must be NativeObservation")
        if not _nonnegative_integer(now_ns) or now_ns < self._first_submission_ns:
            raise ValueError("observation time predates first task submission")
        if self._terminal_state is ObserverState.FROZEN:
            return self._observe_after_freeze(observation, now_ns)
        if self._terminal_state is ObserverState.CENSORED:
            return self._result(ObserverState.CENSORED, "arm_already_censored")

        if self._publication_refused:
            if now_ns - self._first_submission_ns > self._deadline_ns:
                self._terminal_state = ObserverState.CENSORED
                return self._result(
                    ObserverState.CENSORED,
                    "arm_deadline_elapsed;artifact_publication_refused",
                    snapshot_sha256=self._publication_refused_snapshot_sha256,
                    failed_artifact_dir=self._last_failed_artifact_dir,
                )
            return self._result(
                ObserverState.WAITING,
                "artifact_publication_refused",
                snapshot_sha256=self._publication_refused_snapshot_sha256,
                failed_artifact_dir=self._last_failed_artifact_dir,
            )

        if now_ns - self._first_submission_ns > self._deadline_ns:
            try:
                partial = snapshot_tree(self._task_root)
            except TreeUnavailable:
                partial = None
            self._candidate_fingerprint = None
            self._candidate_at_ns = None
            self._candidate_acquired_completed_ns = None
            try:
                self._artifact_dir = self._create_artifact(
                    state=ObserverState.CENSORED,
                    now_ns=now_ns,
                    observation=observation,
                    snapshot=partial,
                    reason="arm_deadline_elapsed_from_first_task_submission",
                )
                reason = "arm_deadline_elapsed_from_first_task_submission"
            except ArtifactPublicationFailed as error:
                reason = "arm_deadline_elapsed;artifact_publication_failed"
                self._last_failed_artifact_dir = error.failed_artifact_dir
            self._terminal_state = ObserverState.CENSORED
            return self._result(
                ObserverState.CENSORED,
                reason,
                snapshot_sha256=partial.sha256 if partial else None,
                failed_artifact_dir=self._last_failed_artifact_dir,
            )

        freshness_reason = self._freshness_reason(observation, now_ns)
        if freshness_reason is not None:
            self._candidate_fingerprint = None
            self._candidate_at_ns = None
            self._candidate_acquired_completed_ns = None
            return self._result(ObserverState.WAITING, freshness_reason)

        reason = self._quiet_reason(observation)
        if reason is not None:
            self._candidate_fingerprint = None
            self._candidate_at_ns = None
            self._candidate_acquired_completed_ns = None
            return self._result(ObserverState.WAITING, reason)
        try:
            snapshot = snapshot_tree(self._task_root)
        except TreeUnavailable as error:
            self._candidate_fingerprint = None
            self._candidate_at_ns = None
            self._candidate_acquired_completed_ns = None
            return self._result(ObserverState.WAITING, f"task_tree_unavailable:{error}")

        fingerprint = _fingerprint(observation, snapshot)
        if fingerprint != self._candidate_fingerprint:
            self._candidate_fingerprint = fingerprint
            self._candidate_at_ns = now_ns
            self._candidate_acquired_completed_ns = observation.acquired_completed_ns
            if self._first_candidate_at_ns is None:
                self._first_candidate_at_ns = now_ns
            return self._result(
                ObserverState.CANDIDATE,
                "first_coherent_completed_observation",
                snapshot_sha256=snapshot.sha256,
            )
        if now_ns - self._candidate_at_ns < self._confirmation_ns:
            return self._result(
                ObserverState.CANDIDATE,
                "confirmation_interval_not_elapsed",
                snapshot_sha256=snapshot.sha256,
            )
        if (
            observation.acquired_started_ns - self._candidate_acquired_completed_ns
            < self._confirmation_ns
        ):
            return self._result(
                ObserverState.CANDIDATE,
                "confirmation_acquisition_gap_not_elapsed",
                snapshot_sha256=snapshot.sha256,
            )

        try:
            artifact = self._create_artifact(
                state=ObserverState.FROZEN,
                now_ns=now_ns,
                observation=observation,
                snapshot=snapshot,
                reason="two_coherent_completed_observations",
            )
        except ArtifactPublicationFailed as error:
            self._candidate_fingerprint = None
            self._candidate_at_ns = None
            self._candidate_acquired_completed_ns = None
            if error.publication_refused:
                self._publication_refused = True
                self._publication_refused_snapshot_sha256 = snapshot.sha256
            return self._result(
                ObserverState.WAITING,
                (
                    "artifact_publication_refused"
                    if error.publication_refused
                    else "artifact_publication_failed"
                ),
                snapshot_sha256=snapshot.sha256,
                failed_artifact_dir=error.failed_artifact_dir,
            )
        self._artifact_dir = artifact
        self._frozen_at_ns = now_ns
        self._scored_snapshot_sha256 = snapshot.sha256
        self._last_retained_tree_sha256 = snapshot.sha256
        self._terminal_state = ObserverState.FROZEN
        return self._result(
            ObserverState.FROZEN,
            "two_coherent_completed_observations",
            snapshot_sha256=snapshot.sha256,
        )
