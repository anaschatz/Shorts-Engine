import unittest

from shorts_generator.gaming_context import enrich_gaming_context, gaming_context_label


def words(text, start, step=0.3):
    result = []
    cursor = start
    for token in text.split():
        result.append({"word": token, "start": cursor, "end": cursor + step})
        cursor += step
    return result


class GamingContextTests(unittest.TestCase):
    def test_non_spoiler_label_removes_outcome_from_title(self):
        label = gaming_context_label(
            {"title": "Level 1 Pistol Only Survival Fail"}
        )

        self.assertEqual(label, "LEVEL 1 PISTOL ONLY SURVIVAL")

    def test_leading_filler_is_trimmed_to_exact_hook(self):
        transcript = {
            "segments": [
                {
                    "start": 0.0,
                    "end": 1.5,
                    "text": "Sorry I read that wrong.",
                    "words": words("Sorry I read that wrong.", 0.0),
                },
                {
                    "start": 2.0,
                    "end": 5.0,
                    "text": "But yeah all I got is a pistol.",
                    "words": words("But yeah all I got is a pistol.", 2.0),
                },
            ]
        }
        enriched = enrich_gaming_context(
            [
                {
                    "title": "Level 1 Pistol Only Fail",
                    "hook_sentence": "But yeah all I got is a pistol.",
                    "start_time": 0.0,
                    "speech_start_time": 0.0,
                    "speech_end_time": 30.0,
                    "end_time": 30.0,
                }
            ],
            transcript,
        )[0]

        self.assertEqual(enriched["speech_start_time"], 2.0)
        self.assertEqual(enriched["start_time"], 2.0)
        self.assertTrue(enriched["gaming_context_clear"])

    def test_reaction_opening_extends_to_previous_setup(self):
        transcript = {
            "segments": [
                {
                    "start": 5.0,
                    "end": 9.0,
                    "text": "Wave nine, I am the last man alive.",
                },
                {
                    "start": 10.0,
                    "end": 14.0,
                    "text": "Oh my god, there are enemies everywhere.",
                },
            ]
        }
        enriched = enrich_gaming_context(
            [
                {
                    "title": "Last Man Wave Nine",
                    "hook_sentence": "Oh my god, there are enemies everywhere.",
                    "start_time": 9.5,
                    "speech_start_time": 10.0,
                    "speech_end_time": 40.0,
                    "end_time": 40.5,
                }
            ],
            transcript,
        )[0]

        self.assertEqual(enriched["speech_start_time"], 5.0)
        self.assertLessEqual(enriched["speech_end_time"] - enriched["start_time"], 75.0)

    def test_discards_too_short_pre_roll_from_previous_shot(self):
        transcript = {
            "segments": [
                {
                    "start": 10.0,
                    "end": 14.0,
                    "text": "Okay I am at a little bit of a problem.",
                    "words": words("Okay I am at a little bit of a problem.", 10.0),
                }
            ]
        }
        enriched = enrich_gaming_context(
            [
                {
                    "title": "Playing with one eye",
                    "hook_sentence": "Okay I am at a little bit of a problem.",
                    "start_time": 9.82,
                    "speech_start_time": 10.0,
                    "speech_end_time": 35.0,
                    "end_time": 35.5,
                }
            ],
            transcript,
        )[0]

        self.assertEqual(enriched["start_time"], 10.0)

    def test_adds_source_objective_before_limitation_only_opening(self):
        transcript = {
            "segments": [
                {
                    "start": 2.0,
                    "end": 4.0,
                    "text": "Okay, so I just need to survive 10 waves.",
                    "words": words("Okay so I just need to survive 10 waves.", 2.0, 0.2),
                },
                {
                    "start": 20.0,
                    "end": 23.0,
                    "text": "All I got for this is a pistol.",
                    "words": words("All I got for this is a pistol.", 20.0),
                },
            ]
        }
        enriched = enrich_gaming_context(
            [
                {
                    "title": "Pistol survival",
                    "hook_sentence": "All I got for this is a pistol.",
                    "start_time": 20.0,
                    "speech_start_time": 20.0,
                    "speech_end_time": 60.0,
                    "end_time": 60.0,
                }
            ],
            transcript,
        )[0]

        self.assertEqual(len(enriched["source_beats"]), 2)
        self.assertEqual(enriched["source_beats"][0]["role"], "objective")
        self.assertEqual(
            enriched["source_beats"][0]["context_overlay"]["text"],
            "THE CHALLENGE: SURVIVE 10 WAVES",
        )
        self.assertLessEqual(enriched["duration_seconds"], 75.0)

    def test_adds_mode_and_stakes_when_source_premise_is_available(self):
        transcript = {
            "segments": [
                {"start": 1.0, "end": 3.0, "text": "The new game mode this week"},
                {"start": 3.0, "end": 5.0, "text": "is the island survival."},
                {"start": 7.0, "end": 10.0, "text": "I have never played it and it is double money."},
                {"start": 10.0, "end": 13.0, "text": "I am low level with only a pistol."},
                {"start": 15.0, "end": 17.0, "text": "I need to survive 10 waves."},
                {
                    "start": 20.0,
                    "end": 23.0,
                    "text": "All I got for this is a pistol.",
                    "words": words("All I got for this is a pistol.", 20.0),
                },
            ]
        }
        enriched = enrich_gaming_context(
            [
                {
                    "title": "Pistol survival",
                    "hook_sentence": "All I got for this is a pistol.",
                    "start_time": 20.0,
                    "speech_start_time": 20.0,
                    "speech_end_time": 60.0,
                    "end_time": 60.0,
                }
            ],
            transcript,
        )[0]

        self.assertEqual(
            [beat["role"] for beat in enriched["source_beats"]],
            ["premise", "premise_stakes", "objective", "action"],
        )
        self.assertLessEqual(enriched["duration_seconds"], 75.0)


if __name__ == "__main__":
    unittest.main()
