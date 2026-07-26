import json
import tempfile
import unittest
from pathlib import Path

from shorts_generator.growth_replay import (
    build_growth_replay_report,
    load_replay_dataset,
)


def _transcript():
    tokens = [
        "Pressure",
        "creates",
        "bad",
        "decisions.",
        "Small",
        "steps",
        "protect",
        "your",
        "discipline.",
        "That",
        "is",
        "how",
        "consistency",
        "becomes",
        "sustainable.",
    ]
    words = []
    for index, token in enumerate(tokens):
        words.append(
            {
                "start": round(index * 1.05, 3),
                "end": round((index + 1) * 1.05, 3),
                "word": token,
            }
        )
    return {
        "duration": 18.0,
        "segments": [
            {
                "start": 0.0,
                "end": 15.75,
                "text": " ".join(tokens),
                "words": words,
            }
        ],
    }


def _candidate(title, selected=False):
    return {
        "title": title,
        "topic": title,
        "start_time": 0.0,
        "end_time": 15.75,
        "speech_start_time": 0.0,
        "speech_end_time": 15.75,
        "score": 92,
        "hook_sentence": "Pressure creates bad decisions.",
        "hook_payoff_phrase": "Pressure creates bad decisions",
        "earliest_complete_takeaway_sentence": (
            "That is how consistency becomes sustainable."
        ),
        "semantic_closure_sentence": (
            "That is how consistency becomes sustainable."
        ),
        "has_hook": True,
        "hook_score": 92,
        "has_complete_ending": True,
        "has_takeaway": True,
        "takeaway_score": 92,
        "listener_payoff_score": 92,
        "self_contained_micro_arc_score": 92,
        "closure_score": 92,
        "has_semantic_tension": True,
        "semantic_tension_score": 92,
        "generic_motivation_score": 5,
        "context_dependence_score": 5,
        "stop_scroll_score": 92,
        "selected_for_render": selected,
        "rejected": False,
    }


class GrowthReplayTests(unittest.TestCase):
    def _write_fixture(self, root, candidates):
        artifact = {
            "candidates": candidates,
            "transcript": _transcript(),
        }
        path = root / "artifact.json"
        path.write_text(json.dumps(artifact), encoding="utf-8")
        return path

    def test_explicit_positive_artifact_filters_to_selected_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self._write_fixture(
                root,
                [
                    _candidate("Human choice", selected=True),
                    _candidate("Not selected"),
                ],
            )
            dataset = load_replay_dataset(
                {
                    "id": "fixture",
                    "candidate_path": str(path),
                    "candidate_key": "candidates",
                    "transcript_path": str(path),
                    "transcript_key": "transcript",
                    "positive_path": str(path),
                    "positive_key": "candidates",
                },
                root,
            )

        positives = [
            item
            for item in dataset["candidates"]
            if item["_replay_human_positive"]
        ]
        self.assertEqual([item["title"] for item in positives], ["Human choice"])

    def test_legacy_replay_never_synthesizes_hook_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self._write_fixture(
                root,
                [_candidate("Human choice", selected=True)],
            )
            manifest = {
                "datasets": [
                    {
                        "id": "fixture",
                        "source_id": "source",
                        "candidate_path": str(path),
                        "candidate_key": "candidates",
                        "transcript_path": str(path),
                        "transcript_key": "transcript",
                        "positive_path": str(path),
                        "positive_key": "candidates",
                    }
                ]
            }
            first = build_growth_replay_report(manifest, root)
            second = build_growth_replay_report(manifest, root)

        self.assertEqual(first["contentHash"], second["contentHash"])
        self.assertEqual(
            first["aggregate"]["hook_prompt_evidence_coverage"],
            0.0,
        )
        self.assertFalse(first["productionApprovalRecommended"])
        self.assertEqual(first["llmCalls"], 0)
        self.assertEqual(first["renders"], 0)
        record = first["datasets"][0]["candidates"][0]
        self.assertFalse(record["hook_gate"]["evidence_complete"])
        self.assertEqual(record["hook_gate"]["status"], "not_evaluable")
        self.assertEqual(
            record["hook_gate"]["reasons"],
            ["legacy_hook_prompt_evidence_missing"],
        )
        self.assertFalse(record["full_v2"]["eligible"])

    def test_positive_artifact_without_labels_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self._write_fixture(
                root,
                [_candidate("Unlabeled candidate")],
            )
            with self.assertRaisesRegex(
                ValueError,
                "no explicit selected positives",
            ):
                load_replay_dataset(
                    {
                        "id": "fixture",
                        "candidate_path": str(path),
                        "candidate_key": "candidates",
                        "transcript_path": str(path),
                        "transcript_key": "transcript",
                        "positive_path": str(path),
                        "positive_key": "candidates",
                    },
                    root,
                )

    def test_shadow_mode_counts_undiscovered_positive_as_false_negative(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate_path = self._write_fixture(
                root,
                [_candidate("Different interval")],
            )
            positive_path = root / "positives.json"
            positive = _candidate("Expected human choice", selected=True)
            positive.update(
                {
                    "start_time": 40.0,
                    "end_time": 56.0,
                    "speech_start_time": 40.0,
                    "speech_end_time": 56.0,
                }
            )
            positive_path.write_text(
                json.dumps({"candidates": [positive]}),
                encoding="utf-8",
            )
            manifest = {
                "datasets": [
                    {
                        "id": "fixture",
                        "source_id": "source",
                        "candidate_path": str(candidate_path),
                        "candidate_key": "candidates",
                        "transcript_path": str(candidate_path),
                        "transcript_key": "transcript",
                        "positive_path": str(positive_path),
                        "positive_key": "candidates",
                        "append_unmatched_positives": False,
                    }
                ]
            }
            report = build_growth_replay_report(manifest, root)

        metrics = report["datasets"][0]["metrics"]
        self.assertEqual(metrics["candidate_count"], 1)
        self.assertEqual(metrics["human_positive_count"], 1)
        self.assertEqual(metrics["human_positive_matched_count"], 0)
        self.assertEqual(metrics["human_positive_unmatched_count"], 1)
        self.assertEqual(metrics["human_positive_match_coverage"], 0.0)
        self.assertEqual(
            report["datasets"][0]["potential_false_negatives"][0]["status"],
            "not_discovered",
        )


if __name__ == "__main__":
    unittest.main()
