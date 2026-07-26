import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shorts_generator.artifact_contracts import content_hash
from shorts_generator.pipeline import (
    _planned_local_batch_outputs,
    _promote_staged_local_batch,
    write_local_ranking_manifest,
)


class PipelineAtomicBatchTests(unittest.TestCase):
    def _staged_batch(self, root: Path):
        output_dir = root / "output"
        output_dir.mkdir()
        staging_dir = Path(
            tempfile.mkdtemp(prefix=".shorts-render-batch-", dir=output_dir)
        )
        staged_shorts = []
        for index, value in enumerate((b"new-one", b"new-two"), start=1):
            path = staging_dir / f"short_{index:02d}.mp4"
            path.write_bytes(value)
            staged_shorts.append(
                {
                    "output_rank": index,
                    "clip_url": str(path),
                    "editorial_qa_report": {
                        "artifactType": "CreativeQaReport",
                        "videoPath": str(path.resolve()),
                        "passed": True,
                        "contentHash": "staged-hash",
                    },
                }
            )
        final_shorts = _planned_local_batch_outputs(
            staged_shorts,
            str(output_dir),
        )
        manifest_path = write_local_ranking_manifest(
            {"selected_outputs": final_shorts},
            str(staging_dir),
        )
        return output_dir, staging_dir, staged_shorts, final_shorts, manifest_path

    def test_verified_batch_replaces_outputs_and_manifest_together(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (
                output_dir,
                _staging_dir,
                staged_shorts,
                final_shorts,
                manifest_path,
            ) = self._staged_batch(root)
            (output_dir / "short_01.mp4").write_bytes(b"old-one")
            (output_dir / "short_02.mp4").write_bytes(b"old-two")
            (output_dir / "ranking.json").write_text("old", encoding="utf-8")

            published_manifest = _promote_staged_local_batch(
                staged_shorts,
                final_shorts,
                manifest_path,
                str(output_dir),
            )

            self.assertEqual((output_dir / "short_01.mp4").read_bytes(), b"new-one")
            self.assertEqual((output_dir / "short_02.mp4").read_bytes(), b"new-two")
            self.assertEqual(published_manifest, str(output_dir / "ranking.json"))
            published = json.loads((output_dir / "ranking.json").read_text())
            self.assertEqual(
                [item["clip_url"] for item in published["selected_outputs"]],
                [
                    str(output_dir / "short_01.mp4"),
                    str(output_dir / "short_02.mp4"),
                ],
            )
            qa_report = final_shorts[0]["editorial_qa_report"]
            self.assertEqual(
                qa_report["videoPath"],
                str((output_dir / "short_01.mp4").resolve()),
            )
            self.assertEqual(qa_report["contentHash"], content_hash(qa_report))

    def test_publication_failure_rolls_back_every_existing_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (
                output_dir,
                _staging_dir,
                staged_shorts,
                final_shorts,
                manifest_path,
            ) = self._staged_batch(root)
            expected = {
                "short_01.mp4": b"old-one",
                "short_02.mp4": b"old-two",
                "ranking.json": b"old-ranking",
            }
            for name, value in expected.items():
                (output_dir / name).write_bytes(value)

            real_replace = os.replace
            failing_source = Path(staged_shorts[1]["clip_url"]).resolve()

            def fail_second_new_artifact(source, destination):
                if (
                    Path(source).resolve() == failing_source
                    and Path(destination).name == "short_02.mp4"
                ):
                    raise OSError("simulated publication failure")
                return real_replace(source, destination)

            with patch(
                "shorts_generator.pipeline.os.replace",
                side_effect=fail_second_new_artifact,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "atomic batch publication failed",
                ):
                    _promote_staged_local_batch(
                        staged_shorts,
                        final_shorts,
                        manifest_path,
                        str(output_dir),
                    )

            for name, value in expected.items():
                self.assertEqual((output_dir / name).read_bytes(), value)

    def test_artifact_outside_staging_directory_is_rejected_before_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (
                output_dir,
                _staging_dir,
                staged_shorts,
                final_shorts,
                manifest_path,
            ) = self._staged_batch(root)
            escaped = root / "escaped.mp4"
            escaped.write_bytes(b"not-staged")
            staged_shorts[0]["clip_url"] = str(escaped)

            with self.assertRaisesRegex(RuntimeError, "escaped batch staging"):
                _promote_staged_local_batch(
                    staged_shorts,
                    final_shorts,
                    manifest_path,
                    str(output_dir),
                )
            self.assertFalse((output_dir / "short_01.mp4").exists())


if __name__ == "__main__":
    unittest.main()
