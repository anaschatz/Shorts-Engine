import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from shorts_generator.control_plane import (
    CONTROL_BINDING_ENV,
    CONTROL_INPUT_HASH_ENV,
    CONTROL_INPUT_PATH_ENV,
    ControlPlaneBindingError,
    bind_control_plane_result,
)
from shorts_generator.artifact_contracts import (
    build_candidate_decision,
    candidate_hash,
)


def _hash(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


class ControlPlaneBindingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.source = Path(self.temp.name) / "source.mp4"
        self.source.write_bytes(b"approved source")
        self.source_hash = _hash(b"approved source")
        self.result = {
            "mode": "local",
            "profiles": {
                "content_profile": "motivational_podcast",
                "selection_profile": "motivational_tension_micro_v1",
                "render_profile": "bf_editorial_inset_v1",
                "format_profile": "bf_viral_micro_v1",
            },
            "source_video_url": str(self.source.resolve()),
            "shorts": [{"candidate_hash": "d" * 64}],
        }
        self.control_input = Path(self.temp.name) / "control.json"
        request = {
            "schemaVersion": 1,
            "candidateDecision": {
                "artifactType": "CandidateDecision",
                "contentHash": "c" * 64,
                "candidateHash": "d" * 64,
                "sourceHash": self.source_hash,
                "selectionProfile": "motivational_tension_micro_v1",
                "decision": "approved",
            },
            "experimentManifest": {
                "artifactType": "ExperimentManifest",
                "contentHash": "e" * 64,
                "candidateDecisionHash": "c" * 64,
                "candidateHash": "d" * 64,
                "formatProfile": "bf_viral_micro_v1",
                "selectionProfile": "motivational_tension_micro_v1",
                "renderProfile": "bf_editorial_inset_v1",
            },
            "transcriptManifest": {
                "artifactType": "TranscriptManifest",
                "contentHash": "f" * 64,
                "sourceHash": self.source_hash,
                "transcript": {"duration": 12, "segments": []},
            },
        }
        self.control_bytes = (json.dumps(request, separators=(",", ":")) + "\n").encode()
        self.control_input.write_bytes(self.control_bytes)
        self.env = {
            CONTROL_BINDING_ENV["source_hash"]: self.source_hash,
            CONTROL_BINDING_ENV["rights_manifest_hash"]: "b" * 64,
            CONTROL_BINDING_ENV["candidate_decision_hash"]: "c" * 64,
            CONTROL_BINDING_ENV["candidate_hash"]: "d" * 64,
            CONTROL_BINDING_ENV["experiment_manifest_hash"]: "e" * 64,
            CONTROL_BINDING_ENV["transcript_manifest_hash"]: "f" * 64,
            CONTROL_INPUT_PATH_ENV: str(self.control_input.resolve()),
            CONTROL_INPUT_HASH_ENV: _hash(self.control_bytes),
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_no_control_environment_preserves_standalone_result(self):
        bound = bind_control_plane_result(self.result, {})
        self.assertEqual(bound, self.result)
        self.assertNotIn("control_plane_bindings", bound)

    def test_complete_contract_echoes_verified_snake_case_bindings(self):
        bound = bind_control_plane_result(self.result, self.env)
        self.assertEqual(
            bound["control_plane_bindings"],
            {
                "source_hash": self.source_hash,
                "rights_manifest_hash": "b" * 64,
                "candidate_decision_hash": "c" * 64,
                "candidate_hash": "d" * 64,
                "experiment_manifest_hash": "e" * 64,
                "transcript_manifest_hash": "f" * 64,
            },
        )

    def test_partial_or_invalid_bindings_fail_closed(self):
        with self.assertRaises(ControlPlaneBindingError):
            bind_control_plane_result(
                self.result,
                {CONTROL_BINDING_ENV["source_hash"]: self.source_hash},
            )
        invalid = dict(self.env)
        invalid[CONTROL_BINDING_ENV["rights_manifest_hash"]] = "not-a-hash"
        with self.assertRaises(ControlPlaneBindingError):
            bind_control_plane_result(self.result, invalid)

    def test_profile_drift_or_changed_source_fails_closed(self):
        drifted = {
            **self.result,
            "profiles": {**self.result["profiles"], "render_profile": "budget_friendly_v2"},
        }
        with self.assertRaises(ControlPlaneBindingError):
            bind_control_plane_result(drifted, self.env)
        self.source.write_bytes(b"changed after approval")
        with self.assertRaises(ControlPlaneBindingError):
            bind_control_plane_result(self.result, self.env)

    def test_existing_or_nonlocal_bindings_cannot_be_spoofed(self):
        with self.assertRaises(ControlPlaneBindingError):
            bind_control_plane_result(
                {**self.result, "control_plane_bindings": {}},
                self.env,
            )
        with self.assertRaises(ControlPlaneBindingError):
            bind_control_plane_result({**self.result, "mode": "api"}, self.env)

    def test_tampered_control_input_or_reselected_candidate_fails_closed(self):
        self.control_input.write_text("{}", encoding="utf-8")
        with self.assertRaises(ControlPlaneBindingError):
            bind_control_plane_result(self.result, self.env)
        self.control_input.write_bytes(self.control_bytes)
        reselected = {
            **self.result,
            "shorts": [{"candidate_hash": "9" * 64}],
        }
        with self.assertRaises(ControlPlaneBindingError):
            bind_control_plane_result(reselected, self.env)

    def test_stamped_ranking_candidate_keeps_its_original_approval_hash(self):
        candidate = {
            "start_time": 2.0,
            "end_time": 13.0,
            "hook_sentence": "You do not need more time.",
            "final_takeaway_sentence": "You need a clear decision.",
            "content_profile": "motivational_podcast",
            "selection_profile": "motivational_tension_micro_v1",
            "render_profile": "bf_editorial_inset_v1",
            "format_profile": "bf_viral_micro_v1",
            "rejected": False,
            "rejection_reasons": [],
        }
        stamp = candidate_hash(candidate, self.source_hash)
        selected_ranking_record = {
            **candidate,
            "candidate_hash": stamp,
            "selection_rank": 1,
            "selected_for_render": True,
            "output_rank": 1,
            "batch_exclusion_reason": "not_approved_candidate",
            "shot_index_cache_path": "/different-machine/output/shot-cache.json",
        }
        decision = build_candidate_decision(
            selected_ranking_record,
            self.source_hash,
            reviewer="editor_operator",
            decided_at="2026-07-17T10:00:00.000Z",
            ranking_manifest_hash="d" * 64,
        )
        self.assertEqual(decision["candidateHash"], stamp)


if __name__ == "__main__":
    unittest.main()
