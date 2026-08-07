import ast
import unittest
from unittest.mock import patch

import numpy as np

import shorts_generator.local.caption_render_planning as caption_planning
from shorts_generator.local.clipper import (
    BF_EDITORIAL_INSET_V1,
    BUDGET_FRIENDLY_CAPTION_STYLE,
    _CaptionRenderer,
    _editorial_kinetic_state,
)


class CaptionRenderPlanningCharacterizationTests(unittest.TestCase):
    def test_legacy_active_selection_preserves_inclusive_start_exclusive_end(self):
        first = {"start": 0.0, "end": 1.0, "words": ["first"]}
        second = {"start": 2.0, "end": 3.0, "words": ["second"]}
        cues = [first, second]

        at_start = caption_planning.select_active_caption_cues(
            cues,
            0.0,
            persistent_editorial=False,
            start_index=0,
        )
        at_end = caption_planning.select_active_caption_cues(
            cues,
            1.0,
            persistent_editorial=False,
            start_index=0,
        )
        at_second = caption_planning.select_active_caption_cues(
            cues,
            2.0,
            persistent_editorial=False,
            start_index=at_end.next_index,
        )
        after_all = caption_planning.select_active_caption_cues(
            cues,
            3.0,
            persistent_editorial=False,
            start_index=at_second.next_index,
        )

        self.assertEqual(at_start.cues, (first,))
        self.assertEqual((at_start.next_index, at_end.next_index), (0, 1))
        self.assertEqual(at_end.cues, ())
        self.assertEqual(at_second.cues, (second,))
        self.assertEqual(after_all, caption_planning.ActiveCaptionSelection((), 2))

    def test_legacy_selection_does_not_search_past_a_future_unsorted_cue(self):
        future = {"start": 5.0, "end": 6.0}
        currently_active = {"start": 0.0, "end": 10.0}
        selection = caption_planning.select_active_caption_cues(
            [future, currently_active],
            1.0,
            persistent_editorial=False,
            start_index=0,
        )
        self.assertEqual(selection.cues, ())
        self.assertEqual(selection.next_index, 0)

    def test_persistent_selection_deduplicates_tracks_and_keeps_latest_two(self):
        replaced = {
            "start": 0.0,
            "end": 10.0,
            "sentence_id": 1,
            "caption_track_slot": 0,
            "sentence_phrase_index": 0,
            "phrase_id": 0,
        }
        newest_same_track = {
            "start": 1.0,
            "end": 10.0,
            "sentence_id": 1,
            "caption_track_slot": 0,
            "sentence_phrase_index": 1,
            "phrase_id": 1,
        }
        second_track = {
            "start": 2.0,
            "end": 10.0,
            "sentence_id": 1,
            "caption_track_slot": 1,
            "sentence_phrase_index": 2,
            "phrase_id": 2,
        }
        newest_other_sentence = {
            "start": 3.0,
            "end": 10.0,
            "sentence_id": 2,
            "caption_track_slot": 0,
            "sentence_phrase_index": 3,
            "phrase_id": 3,
        }
        cues = [
            newest_other_sentence,
            replaced,
            second_track,
            newest_same_track,
        ]
        original = [dict(cue) for cue in cues]

        selection = caption_planning.select_active_caption_cues(
            cues,
            4.0,
            persistent_editorial=True,
            start_index=7,
        )

        self.assertEqual(
            selection.cues,
            (second_track, newest_other_sentence),
        )
        self.assertEqual(selection.next_index, 7)
        self.assertEqual(cues, original)
        with self.assertRaises(AttributeError):
            selection.next_index = 8

    def test_persistent_selection_defaults_share_one_track_and_preserve_errors(self):
        older = {"start": 0.0, "end": 2.0}
        newer = {"start": 1.0, "end": 2.0}
        selection = caption_planning.select_active_caption_cues(
            [older, newer],
            1.5,
            persistent_editorial=True,
            start_index=0,
        )
        self.assertEqual(selection.cues, (newer,))

        with self.assertRaisesRegex(KeyError, "start"):
            caption_planning.select_active_caption_cues(
                [{"end": 1.0}],
                0.0,
                persistent_editorial=True,
                start_index=0,
            )
        with self.assertRaisesRegex(
            ValueError,
            "could not convert string to float: 'bad'",
        ):
            caption_planning.select_active_caption_cues(
                [{"start": 0.0, "end": "bad"}],
                0.0,
                persistent_editorial=False,
                start_index=0,
            )

    def test_kinetic_state_has_exact_entry_midpoint_and_exit_values(self):
        cue = {
            "start": 1.0,
            "end": 2.0,
            "phrase_start": 1.0,
            "words": ["one", "two"],
            "visible_word_count": 2,
        }

        self.assertEqual(
            _editorial_kinetic_state(cue, 1.0),
            {
                "progress": 0.0,
                "exit_progress": 1.0,
                "opacity": 0.35,
                "scale": 0.98,
                "mask_reveal": 1.0,
            },
        )
        self.assertEqual(
            _editorial_kinetic_state(cue, 1.06),
            {
                "progress": 0.5000000000000004,
                "exit_progress": 1.0,
                "opacity": 0.6750000000000005,
                "scale": 0.99,
                "mask_reveal": 1.0,
            },
        )
        self.assertEqual(
            _editorial_kinetic_state(cue, 1.94),
            {
                "progress": 1.0,
                "exit_progress": 0.5000000000000004,
                "opacity": 0.5000000000000007,
                "scale": 1.0,
                "mask_reveal": 1.0,
            },
        )
        self.assertEqual(
            _editorial_kinetic_state(cue, 2.0),
            {
                "progress": 1.0,
                "exit_progress": 0.0,
                "opacity": 0.0,
                "scale": 1.0,
                "mask_reveal": 1.0,
            },
        )

    def test_incomplete_phrase_does_not_enter_exit_fade(self):
        cue = {
            "start": 1.0,
            "end": 2.0,
            "words": ["one", "two"],
            "visible_word_count": 1,
        }
        self.assertEqual(
            _editorial_kinetic_state(cue, 2.0)["exit_progress"],
            1.0,
        )

    def test_kinetic_state_preserves_numeric_conversion_errors(self):
        with self.assertRaisesRegex(
            ValueError,
            "could not convert string to float: 'bad'",
        ):
            _editorial_kinetic_state({"phrase_start": "bad"}, 0.0)
        with self.assertRaisesRegex(
            ValueError,
            r"invalid literal for int\(\) with base 10: 'bad'",
        ):
            _editorial_kinetic_state(
                {"words": ["one"], "visible_word_count": "bad"},
                0.0,
            )

    def test_editorial_dict_cue_is_normalized_before_drawing(self):
        renderer = _CaptionRenderer(
            frame_width=320,
            frame_height=480,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
            render_profile=BF_EDITORIAL_INSET_V1,
        )
        frame = np.zeros((480, 320, 3), dtype=np.uint8)
        cue = {
            "words": [" first ", "", "second"],
            "active_index": "1",
            "emphasis_index": "2",
            "visible_word_count": "99",
            "phrase_id": "7",
            "sentence_id": "4",
            "sentence_phrase_index": "2",
            "sentence_phrase_count": "0",
            "caption_track_progress": "0.6",
            "typography_variant": "hero",
            "typography_base_scale": "1.5",
            "typography_anchor_scale": "1.4",
            "typography_accent_style": "script",
            "typography_body_style": "support",
            "typography_secondary_index": "1",
            "typography_secondary_scale": "0.7",
            "typography_secondary_style": "serif",
            "start": 1.0,
            "end": 2.0,
            "phrase_start": 1.0,
            "_render_elapsed": 1.12,
        }

        with patch.object(renderer, "_draw_editorial") as draw_editorial:
            output = renderer.draw(frame, cue)

        self.assertEqual(output.shape, frame.shape)
        arguments = draw_editorial.call_args.args
        self.assertEqual(arguments[2], ["first", "second"])
        self.assertEqual(arguments[3], 2)
        self.assertEqual(arguments[4], {
            "variant": "hero",
            "base_scale": 1.5,
            "anchor_scale": 1.4,
            "accent_style": "script",
            "body_style": "support",
            "secondary_index": 1,
            "secondary_scale": 0.7,
            "secondary_style": "serif",
        })
        self.assertEqual(arguments[5:11], (3, 7, 4, 2, 1, 0.6))
        self.assertEqual(
            renderer.last_kinetic_state,
            _editorial_kinetic_state(cue, 1.12),
        )

    def test_editorial_defaults_and_kinetic_scale_are_exact(self):
        renderer = _CaptionRenderer(
            frame_width=320,
            frame_height=480,
            render_profile=BF_EDITORIAL_INSET_V1,
        )
        frame = np.zeros((480, 320, 3), dtype=np.uint8)
        cue = {
            "words": ["one", "two"],
            "start": 1.0,
            "end": 2.0,
            "_render_elapsed": 1.0,
        }

        with patch.object(renderer, "_draw_editorial") as draw_editorial:
            renderer.draw(frame, cue)

        typography = draw_editorial.call_args.args[4]
        self.assertEqual(
            typography,
            {
                "variant": "statement",
                "base_scale": 0.98,
                "anchor_scale": 1.2,
                "accent_style": "serif",
                "body_style": "support",
                "secondary_index": -1,
                "secondary_scale": 0.78,
                "secondary_style": "base",
            },
        )

    def test_non_bf_editorial_style_has_no_kinetic_state(self):
        renderer = _CaptionRenderer(
            frame_width=320,
            frame_height=480,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )
        frame = np.zeros((480, 320, 3), dtype=np.uint8)
        cue = {"words": ["one"], "start": 1.0, "end": 2.0}

        with patch.object(renderer, "_draw_editorial"):
            renderer.draw(frame, cue)

        self.assertIsNone(renderer.last_kinetic_state)

    def test_plain_string_fallback_uppercases_for_legacy_renderer(self):
        renderer = _CaptionRenderer(frame_width=320, frame_height=480)
        frame = np.zeros((480, 320, 3), dtype=np.uint8)

        with patch.object(renderer, "_layout", wraps=renderer._layout) as layout:
            renderer.draw(frame, "  mixed Case  ")

        self.assertEqual(layout.call_args.args[1], ["MIXED", "CASE"])

    def test_empty_words_return_the_original_frame_without_drawing(self):
        renderer = _CaptionRenderer(
            frame_width=320,
            frame_height=480,
            render_profile=BF_EDITORIAL_INSET_V1,
        )
        frame = np.zeros((480, 320, 3), dtype=np.uint8)

        with patch.object(renderer, "_draw_editorial") as draw_editorial:
            output = renderer.draw(frame, {"words": ["", "  "]})

        self.assertIs(output, frame)
        draw_editorial.assert_not_called()
        self.assertIsNone(renderer.last_kinetic_state)

    def test_renderer_preserves_exact_conversion_errors(self):
        renderer = _CaptionRenderer(
            frame_width=320,
            frame_height=480,
            render_profile=BF_EDITORIAL_INSET_V1,
        )
        frame = np.zeros((480, 320, 3), dtype=np.uint8)

        with self.assertRaisesRegex(
            ValueError,
            r"invalid literal for int\(\) with base 10: 'bad'",
        ):
            renderer.draw(frame, {"words": ["one"], "active_index": "bad"})

    def test_kinetic_wrapper_remains_a_renderer_patch_point(self):
        renderer = _CaptionRenderer(
            frame_width=320,
            frame_height=480,
            render_profile=BF_EDITORIAL_INSET_V1,
        )
        frame = np.zeros((480, 320, 3), dtype=np.uint8)
        cue = {"words": ["one"], "start": 4.5, "end": 5.0}
        patched_state = {
            "progress": 0.1,
            "exit_progress": 0.2,
            "opacity": 0.3,
            "scale": 2.0,
            "mask_reveal": 1.0,
        }

        with (
            patch(
                "shorts_generator.local.clipper._editorial_kinetic_state",
                return_value=patched_state,
            ) as kinetic,
            patch.object(renderer, "_draw_editorial") as draw_editorial,
        ):
            renderer.draw(frame, cue)

        kinetic.assert_called_once_with(cue, 4.5)
        self.assertIs(renderer.last_kinetic_state, patched_state)
        self.assertEqual(draw_editorial.call_args.args[4]["base_scale"], 2.0)

    def test_planner_is_a_standard_library_leaf_and_clipper_remains_facade(self):
        source_path = caption_planning.__file__
        with open(source_path, encoding="utf-8") as source_file:
            tree = ast.parse(source_file.read())
        imports = {
            alias.name.split(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        } | {
            node.module.split(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module
        }
        self.assertEqual(imports, {"typing"})

        from shorts_generator.local import clipper

        self.assertTrue(callable(clipper._editorial_kinetic_state))
        self.assertEqual(clipper._CaptionRenderer.__module__, clipper.__name__)


if __name__ == "__main__":
    unittest.main()
