import importlib.util
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest import mock


HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "completion_observer.py"


def load_observer_module():
    spec = importlib.util.spec_from_file_location("completion_observer", MODULE_PATH)
    if spec is None or spec.loader is None or not MODULE_PATH.is_file():
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class CompletionObserverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observer = load_observer_module()
        fixture_root = os.environ.get("EVALUATION_OBSERVER_FIXTURE_ROOT")
        if not fixture_root:
            raise AssertionError("EVALUATION_OBSERVER_FIXTURE_ROOT is required")
        cls.fixture_root = Path(fixture_root).resolve()
        cls.fixture_root.mkdir(parents=True, exist_ok=False)
        cls.case_number = 0

    def setUp(self):
        if self.observer is None:
            if self._testMethodName != "test_module_exists":
                self.skipTest("completion_observer.py has not been implemented")
            return
        type(self).case_number += 1
        self.case = self.fixture_root / f"case-{self.case_number:02d}-{self._testMethodName}"
        self.task = self.case / "task"
        self.retained = self.case / "retained"
        self.task.mkdir(parents=True)
        self.retained.mkdir()
        (self.task / "answer.txt").write_text("first\n", encoding="utf-8")
        (self.task / ".git").mkdir()
        (self.task / ".git" / "ignored-object").write_text("metadata", encoding="utf-8")
        self.alice = self.observer.ParticipantIdentity("alice", "boot-a", 7)
        self.bob = self.observer.ParticipantIdentity("bob", "boot-b", 4)
        self.acquisition_sequence = 0

    def test_module_exists(self):
        self.assertIsNotNone(self.observer, "completion_observer.py has not been implemented")

    def evidence(
        self,
        identity,
        *,
        availability=None,
        latest_task=10,
        latest_wake=3,
        final_task=10,
        final_wake=3,
        normal_final=True,
        final_response_id=None,
        active_model=0,
        active_tool=0,
        active_delegated=0,
    ):
        if availability is None:
            availability = self.observer.EvidenceAvailability.AVAILABLE
        return self.observer.ParticipantEvidence(
            identity=identity,
            availability=availability,
            latest_task_input_revision=latest_task,
            latest_delivered_wake_revision=latest_wake,
            final_after_task_revision=final_task,
            final_after_wake_revision=final_wake,
            normal_final=normal_final,
            normal_final_response_id=final_response_id or f"final-{latest_task}-{latest_wake}",
            active_model_work=active_model,
            active_tool_work=active_tool,
            active_delegated_work=active_delegated,
        )

    def observation(self, *participants, inventory_revision=20, delivery_revision=30,
                    run_revision=40, queued=0, in_flight=0,
                    broker_availability=None, queue_availability=None, acquisition_sequence=None,
                    acquired_started_ns=None, acquired_completed_ns=None):
        available = self.observer.EvidenceAvailability.AVAILABLE
        if acquisition_sequence is None:
            self.acquisition_sequence += 1
            acquisition_sequence = self.acquisition_sequence
        if acquired_started_ns is None:
            acquired_started_ns = 1_000_000_000 + (acquisition_sequence - 1) * 1_100_000_000
        if acquired_completed_ns is None:
            acquired_completed_ns = acquired_started_ns + 1_000_000
        return self.observer.NativeObservation(
            acquisition_sequence=acquisition_sequence,
            acquired_started_ns=acquired_started_ns,
            acquired_completed_ns=acquired_completed_ns,
            broker_availability=broker_availability or available,
            queue_availability=queue_availability or available,
            broker_boot_id="broker-boot-1",
            state_revisions=self.observer.StateRevisions(
                inventory_revision, delivery_revision, run_revision
            ),
            participants=participants or (self.evidence(self.alice), self.evidence(self.bob)),
            queued_notices=queued,
            in_flight_notices=in_flight,
        )

    def controller(self, run_id=None, first_submission_ns=1_000_000_000):
        return self.observer.CompletionObserver(
            expected_participants=(self.alice, self.bob),
            task_root=self.task,
            retention_root=self.retained,
            run_id=run_id or f"run-{self.case_number}",
            first_task_submission_ns=first_submission_ns,
        )

    def test_two_coherent_observations_freeze_exact_tree_and_credit_once(self):
        controller = self.controller()
        first = controller.observe(self.observation(), now_ns=2_000_000_000)
        self.assertEqual(first.state, self.observer.ObserverState.CANDIDATE)
        self.assertFalse(first.completion_credit)
        self.assertEqual(first.candidate_at_ns, 2_000_000_000)

        frozen = controller.observe(self.observation(), now_ns=3_000_000_000)
        self.assertEqual(frozen.state, self.observer.ObserverState.FROZEN)
        self.assertTrue(frozen.completion_credit)
        self.assertEqual(frozen.candidate_at_ns, 2_000_000_000)
        self.assertEqual(frozen.frozen_at_ns, 3_000_000_000)
        artifact = Path(frozen.artifact_dir)
        self.assertEqual((artifact / "scored-snapshot" / "answer.txt").read_text(), "first\n")
        self.assertFalse((artifact / "scored-snapshot" / ".git").exists())
        manifest = json.loads((artifact / "observer-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema"], "observer-artifact-manifest/v2")
        self.assertEqual(
            manifest["publication"]["authoritative_only_at"],
            f"{artifact.name}/observer-manifest.json",
        )
        self.assertFalse(manifest["publication"]["preparation_and_pending_files_authoritative"])
        preparation = json.loads(
            (artifact / "publication-preparation.json").read_text(encoding="utf-8")
        )
        self.assertFalse(preparation["completion_credit"])
        self.assertFalse((artifact / "observer-manifest.commit-pending.json").exists())
        self.assertEqual(manifest["candidate_at_ns"], 2_000_000_000)
        self.assertEqual(manifest["frozen_at_ns"], 3_000_000_000)
        self.assertEqual(manifest["snapshot_sha256"], frozen.snapshot_sha256)
        again = controller.observe(self.observation(), now_ns=4_000_000_000)
        self.assertEqual(again.artifact_dir, frozen.artifact_dir)
        self.assertEqual(again.snapshot_sha256, frozen.snapshot_sha256)

    def test_task_snapshot_files_name_is_preserved_and_inventory_stays_outside_tree(self):
        (self.task / "snapshot-files.json").write_text("task-owned\n", encoding="utf-8")
        controller = self.controller()
        controller.observe(self.observation(), now_ns=2_000_000_000)
        try:
            frozen = controller.observe(self.observation(), now_ns=3_000_000_000)
        except OSError as error:
            self.fail(f"observer metadata collided with a task file: {error}")
        artifact = Path(frozen.artifact_dir)
        scored = artifact / "scored-snapshot"
        self.assertEqual((scored / "snapshot-files.json").read_text(), "task-owned\n")
        task_files = sorted(
            path.relative_to(self.task).as_posix()
            for path in self.task.rglob("*")
            if path.is_file() and ".git" not in path.relative_to(self.task).parts
        )
        scored_files = sorted(
            path.relative_to(scored).as_posix() for path in scored.rglob("*") if path.is_file()
        )
        self.assertEqual(scored_files, task_files)
        self.assertTrue((artifact / "scored-snapshot-files.json").is_file())

    def test_active_tool_and_queue_activity_restart_candidate(self):
        controller = self.controller()
        active = self.observation(self.evidence(self.alice, active_tool=1), self.evidence(self.bob))
        waiting = controller.observe(active, now_ns=2_000_000_000)
        self.assertEqual(waiting.state, self.observer.ObserverState.WAITING)
        self.assertFalse(waiting.completion_credit)
        self.assertIsNone(waiting.candidate_at_ns)

        candidate = controller.observe(self.observation(), now_ns=3_000_000_000)
        self.assertEqual(candidate.state, self.observer.ObserverState.CANDIDATE)
        queue_busy = controller.observe(self.observation(queued=1), now_ns=4_000_000_000)
        self.assertEqual(queue_busy.state, self.observer.ObserverState.WAITING)
        restarted = controller.observe(self.observation(), now_ns=5_000_000_000)
        self.assertEqual(restarted.candidate_at_ns, 5_000_000_000)

    def test_delayed_wake_invalidates_final_and_requires_new_two_observation_window(self):
        controller = self.controller()
        controller.observe(self.observation(), now_ns=2_000_000_000)
        delayed = self.observation(
            self.evidence(self.alice, latest_wake=4, final_wake=3), self.evidence(self.bob)
        )
        result = controller.observe(delayed, now_ns=3_000_000_000)
        self.assertEqual(result.state, self.observer.ObserverState.WAITING)
        self.assertIn("final_before_latest_wake", result.reason)
        caught_up = self.observation(
            self.evidence(self.alice, latest_wake=4, final_wake=4), self.evidence(self.bob)
        )
        candidate = controller.observe(caught_up, now_ns=4_000_000_000)
        self.assertEqual(candidate.state, self.observer.ObserverState.CANDIDATE)
        self.assertEqual(candidate.candidate_at_ns, 4_000_000_000)
        frozen = controller.observe(
            self.observation(
                self.evidence(self.alice, latest_wake=4, final_wake=4), self.evidence(self.bob)
            ),
            now_ns=5_000_000_000,
        )
        self.assertEqual(frozen.state, self.observer.ObserverState.FROZEN)

    def test_late_file_write_is_retained_without_replacing_scored_snapshot(self):
        controller = self.controller()
        controller.observe(self.observation(), now_ns=2_000_000_000)
        frozen = controller.observe(self.observation(), now_ns=3_000_000_000)
        scored = Path(frozen.artifact_dir) / "scored-snapshot" / "answer.txt"
        original_manifest = (Path(frozen.artifact_dir) / "observer-manifest.json").read_bytes()

        (self.task / "answer.txt").write_text("late\n", encoding="utf-8")
        late = controller.observe(self.observation(run_revision=41), now_ns=4_000_000_000)
        self.assertEqual(late.state, self.observer.ObserverState.FROZEN)
        self.assertTrue(late.completion_credit)
        self.assertEqual(scored.read_text(encoding="utf-8"), "first\n")
        self.assertEqual((Path(frozen.artifact_dir) / "observer-manifest.json").read_bytes(), original_manifest)
        late_dir = Path(late.late_artifact_dir)
        self.assertEqual((late_dir / "snapshot" / "answer.txt").read_text(encoding="utf-8"), "late\n")
        marker = json.loads((late_dir / "late-observation.json").read_text(encoding="utf-8"))
        self.assertNotEqual(marker["snapshot_sha256"], frozen.snapshot_sha256)
        self.assertEqual(marker["scored_snapshot_sha256"], frozen.snapshot_sha256)

        repeated = controller.observe(self.observation(run_revision=42), now_ns=5_000_000_000)
        self.assertEqual(repeated.reason, "late_snapshot_already_retained")
        self.assertEqual(repeated.late_artifact_dir, late.late_artifact_dir)
        late_directories = [path for path in (Path(frozen.artifact_dir) / "late-writes").iterdir()]
        self.assertEqual(len(late_directories), 1)

        (self.task / "answer.txt").write_text("third\n", encoding="utf-8")
        distinct = controller.observe(self.observation(run_revision=43), now_ns=6_000_000_000)
        self.assertNotEqual(distinct.late_artifact_dir, late.late_artifact_dir)
        self.assertEqual(Path(distinct.late_artifact_dir, "snapshot", "answer.txt").read_text(), "third\n")

    def test_unavailable_missing_uncertain_held_and_refused_never_complete(self):
        statuses = [
            self.observer.EvidenceAvailability.MISSING,
            self.observer.EvidenceAvailability.UNAVAILABLE,
            self.observer.EvidenceAvailability.UNCERTAIN,
            self.observer.EvidenceAvailability.HELD,
            self.observer.EvidenceAvailability.REFUSED,
        ]
        for offset, status in enumerate(statuses):
            controller = self.controller(run_id=f"unavailable-{offset}")
            observed = self.observation(self.evidence(self.alice, availability=status), self.evidence(self.bob))
            first = controller.observe(observed, now_ns=2_000_000_000)
            second = controller.observe(observed, now_ns=4_000_000_000)
            self.assertEqual(first.state, self.observer.ObserverState.WAITING)
            self.assertEqual(second.state, self.observer.ObserverState.WAITING)
            self.assertFalse(second.completion_credit)
            self.assertIsNone(second.artifact_dir)

    def test_deadline_censors_from_first_submission_and_retains_partial_state(self):
        controller = self.controller(first_submission_ns=10)
        at_deadline = controller.observe(
            self.observation(
                acquired_started_ns=3_599_999_000_010,
                acquired_completed_ns=3_600_000_000_010,
            ),
            now_ns=3_600_000_000_010,
        )
        self.assertEqual(at_deadline.state, self.observer.ObserverState.CANDIDATE)
        censored = controller.observe(self.observation(), now_ns=3_600_000_000_011)
        self.assertEqual(censored.state, self.observer.ObserverState.CENSORED)
        self.assertFalse(censored.completion_credit)
        artifact = Path(censored.artifact_dir)
        manifest = json.loads((artifact / "observer-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["state"], "censored")
        self.assertEqual(manifest["first_task_submission_ns"], 10)
        self.assertEqual((artifact / "partial-snapshot" / "answer.txt").read_text(), "first\n")

    def test_identity_or_generation_mismatch_and_duplicate_participant_fail_closed(self):
        controller = self.controller()
        wrong_alice = self.observer.ParticipantIdentity("alice", "other-boot", 7)
        cases = [
            self.observation(self.evidence(wrong_alice), self.evidence(self.bob)),
            self.observation(self.evidence(self.alice), self.evidence(self.alice)),
            self.observation(self.evidence(self.alice)),
        ]
        for offset, observed in enumerate(cases):
            result = controller.observe(observed, now_ns=2_000_000_000 + offset * 1_100_000_000)
            self.assertEqual(result.state, self.observer.ObserverState.WAITING)
            self.assertFalse(result.completion_credit)
            self.assertIn("participant_identity", result.reason)

    def test_broker_or_queue_evidence_unavailable_fails_closed(self):
        controller = self.controller()
        unavailable = self.observer.EvidenceAvailability.UNAVAILABLE
        for observed in (
            self.observation(broker_availability=unavailable),
            self.observation(queue_availability=unavailable),
        ):
            result = controller.observe(observed, now_ns=2_000_000_000)
            self.assertEqual(result.state, self.observer.ObserverState.WAITING)
            self.assertFalse(result.completion_credit)

    def test_tree_change_and_broker_revision_change_each_restart_candidate(self):
        controller = self.controller()
        controller.observe(self.observation(), now_ns=2_000_000_000)
        (self.task / "answer.txt").write_text("second\n", encoding="utf-8")
        changed_tree = controller.observe(self.observation(), now_ns=3_000_000_000)
        self.assertEqual(changed_tree.state, self.observer.ObserverState.CANDIDATE)
        self.assertEqual(changed_tree.candidate_at_ns, 3_000_000_000)
        changed_revision = controller.observe(self.observation(run_revision=41), now_ns=4_000_000_000)
        self.assertEqual(changed_revision.state, self.observer.ObserverState.CANDIDATE)
        self.assertEqual(changed_revision.candidate_at_ns, 4_000_000_000)

    def test_full_revision_tuple_is_compared_without_lossy_aggregation(self):
        controller = self.controller()
        controller.observe(self.observation(), now_ns=2_000_000_000)
        same_sum_different_tuple = controller.observe(
            self.observation(inventory_revision=21, delivery_revision=29),
            now_ns=3_000_000_000,
        )
        self.assertEqual(same_sum_different_tuple.state, self.observer.ObserverState.CANDIDATE)
        self.assertEqual(same_sum_different_tuple.candidate_at_ns, 3_000_000_000)
        frozen = controller.observe(
            self.observation(inventory_revision=21, delivery_revision=29),
            now_ns=4_000_000_000,
        )
        self.assertEqual(frozen.state, self.observer.ObserverState.FROZEN)

    def test_replayed_evidence_and_changed_final_identity_cannot_confirm_candidate(self):
        controller = self.controller()
        first_observation = self.observation()
        first = controller.observe(first_observation, now_ns=2_000_000_000)
        replay = controller.observe(first_observation, now_ns=3_000_000_000)
        self.assertEqual(first.state, self.observer.ObserverState.CANDIDATE)
        self.assertEqual(replay.state, self.observer.ObserverState.WAITING)
        self.assertEqual(replay.reason, "stale_acquisition_sequence")
        changed_final = self.observation(
            self.evidence(self.alice, final_response_id="replacement-final"), self.evidence(self.bob)
        )
        second_candidate = controller.observe(changed_final, now_ns=4_000_000_000)
        self.assertEqual(second_candidate.state, self.observer.ObserverState.CANDIDATE)
        same_state_fresh = self.observation(
            self.evidence(self.alice, final_response_id="replacement-final"), self.evidence(self.bob)
        )
        frozen = controller.observe(same_state_fresh, now_ns=5_000_000_000)
        self.assertEqual(frozen.state, self.observer.ObserverState.FROZEN)
        self.assertEqual(frozen.first_candidate_at_ns, 2_000_000_000)
        self.assertEqual(frozen.candidate_at_ns, 4_000_000_000)

    def test_confirmation_uses_acquisition_windows_not_delayed_observe_calls(self):
        controller = self.controller()
        first = self.observation(
            acquisition_sequence=1,
            acquired_started_ns=1_100_000_000,
            acquired_completed_ns=1_200_000_000,
        )
        nearby = self.observation(
            acquisition_sequence=2,
            acquired_started_ns=1_300_000_000,
            acquired_completed_ns=1_400_000_000,
        )
        separated = self.observation(
            acquisition_sequence=3,
            acquired_started_ns=2_200_000_000,
            acquired_completed_ns=2_300_000_000,
        )
        controller.observe(first, now_ns=2_000_000_000)
        delayed_delivery = controller.observe(nearby, now_ns=3_000_000_000)
        self.assertEqual(delayed_delivery.state, self.observer.ObserverState.CANDIDATE)
        self.assertEqual(delayed_delivery.reason, "confirmation_acquisition_gap_not_elapsed")
        self.assertFalse(delayed_delivery.completion_credit)
        frozen = controller.observe(separated, now_ns=4_000_000_000)
        self.assertEqual(frozen.state, self.observer.ObserverState.FROZEN)

    def test_publication_failure_never_commits_credit_and_a_new_window_can_retry(self):
        controller = self.controller()
        controller.observe(self.observation(), now_ns=2_000_000_000)
        original = self.observer._write_snapshot
        attempts = 0

        def fail_first_publication(destination, snapshot):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                destination.mkdir()
                raise OSError("owned injected publication failure")
            return original(destination, snapshot)

        try:
            with mock.patch.object(self.observer, "_write_snapshot", side_effect=fail_first_publication):
                failed = controller.observe(self.observation(), now_ns=3_000_000_000)
        except OSError as error:
            self.fail(f"publication failure escaped instead of failing closed: {error}")
        self.assertEqual(failed.state, self.observer.ObserverState.WAITING)
        self.assertFalse(failed.completion_credit)
        self.assertIsNone(failed.frozen_at_ns)
        self.assertTrue(Path(failed.failed_artifact_dir).is_dir())
        candidate = controller.observe(self.observation(), now_ns=4_000_000_000)
        self.assertEqual(candidate.state, self.observer.ObserverState.CANDIDATE)
        frozen = controller.observe(self.observation(), now_ns=5_000_000_000)
        self.assertEqual(frozen.state, self.observer.ObserverState.FROZEN)
        self.assertTrue(frozen.completion_credit)

    def test_reconstructed_controller_refuses_retained_first_attempt_without_mutating_it(self):
        run_id = f"reconstructed-{self.case_number}"
        attempt = self.retained / f"{run_id}.publication-attempt-0001"
        attempt.mkdir()
        sentinel = attempt / "owned-sentinel.txt"
        sentinel.write_text("preserve exactly\n", encoding="utf-8")
        before = hashlib.sha256(sentinel.read_bytes()).hexdigest()

        with self.assertRaises(FileExistsError):
            self.controller(run_id=run_id)

        self.assertEqual(hashlib.sha256(sentinel.read_bytes()).hexdigest(), before)
        self.assertFalse((attempt / "publication-failure.json").exists())
        (self.case / "preservation-hashes.json").write_text(
            json.dumps(
                {
                    "preexisting_attempt_sentinel": {
                        "before_sha256": before,
                        "after_sha256": hashlib.sha256(sentinel.read_bytes()).hexdigest(),
                    }
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )

    def test_attempt_mkdir_failure_is_fail_closed_for_freeze_and_censor(self):
        original_mkdir = Path.mkdir

        for offset, mode in enumerate(("freeze", "censor"), start=1):
            with self.subTest(mode=mode):
                run_id = f"mkdir-{mode}-{self.case_number}"
                controller = self.controller(run_id=run_id, first_submission_ns=1)
                attempt = self.retained / f"{run_id}.publication-attempt-0001"

                def fail_owned_attempt(path, *args, **kwargs):
                    if path == attempt:
                        raise OSError(f"injected {mode} attempt mkdir failure")
                    return original_mkdir(path, *args, **kwargs)

                if mode == "freeze":
                    controller.observe(self.observation(), now_ns=2_000_000_000 + offset)
                    observed_at = 3_100_000_000 + offset
                else:
                    observed_at = self.observer.ARM_DEADLINE_NS + 2

                try:
                    with mock.patch.object(Path, "mkdir", fail_owned_attempt):
                        result = controller.observe(self.observation(), now_ns=observed_at)
                except OSError as error:
                    self.fail(f"{mode} attempt creation failure escaped: {error}")

                expected_state = (
                    self.observer.ObserverState.WAITING
                    if mode == "freeze"
                    else self.observer.ObserverState.CENSORED
                )
                self.assertEqual(result.state, expected_state)
                self.assertFalse(result.completion_credit)
                self.assertIsNone(result.failed_artifact_dir)
                self.assertFalse(attempt.exists())

    def test_attempt_collision_is_fail_closed_for_freeze_and_censor_without_mutation(self):
        for offset, mode in enumerate(("freeze", "censor"), start=1):
            with self.subTest(mode=mode):
                run_id = f"collision-{mode}-{self.case_number}"
                controller = self.controller(run_id=run_id, first_submission_ns=1)
                attempt = self.retained / f"{run_id}.publication-attempt-0001"
                attempt.mkdir()
                sentinel = attempt / "other-call.txt"
                sentinel.write_text("untouched\n", encoding="utf-8")
                before = sentinel.read_bytes()
                if mode == "freeze":
                    controller.observe(self.observation(), now_ns=2_000_000_000 + offset)
                    observed_at = 3_100_000_000 + offset
                else:
                    observed_at = self.observer.ARM_DEADLINE_NS + 2

                try:
                    result = controller.observe(self.observation(), now_ns=observed_at)
                except OSError as error:
                    self.fail(f"{mode} attempt collision escaped: {error}")

                expected_state = (
                    self.observer.ObserverState.WAITING
                    if mode == "freeze"
                    else self.observer.ObserverState.CENSORED
                )
                self.assertEqual(result.state, expected_state)
                self.assertFalse(result.completion_credit)
                self.assertIsNone(result.failed_artifact_dir)
                self.assertEqual(sentinel.read_bytes(), before)
                self.assertFalse((attempt / "publication-failure.json").exists())

    def test_directory_rename_failure_leaves_only_uncredited_preparation(self):
        run_id = f"rename-{self.case_number}"
        controller = self.controller(run_id=run_id)
        controller.observe(self.observation(), now_ns=2_000_000_000)
        original_rename = Path.rename

        def fail_directory_commit(path, target):
            if path.name == f"{run_id}.publication-attempt-0001":
                raise OSError("injected directory commit failure")
            return original_rename(path, target)

        with mock.patch.object(Path, "rename", fail_directory_commit):
            failed = controller.observe(self.observation(), now_ns=3_000_000_000)

        self.assertEqual(failed.state, self.observer.ObserverState.WAITING)
        self.assertFalse(failed.completion_credit)
        self.assertIsNone(failed.frozen_at_ns)
        attempt = Path(failed.failed_artifact_dir)
        preparation = json.loads(
            (attempt / "publication-preparation.json").read_text(encoding="utf-8")
        )
        self.assertEqual(preparation["schema"], "observer-publication-preparation/v1")
        self.assertFalse(preparation["completion_credit"])
        self.assertFalse((attempt / "observer-manifest.json").exists())

    def test_pending_manifest_write_failure_refuses_credit_without_extending_deadline(self):
        run_id = f"pending-write-{self.case_number}"
        controller = self.controller(run_id=run_id, first_submission_ns=1)
        controller.observe(self.observation(), now_ns=2_000_000_000)
        original_write_json = self.observer._write_json

        def fail_pending_manifest(path, value):
            if path.name == "observer-manifest.commit-pending.json":
                raise OSError("injected pending manifest write failure")
            return original_write_json(path, value)

        with mock.patch.object(self.observer, "_write_json", side_effect=fail_pending_manifest):
            failed = controller.observe(self.observation(), now_ns=3_000_000_000)

        artifact = self.retained / run_id
        self.assertEqual(failed.state, self.observer.ObserverState.WAITING)
        self.assertFalse(failed.completion_credit)
        self.assertEqual(failed.failed_artifact_dir, str(artifact))
        self.assertTrue((artifact / "publication-preparation.json").is_file())
        self.assertFalse((artifact / "observer-manifest.json").exists())
        refused = controller.observe(self.observation(), now_ns=4_000_000_000)
        self.assertEqual(refused.state, self.observer.ObserverState.WAITING)
        self.assertEqual(refused.reason, "artifact_publication_refused")
        self.assertFalse(refused.completion_credit)

        censored = controller.observe(
            self.observation(), now_ns=self.observer.ARM_DEADLINE_NS + 2
        )
        self.assertEqual(censored.state, self.observer.ObserverState.CENSORED)
        self.assertEqual(censored.reason, "arm_deadline_elapsed;artifact_publication_refused")
        self.assertFalse(censored.completion_credit)
        self.assertEqual(censored.failed_artifact_dir, str(artifact))
        self.assertFalse((artifact / "observer-manifest.json").exists())

    def test_final_manifest_rename_failure_refuses_credit_and_preserves_pending_bytes(self):
        run_id = f"manifest-rename-{self.case_number}"
        controller = self.controller(run_id=run_id)
        controller.observe(self.observation(), now_ns=2_000_000_000)
        original_rename = Path.rename

        def fail_manifest_commit(path, target):
            if path.name == "observer-manifest.commit-pending.json":
                raise OSError("injected manifest commit failure")
            return original_rename(path, target)

        with mock.patch.object(Path, "rename", fail_manifest_commit):
            failed = controller.observe(self.observation(), now_ns=3_000_000_000)

        artifact = self.retained / run_id
        pending = artifact / "observer-manifest.commit-pending.json"
        self.assertEqual(failed.state, self.observer.ObserverState.WAITING)
        self.assertFalse(failed.completion_credit)
        self.assertTrue(pending.is_file())
        self.assertFalse((artifact / "observer-manifest.json").exists())
        pending_document = json.loads(pending.read_text(encoding="utf-8"))
        self.assertEqual(
            pending_document["publication"]["authoritative_only_at"],
            f"{run_id}/observer-manifest.json",
        )
        self.assertFalse(
            pending_document["publication"]["preparation_and_pending_files_authoritative"]
        )
        retained = pending.read_bytes()
        refused = controller.observe(self.observation(), now_ns=4_000_000_000)
        self.assertEqual(refused.reason, "artifact_publication_refused")
        self.assertEqual(pending.read_bytes(), retained)

    def test_late_root_mkdir_failure_reports_no_directory_then_retry_retains_once(self):
        controller = self.controller()
        controller.observe(self.observation(), now_ns=2_000_000_000)
        frozen = controller.observe(self.observation(), now_ns=3_000_000_000)
        artifact = Path(frozen.artifact_dir)
        manifest = artifact / "observer-manifest.json"
        scored = artifact / "scored-snapshot" / "answer.txt"
        manifest_before = hashlib.sha256(manifest.read_bytes()).hexdigest()
        scored_before = hashlib.sha256(scored.read_bytes()).hexdigest()
        (self.task / "answer.txt").write_text("late after mkdir failure\n", encoding="utf-8")
        late_root = artifact / "late-writes"
        original_mkdir = Path.mkdir

        def fail_late_root(path, *args, **kwargs):
            if path == late_root:
                raise OSError("injected late root mkdir failure")
            return original_mkdir(path, *args, **kwargs)

        try:
            with mock.patch.object(Path, "mkdir", fail_late_root):
                failed = controller.observe(self.observation(), now_ns=4_000_000_000)
        except OSError as error:
            self.fail(f"late-root creation failure escaped: {error}")
        self.assertEqual(failed.state, self.observer.ObserverState.FROZEN)
        self.assertTrue(failed.completion_credit)
        self.assertIsNone(failed.failed_artifact_dir)
        self.assertFalse(late_root.exists())
        self.assertEqual(hashlib.sha256(manifest.read_bytes()).hexdigest(), manifest_before)
        self.assertEqual(hashlib.sha256(scored.read_bytes()).hexdigest(), scored_before)
        (self.case / "preservation-hashes.json").write_text(
            json.dumps(
                {
                    "credited_manifest": {
                        "before_sha256": manifest_before,
                        "after_sha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
                    },
                    "scored_snapshot_answer": {
                        "before_sha256": scored_before,
                        "after_sha256": hashlib.sha256(scored.read_bytes()).hexdigest(),
                    },
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )

        retained = controller.observe(self.observation(), now_ns=5_000_000_000)
        self.assertEqual(retained.reason, "late_write_retained_separately")
        repeated = controller.observe(self.observation(), now_ns=6_000_000_000)
        self.assertEqual(repeated.reason, "late_snapshot_already_retained")
        self.assertEqual(repeated.late_artifact_dir, retained.late_artifact_dir)
        self.assertEqual(len(list(late_root.iterdir())), 1)

    def test_owned_event_driven_tool_and_delayed_wake_adapter_actuate_state(self):
        release_tool = threading.Event()
        tool_started = threading.Event()

        def owned_tool():
            tool_started.set()
            release_tool.wait(timeout=10)

        tool = threading.Thread(target=owned_tool, name=f"observer-owned-{self.case_number}")
        tool.start()
        self.assertTrue(tool_started.wait(timeout=2))
        delivered_wake = 3
        queued_wakes = [4]

        def adapted_observation():
            return self.observation(
                self.evidence(
                    self.alice,
                    latest_wake=delivered_wake,
                    final_wake=3,
                    active_tool=int(tool.is_alive()),
                ),
                self.evidence(self.bob),
                queued=len(queued_wakes),
            )

        controller = self.controller()
        active = controller.observe(adapted_observation(), now_ns=2_000_000_000)
        self.assertEqual(active.state, self.observer.ObserverState.WAITING)
        self.assertFalse(active.completion_credit)
        release_tool.set()
        tool.join(timeout=2)
        self.assertFalse(tool.is_alive())
        delivered_wake = queued_wakes.pop(0)
        delayed = controller.observe(adapted_observation(), now_ns=3_000_000_000)
        self.assertEqual(delayed.state, self.observer.ObserverState.WAITING)
        self.assertIn("final_before_latest_wake", delayed.reason)
        caught_up = self.observation(
            self.evidence(self.alice, latest_wake=4, final_wake=4), self.evidence(self.bob)
        )
        candidate = controller.observe(caught_up, now_ns=4_000_000_000)
        frozen = controller.observe(
            self.observation(
                self.evidence(self.alice, latest_wake=4, final_wake=4), self.evidence(self.bob)
            ),
            now_ns=5_000_000_000,
        )
        self.assertEqual(candidate.state, self.observer.ObserverState.CANDIDATE)
        self.assertEqual(frozen.state, self.observer.ObserverState.FROZEN)
        self.assertTrue(frozen.completion_credit)

    def test_symlink_or_reparse_in_task_tree_is_rejected_instead_of_followed(self):
        outside = self.case / "outside.txt"
        outside.write_text("must-not-copy", encoding="utf-8")
        link = self.task / "escape-link"
        try:
            os.symlink(outside, link)
        except OSError as error:
            self.skipTest(f"owned symlink creation unavailable: {error}")
        controller = self.controller()
        result = controller.observe(self.observation(), now_ns=2_000_000_000)
        self.assertEqual(result.state, self.observer.ObserverState.WAITING)
        self.assertEqual(result.reason, "task_tree_unavailable:reparse_or_symlink")
        self.assertFalse(result.completion_credit)

    def test_linked_root_or_ancestor_is_rejected_before_resolution(self):
        linked_root = self.case / "linked-task"
        try:
            os.symlink(self.task, linked_root, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"owned directory symlink creation unavailable: {error}")
        with self.assertRaises(ValueError):
            self.observer.CompletionObserver(
                expected_participants=(self.alice, self.bob),
                task_root=linked_root,
                retention_root=self.retained,
                run_id="linked-root",
                first_task_submission_ns=1_000_000_000,
            )

        ancestor_target = self.case / "ancestor-target"
        nested_task = ancestor_target / "nested-task"
        nested_task.mkdir(parents=True)
        (nested_task / "file.txt").write_text("owned", encoding="utf-8")
        linked_ancestor = self.case / "linked-ancestor"
        os.symlink(ancestor_target, linked_ancestor, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.observer.CompletionObserver(
                expected_participants=(self.alice, self.bob),
                task_root=linked_ancestor / "nested-task",
                retention_root=self.retained,
                run_id="linked-ancestor",
                first_task_submission_ns=1_000_000_000,
            )

    def test_owned_ancestor_swap_at_open_barrier_is_rejected_by_final_handle_path(self):
        self.assertTrue(hasattr(self.observer, "_open_entry"), "file-open barrier is missing")
        child = self.task / "child"
        child.mkdir()
        (child / "payload.txt").write_text("inside", encoding="utf-8")
        outside = self.case / "outside-directory"
        outside.mkdir()
        (outside / "payload.txt").write_text("outside", encoding="utf-8")
        preserved = self.case / "preserved-child"
        original_open = self.observer._open_entry
        swapped = False

        def swap_ancestor_then_open(path):
            nonlocal swapped
            if not swapped and path.name == "payload.txt":
                swapped = True
                child.rename(preserved)
                os.symlink(outside, child, target_is_directory=True)
            return original_open(path)

        controller = self.controller()
        with mock.patch.object(self.observer, "_open_entry", side_effect=swap_ancestor_then_open):
            result = controller.observe(self.observation(), now_ns=2_000_000_000)
        self.assertTrue(swapped)
        self.assertEqual(result.state, self.observer.ObserverState.WAITING)
        self.assertEqual(result.reason, "task_tree_unavailable:path_escape")

    def test_empty_directory_work_is_bounded_before_unbounded_descent(self):
        for index in range(3):
            (self.task / f"empty-{index}").mkdir()
        controller = self.controller()
        with mock.patch.object(self.observer, "MAX_DIRECTORIES", 2):
            result = controller.observe(self.observation(), now_ns=2_000_000_000)
        self.assertEqual(result.state, self.observer.ObserverState.WAITING)
        self.assertEqual(result.reason, "task_tree_unavailable:too_many_directories")

    def test_mutation_during_snapshot_is_rejected_as_unstable(self):
        controller = self.controller()
        original = self.observer._read_entry
        mutated = False

        def mutate_after_read(path, expected, root):
            nonlocal mutated
            result = original(path, expected, root)
            if not mutated and path.name == "answer.txt":
                mutated = True
                (self.task / "arrived.txt").write_text("during-snapshot", encoding="utf-8")
            return result

        with mock.patch.object(self.observer, "_read_entry", side_effect=mutate_after_read):
            result = controller.observe(self.observation(), now_ns=2_000_000_000)
        self.assertTrue(mutated)
        self.assertEqual(result.state, self.observer.ObserverState.WAITING)
        self.assertEqual(result.reason, "task_tree_unavailable:unstable_tree")
        self.assertFalse(result.completion_credit)

    def test_invalid_counts_revisions_and_retention_inside_task_are_rejected(self):
        with self.assertRaises(ValueError):
            self.evidence(self.alice, active_tool=-1)
        with self.assertRaises(ValueError):
            self.evidence(self.alice, final_task=11)
        with self.assertRaises(ValueError):
            self.observer.CompletionObserver(
                expected_participants=(self.alice,),
                task_root=self.task,
                retention_root=self.task / "artifacts",
                run_id="escape/attempt",
                first_task_submission_ns=1,
            )
        claimed = self.retained / "claimed"
        claimed.mkdir()
        with self.assertRaises(FileExistsError):
            self.observer.CompletionObserver(
                expected_participants=(self.alice,),
                task_root=self.task,
                retention_root=self.retained,
                run_id="claimed",
                first_task_submission_ns=1,
            )

    def test_valid_run_id_with_existing_nested_roots_is_rejected_for_overlap(self):
        nested_retention = self.task / "existing-retention"
        nested_retention.mkdir()
        with self.assertRaisesRegex(ValueError, "must not overlap"):
            self.observer.CompletionObserver(
                expected_participants=(self.alice,),
                task_root=self.task,
                retention_root=nested_retention,
                run_id="valid-overlap",
                first_task_submission_ns=1,
            )


if __name__ == "__main__":
    unittest.main()
