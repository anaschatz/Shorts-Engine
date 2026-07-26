import unittest
from types import SimpleNamespace

from shorts_generator.local.visual_features import analyze_rendered_cut_metrics


def runner_with_scene_times(*times):
    lines = "\n".join(f"showinfo pts_time:{value}" for value in times)

    def runner(*_args, **_kwargs):
        return SimpleNamespace(returncode=0, stderr=lines, stdout="")

    return runner


def editorial_short():
    return {
        "clip_url": "/tmp/synthetic.mp4",
        "start_time": 100.0,
        "end_time": 111.0,
        "duration_seconds": 11.0,
        "source_cut_count": 1,
        "source_scene_change_times": [101.0],
        "render_profile": "bf_editorial_inset_v1",
        "artificial_cut_limit": 0,
        "brand_tail_seconds": 0.3,
        "brand_tail_start_seconds": 10.7,
        "declared_render_events": [
            {"type": "brand_tail", "start_seconds": 10.7, "end_seconds": 11.0}
        ],
    }


class EditorialCutQaTests(unittest.TestCase):
    def test_declared_brand_tail_does_not_count_as_artificial_edit(self):
        measured = analyze_rendered_cut_metrics(
            [editorial_short()],
            runner=runner_with_scene_times(1.0, 10.7),
        )[0]

        self.assertEqual(measured["output_cut_count"], 2)
        self.assertEqual(measured["artificial_cut_count"], 0)
        self.assertTrue(measured["brand_tail_transition_detected"])
        self.assertTrue(measured["artificial_cut_guardrail_pass"])

    def test_extra_undeclared_cut_still_fails_zero_cut_profile(self):
        measured = analyze_rendered_cut_metrics(
            [editorial_short()],
            runner=runner_with_scene_times(1.0, 5.0, 10.7),
        )[0]

        self.assertEqual(measured["artificial_cut_count"], 1)
        self.assertFalse(measured["artificial_cut_guardrail_pass"])


if __name__ == "__main__":
    unittest.main()
