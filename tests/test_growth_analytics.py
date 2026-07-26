import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from shorts_generator.growth_analytics import (
    GrowthAnalyticsStore,
    build_analytics_snapshot,
    evaluate_cohorts,
    import_studio_csv,
)


PUBLISHED = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)


def snapshot(video_id, cohort, stayed, viewed, engaged, shares, subscribers):
    return build_analytics_snapshot(
        video_id=video_id,
        published_at=PUBLISHED.isoformat(),
        observed_at=(PUBLISHED + timedelta(hours=168)).isoformat(),
        metrics={
            "views": engaged * 2,
            "engagedViews": engaged,
            "stayedToWatchPercent": stayed,
            "averageViewDurationSeconds": 10,
            "averagePercentageViewed": viewed,
            "likes": 20,
            "shares": shares,
            "comments": 2,
            "subscribersGained": subscribers,
        },
        source="studio_csv",
        experiment_id="bf_content_001",
        cohort_id=cohort,
        treatment_id=cohort,
        pillar="discipline_work",
        duration_seconds=11.0,
    )


class GrowthAnalyticsTests(unittest.TestCase):
    def test_snapshot_is_equal_age_and_has_derived_rates(self):
        value = snapshot("video_a", "contradiction", 55, 92, 1000, 20, 5)
        self.assertEqual(value["snapshotGateHours"], 168)
        self.assertTrue(value["decisionEligible"])
        self.assertEqual(value["metrics"]["sharesPer1000Engaged"], 20.0)

    def test_store_replays_same_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            store = GrowthAnalyticsStore(str(Path(directory) / "snapshots.json"))
            value = snapshot("video_a", "contradiction", 55, 92, 1000, 20, 5)
            self.assertFalse(store.upsert(value)["replayed"])
            self.assertTrue(store.upsert(value)["replayed"])
            self.assertEqual(len(store.list(168)), 1)

    def test_cohort_winner_requires_three_primary_and_one_satisfaction_lead(self):
        values = []
        for index in range(3):
            values.append(snapshot(f"a{index}", "contradiction", 55 + index, 90 + index, 1300 + index * 20, 18, 5))
            values.append(snapshot(f"b{index}", "generic", 45 + index, 80 + index, 800 + index * 10, 4, 1))
        report = evaluate_cohorts(values, gate_hours=168, minimum_per_cohort=3)
        self.assertEqual(report["decision"], "human_review_winner")
        self.assertEqual(report["winnerCohortId"], "contradiction")
        self.assertTrue(report["humanApprovalRequired"])

    def test_studio_csv_aliases_are_normalized(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "studio.csv"
            path.write_text(
                "Video ID,Views,Engaged views,Stayed to watch (%),Average percentage viewed (%),Likes,Shares,Comments,Subscribers gained\n"
                "abc123,2000,1000,55.2%,91.0%,40,12,3,5\n",
                encoding="utf-8",
            )
            rows = import_studio_csv(str(path))
        self.assertEqual(rows[0]["videoId"], "abc123")
        self.assertEqual(rows[0]["metrics"]["stayedToWatchPercent"], 55.2)
        self.assertEqual(rows[0]["metrics"]["subscribersPer1000Engaged"], 5.0)


if __name__ == "__main__":
    unittest.main()
