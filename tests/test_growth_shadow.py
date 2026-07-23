import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shorts_generator.growth_shadow import (
    run_growth_v2_shadow,
    validate_shadow_manifest,
)
from shorts_generator.highlights import (
    IncompleteHighlightBatchError,
    get_highlights,
)
from shorts_generator.profiles import (
    MOTIVATIONAL_PODCAST,
    MOTIVATIONAL_TENSION_MICRO_V2,
)


def _transcript():
    words = [
        {"start": 0.0, "end": 0.3, "word": "Do"},
        {"start": 0.3, "end": 0.8, "word": "less"},
        {"start": 0.8, "end": 1.1, "word": "than"},
        {"start": 1.1, "end": 1.4, "word": "you"},
        {"start": 1.4, "end": 1.8, "word": "think."},
        {"start": 5.0, "end": 5.5, "word": "Small"},
        {"start": 5.5, "end": 6.0, "word": "steps"},
        {"start": 6.0, "end": 6.6, "word": "protect"},
        {"start": 6.6, "end": 7.0, "word": "discipline."},
        {"start": 12.0, "end": 12.5, "word": "That"},
        {"start": 12.5, "end": 13.0, "word": "makes"},
        {"start": 13.0, "end": 13.7, "word": "consistency"},
        {"start": 13.7, "end": 14.4, "word": "sustainable."},
    ]
    return {
        "duration": 18.0,
        "segments": [
            {
                "start": 0.0,
                "end": 14.4,
                "text": (
                    "Do less than you think. Small steps protect discipline. "
                    "That makes consistency sustainable."
                ),
                "words": words,
            }
        ],
    }


def _candidate(selected=False):
    return {
        "title": "Do less to stay consistent",
        "topic": "consistency",
        "start_time": 0.0,
        "end_time": 14.4,
        "speech_start_time": 0.0,
        "speech_end_time": 14.4,
        "score": 94,
        "hook_sentence": "Do less than you think.",
        "hook_payoff_phrase": "Do less",
        "earliest_complete_takeaway_sentence": (
            "That makes consistency sustainable."
        ),
        "semantic_closure_sentence": (
            "That makes consistency sustainable."
        ),
        "opening_exact_quote": "Do less than you",
        "hook_signal_phrase": "Do less",
        "hook_family": "contradiction",
        "new_viewer_understands_opening": True,
        "opens_with_context_connector": False,
        "contains_external_antecedent": False,
        "contains_host_setup": False,
        "first_second_value_score": 92,
        "specificity_score": 92,
        "relatability_score": 90,
        "stop_scroll_score": 94,
        "hook_gate_recommendation": "pass",
        "hook_gate_reasons": [
            "self_contained",
            "clear_contradiction",
        ],
        "hook_gate_response_complete": True,
        "has_hook": True,
        "hook_score": 94,
        "has_development": True,
        "development_score": 90,
        "has_takeaway": True,
        "takeaway_score": 94,
        "listener_payoff_score": 94,
        "self_contained_micro_arc_score": 94,
        "closure_score": 94,
        "has_complete_ending": True,
        "has_semantic_tension": True,
        "semantic_tension_score": 94,
        "generic_motivation_score": 5,
        "context_dependence_score": 5,
        "second_topic_begins_after_takeaway": False,
        "contains_attribution_lead_in": False,
        "contains_context_callback": False,
        "selected_for_render": selected,
        "rejected": False,
    }


class GrowthShadowTests(unittest.TestCase):
    def _fixture(self, root):
        artifact = root / "source.json"
        artifact.write_text(
            json.dumps(
                {
                    "transcript": _transcript(),
                    "candidates": [_candidate(selected=True)],
                }
            ),
            encoding="utf-8",
        )
        manifest = {
            "datasets": [
                {
                    "id": "fixture",
                    "source_id": "source-id",
                    "candidate_path": str(artifact),
                    "candidate_key": "candidates",
                    "transcript_path": str(artifact),
                    "transcript_key": "transcript",
                    "positive_path": str(artifact),
                    "positive_key": "candidates",
                }
            ]
        }
        return artifact, manifest

    def test_shadow_run_counts_calls_and_never_renders_or_uploads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, manifest = self._fixture(root)

            def fake_discovery(transcript, llm_fn, **kwargs):
                llm_fn("fresh-hook-gate-prompt")
                self.assertTrue(kwargs["allow_incomplete_batch"])
                self.assertEqual(
                    kwargs["selection_profile"],
                    MOTIVATIONAL_TENSION_MICRO_V2,
                )
                return {
                    "content_info": {
                        "content_type": MOTIVATIONAL_PODCAST,
                    },
                    "highlights": [_candidate()],
                    "batch_decision": {
                        "target_count": 1,
                        "eligible_count": 1,
                        "selected_count": 1,
                        "complete": True,
                    },
                }

            result = run_growth_v2_shadow(
                manifest,
                root=root,
                output_dir=root / "shadow",
                llm_fn=lambda prompt: '{"highlights":[]}',
                top_k=1,
                discovery_fn=fake_discovery,
            )
            candidate_artifact = json.loads(
                (root / "shadow/candidates/fixture.json").read_text(
                    encoding="utf-8"
                )
            )
            review_queue = json.loads(
                (root / "shadow/human-review-queue.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(result["execution"]["llmCalls"], 1)
        self.assertEqual(result["execution"]["renders"], 0)
        self.assertEqual(result["execution"]["uploads"], 0)
        self.assertEqual(result["execution"]["productionPolicyMutations"], 0)
        self.assertEqual(result["sourceErrorCount"], 0)
        self.assertEqual(
            candidate_artifact["hookEvidence"]["coverage"],
            1.0,
        )
        self.assertEqual(
            result["aggregate"]["hook_prompt_evidence_coverage"],
            1.0,
        )
        self.assertEqual(result["humanReviewItemCount"], 1)
        self.assertEqual(
            review_queue["items"][0]["priority"],
            "full_v2_eligible",
        )
        self.assertIsNone(
            review_queue["items"][0]["humanDecision"]
        )

    def test_manifest_filter_fails_on_unknown_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, manifest = self._fixture(root)
            with self.assertRaisesRegex(ValueError, "absent from manifest"):
                validate_shadow_manifest(
                    manifest,
                    root,
                    source_ids=["missing"],
                )

    @patch(
        "shorts_generator.highlights.call_highlight_api",
        return_value={"highlights": []},
    )
    def test_incomplete_batch_is_returned_only_for_shadow_mode(self, _call):
        transcript = _transcript()
        result = get_highlights(
            transcript,
            num_clips=3,
            profile_override=MOTIVATIONAL_PODCAST,
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V2,
            allow_incomplete_batch=True,
        )

        self.assertEqual(result["highlights"], [])
        self.assertFalse(result["batch_decision"]["complete"])
        self.assertEqual(result["batch_decision"]["selected_count"], 0)

        with self.assertRaises(IncompleteHighlightBatchError):
            get_highlights(
                transcript,
                num_clips=3,
                profile_override=MOTIVATIONAL_PODCAST,
                selection_profile=MOTIVATIONAL_TENSION_MICRO_V2,
            )


if __name__ == "__main__":
    unittest.main()
