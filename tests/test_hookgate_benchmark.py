"""Synthetic contract tests for real-project HookGate benchmark governance."""

import copy
import hashlib
import unittest

from research.hookgate_benchmark import BenchmarkDatasetError, evaluate_dataset


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _dataset() -> dict:
    projects = []
    categories = ("football", "motivational", "narrated_animation")
    for index in range(30):
        accepted = f"candidate-{index}-accepted"
        rejected = f"candidate-{index}-rejected"
        projects.append(
            {
                "projectKey": _digest(f"project-{index}"),
                "sequenceIndex": index,
                "category": categories[index % len(categories)],
                "split": "train" if index < 10 else "evaluation",
                "humanRating": {
                    "reviewerKey": _digest(f"reviewer-{index % 3}"),
                    "acceptedCandidateIds": [accepted],
                    "pairwisePreferences": [[accepted, rejected]],
                },
                "variants": {
                    "v2": {
                        "ranking": [rejected, accepted],
                        "boundaryCompleteness": 80,
                        "captionReadability": 85,
                        "visualSubjectCoverage": 65,
                        "attributionFailures": 1,
                        "latencyMs": 40,
                        "estimatedCostUsd": None,
                    },
                    "v3": {
                        "ranking": [accepted, rejected],
                        "boundaryCompleteness": 95,
                        "captionReadability": 92,
                        "visualSubjectCoverage": 78,
                        "attributionFailures": 0,
                        "latencyMs": 55,
                        "estimatedCostUsd": 0.01,
                    },
                },
            }
        )
    return {
        "artifactType": "HookGateComparisonDataset",
        "schemaVersion": 1,
        "datasetVersion": "synthetic-contract-test-only",
        "collection": {
            "consecutive": True,
            "selectedOnly": False,
            "anonymized": True,
            "sourceKind": "real_projects",
        },
        "projects": projects,
    }


class HookGateBenchmarkTests(unittest.TestCase):
    def test_computes_v2_v3_metrics_from_evaluation_split(self):
        report = evaluate_dataset(_dataset())
        self.assertEqual(report["evaluationProjectCount"], 20)
        self.assertEqual(report["variants"]["v2"]["top1HumanAcceptance"], 0)
        self.assertEqual(report["variants"]["v3"]["top1HumanAcceptance"], 100)
        self.assertEqual(report["variants"]["v3"]["visualSubjectCoverage"], 78)
        self.assertEqual(report["variants"]["v2"]["costCoverage"], 0)
        self.assertEqual(report["variants"]["v3"]["costCoverage"], 100)

    def test_rejects_fewer_than_thirty_projects(self):
        payload = _dataset()
        payload["projects"].pop()
        with self.assertRaisesRegex(BenchmarkDatasetError, "INSUFFICIENT_PROJECTS"):
            evaluate_dataset(payload)

    def test_rejects_non_consecutive_or_selected_only_collection(self):
        non_consecutive = _dataset()
        non_consecutive["projects"][10]["sequenceIndex"] = 100
        with self.assertRaisesRegex(BenchmarkDatasetError, "NON_CONSECUTIVE_PROJECTS"):
            evaluate_dataset(non_consecutive)

        selected_only = _dataset()
        selected_only["collection"]["selectedOnly"] = True
        with self.assertRaisesRegex(BenchmarkDatasetError, "UNSAFE_COLLECTION"):
            evaluate_dataset(selected_only)

    def test_rejects_unhashed_project_or_reviewer_identity(self):
        project_identity = _dataset()
        project_identity["projects"][0]["projectKey"] = "source-name.mp4"
        with self.assertRaisesRegex(BenchmarkDatasetError, "PROJECT_NOT_ANONYMIZED"):
            evaluate_dataset(project_identity)

        reviewer_identity = copy.deepcopy(_dataset())
        reviewer_identity["projects"][0]["humanRating"]["reviewerKey"] = "Alice"
        with self.assertRaisesRegex(BenchmarkDatasetError, "REVIEWER_NOT_ANONYMIZED"):
            evaluate_dataset(reviewer_identity)


if __name__ == "__main__":
    unittest.main()
