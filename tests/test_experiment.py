import unittest

from shorts_generator.experiment import build_experiment_manifest


class ExperimentManifestTests(unittest.TestCase):
    def test_manifest_predeclares_profiles_metrics_and_gates(self):
        value = build_experiment_manifest(
            experiment_id="bf_content_001",
            cohort_id="contradiction",
            treatment_id="contradiction_01",
            candidate_hash="a" * 64,
            hypothesis="Contradiction hooks improve the stop rate.",
            primary_variable="hook_family",
            pillar="discipline_work",
            duration_seconds=10.75,
            declared_at="2026-07-16T12:00:00Z",
            decision_due_at="2026-08-13T12:00:00Z",
        )
        self.assertEqual(value["fixedVariables"]["renderProfile"], "bf_editorial_inset_v1")
        self.assertEqual(value["snapshotGatesHours"], [1, 6, 24, 72, 168, 672])
        self.assertTrue(value["humanDecisionRequired"])


if __name__ == "__main__":
    unittest.main()
