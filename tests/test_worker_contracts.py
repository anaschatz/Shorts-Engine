import copy
import json
import unittest
from pathlib import Path

from shorts_generator.worker_contracts import (
    VALIDATORS,
    WorkerContractError,
    validate_fixture,
)


FIXTURE = (
    Path(__file__).parent
    / "fixtures"
    / "node-python-contracts"
    / "valid-v1.json"
)


class WorkerContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_shared_fixture_validates_every_contract(self):
        validate_fixture(FIXTURE)
        self.assertEqual(set(self.payload), set(VALIDATORS))

    def test_contracts_reject_absolute_paths_and_unknown_fields(self):
        for name, validator in VALIDATORS.items():
            with self.subTest(name=name):
                invalid = copy.deepcopy(self.payload[name])
                invalid["localPath"] = "/tmp/private.mp4"
                with self.assertRaisesRegex(
                    WorkerContractError,
                    "CONTRACT_SHAPE_INVALID",
                ):
                    validator(invalid)

    def test_version_and_cross_artifact_links_fail_closed(self):
        invalid_version = copy.deepcopy(self.payload["analysisRequest"])
        invalid_version["schemaVersion"] = 2
        with self.assertRaisesRegex(
            WorkerContractError,
            "CONTRACT_VERSION_UNSUPPORTED",
        ):
            VALIDATORS["analysisRequest"](invalid_version)

        invalid_link = copy.deepcopy(self.payload["renderRequest"])
        invalid_link["candidate"]["sourceArtifactId"] = "artifact.other"
        with self.assertRaisesRegex(WorkerContractError, "CONTRACT_LINK_INVALID"):
            VALIDATORS["renderRequest"](invalid_link)

    def test_structured_errors_are_bounded_and_code_only(self):
        invalid = copy.deepcopy(self.payload["errorResponse"])
        invalid["error"]["message"] = "x" * 241
        with self.assertRaisesRegex(WorkerContractError, "CONTRACT_VALUE_INVALID"):
            VALIDATORS["errorResponse"](invalid)


if __name__ == "__main__":
    unittest.main()
