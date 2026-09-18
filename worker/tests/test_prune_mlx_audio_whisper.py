from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import runpy
import tempfile
import unittest
from pathlib import Path

PRUNER = runpy.run_path(
    str(Path(__file__).resolve().parents[2] / "scripts" / "prune-mlx-audio-whisper.py")
)
UPSTREAM_INITIALIZER = b"""from . import (
    cohere_asr,
    fireredasr2,
    glmasr,
    granite_speech,
    granite_speech_nar,
    lasr_ctc,
    moss_music,
    moss_transcribe_diarize,
    parakeet,
    qwen3_asr,
    sensevoice,
    voxtral,
    voxtral_realtime,
    wav2vec,
    whisper,
)
"""


class PruneWhisperTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.site = self.root / "site-packages"
        self.dist = self.site / "mlx_audio-0.4.6.dist-info"
        self.dist.mkdir(parents=True)
        (self.dist / "METADATA").write_text("Name: mlx-audio\nVersion: 0.4.6\n")
        self.initializer = self.site / PRUNER["INIT_PATH"]
        self.backend = self.site / PRUNER["WHISPER_PATH"]
        self.backend.mkdir(parents=True)
        self.initializer.write_bytes(UPSTREAM_INITIALIZER)
        (self.backend / "__init__.py").write_text("# retired backend\n")
        self.notice = self.dist / "licenses" / "LICENSE"
        self.notice.parent.mkdir()
        self.notice.write_bytes(b"upstream notice")
        self.extractor = self.site / "transformers/models/whisper/feature_extraction_whisper.py"
        self.extractor.parent.mkdir(parents=True)
        self.extractor.write_bytes(b"Qwen shared feature extractor")
        record = io.StringIO()
        csv.writer(record).writerows(
            [
                [PRUNER["INIT_PATH"], "sha256=upstream", str(len(UPSTREAM_INITIALIZER))],
                [f'{PRUNER["WHISPER_PATH"]}/__init__.py', "sha256=retired", "18"],
                ["mlx_audio/stt/models/qwen3_asr/__init__.py", "sha256=retained", "42"],
                ["mlx_audio-0.4.6.dist-info/licenses/LICENSE", "sha256=notice", "15"],
                ["mlx_audio-0.4.6.dist-info/RECORD", "", ""],
            ]
        )
        self.record = self.dist / "RECORD"
        self.record.write_text(record.getvalue())

    def test_removes_only_retired_backend_and_updates_wheel_record(self) -> None:
        PRUNER["prune_whisper"](self.site)
        self.assertFalse(self.backend.exists())
        expected = UPSTREAM_INITIALIZER.replace(b"    whisper,\n", b"")
        self.assertEqual(self.initializer.read_bytes(), expected)
        self.assertEqual(self.notice.read_bytes(), b"upstream notice")
        self.assertEqual(self.extractor.read_bytes(), b"Qwen shared feature extractor")
        rows = list(csv.reader(io.StringIO(self.record.read_text())))
        digest = base64.urlsafe_b64encode(hashlib.sha256(expected).digest()).decode().rstrip("=")
        self.assertIn([PRUNER["INIT_PATH"], f"sha256={digest}", str(len(expected))], rows)
        self.assertIn(["mlx_audio/stt/models/qwen3_asr/__init__.py", "sha256=retained", "42"], rows)
        self.assertFalse(any(row[0].startswith(PRUNER["WHISPER_PATH"] + "/") for row in rows))
        marker = self.dist / "localscribe-pruning.json"
        self.assertEqual(json.loads(marker.read_text()), {
            "version": "0.4.6",
            "originalSha256": hashlib.sha256(UPSTREAM_INITIALIZER).hexdigest(),
            "patchedSha256": hashlib.sha256(expected).hexdigest(),
            "removedPaths": [PRUNER["WHISPER_PATH"]],
        })
        marker_digest = base64.urlsafe_b64encode(hashlib.sha256(marker.read_bytes()).digest())
        self.assertIn([
            "mlx_audio-0.4.6.dist-info/localscribe-pruning.json",
            f"sha256={marker_digest.decode().rstrip('=')}", str(marker.stat().st_size),
        ], rows)

    def test_drifted_version_source_and_record_fail_before_mutation(self) -> None:
        for target, altered in (
            (self.dist / "METADATA", b"Name: mlx-audio\nVersion: 0.4.7\n"),
            (self.initializer, UPSTREAM_INITIALIZER + b"# upstream changed\n"),
            (self.record, b"unrelated.py,sha256=other,5\n"),
        ):
            with self.subTest(path=target.name):
                original = target.read_bytes()
                target.write_bytes(altered)
                source_before = self.initializer.read_bytes()
                record_before = self.record.read_bytes()
                with self.assertRaises(ValueError):
                    PRUNER["prune_whisper"](self.site)
                self.assertTrue(self.backend.is_dir())
                self.assertEqual(self.initializer.read_bytes(), source_before)
                self.assertEqual(self.record.read_bytes(), record_before)
                self.assertFalse((self.dist / "localscribe-pruning.json").exists())
                target.write_bytes(original)

    def test_symlink_backend_is_rejected_without_touching_target(self) -> None:
        preserved = self.root / "user-data"
        self.backend.rename(preserved)
        self.backend.symlink_to(preserved, target_is_directory=True)
        with self.assertRaises(ValueError):
            PRUNER["prune_whisper"](self.site)
        self.assertEqual((preserved / "__init__.py").read_text(), "# retired backend\n")
        self.assertEqual(self.initializer.read_bytes(), UPSTREAM_INITIALIZER)

    def test_verifier_checks_provenance_and_candidate_without_writes(self) -> None:
        PRUNER["prune_whisper"](self.site)
        marker = self.dist / "localscribe-pruning.json"
        before = {
            path: path.read_bytes() for path in self.site.rglob("*") if path.is_file()
        }
        self.assertEqual(PRUNER["verify_pruned_whisper"](self.site), json.loads(marker.read_text()))
        self.assertEqual(before, {
            path: path.read_bytes() for path in self.site.rglob("*") if path.is_file()
        })
        expected_marker = json.loads(marker.read_text())
        altered_markers = [
            {**expected_marker, "extra": "not allowed"},
            {**expected_marker, "version": "0.4.7"},
            {**expected_marker, "originalSha256": "a" * 64},
            {**expected_marker, "patchedSha256": "a" * 64},
            {**expected_marker, "removedPaths": []},
        ]
        for altered in altered_markers:
            with self.subTest(marker=altered):
                marker.write_text(json.dumps(altered))
                with self.assertRaises(ValueError):
                    PRUNER["verify_pruned_whisper"](self.site)
        marker.write_bytes(before[marker])
        for target, altered in (
            (self.initializer, UPSTREAM_INITIALIZER),
            (self.dist / "METADATA", b"Name: mlx-audio\nVersion: 0.4.7\n"),
        ):
            with self.subTest(path=target.name):
                target.write_bytes(altered)
                with self.assertRaises(ValueError):
                    PRUNER["verify_pruned_whisper"](self.site)
                target.write_bytes(before[target])
        self.backend.mkdir()
        with self.assertRaises(ValueError):
            PRUNER["verify_pruned_whisper"](self.site)
        self.backend.rmdir()
        self.backend.symlink_to(self.root / "nonexistent")
        with self.assertRaises(ValueError):
            PRUNER["verify_pruned_whisper"](self.site)

    def test_verifier_rejects_symlinked_provenance(self) -> None:
        PRUNER["prune_whisper"](self.site)
        marker = self.dist / "localscribe-pruning.json"
        external = self.root / "external-marker.json"
        marker.rename(external)
        marker.symlink_to(external)
        with self.assertRaises(ValueError):
            PRUNER["verify_pruned_whisper"](self.site)

    def test_verifier_rejects_stale_malformed_and_duplicate_record_entries(self) -> None:
        PRUNER["prune_whisper"](self.site)
        rows = list(csv.reader(io.StringIO(self.record.read_text())))
        initializer_row = next(row for row in rows if row[0] == PRUNER["INIT_PATH"])
        marker_row = next(row for row in rows if row[0].endswith("/localscribe-pruning.json"))
        upstream_digest = base64.urlsafe_b64encode(hashlib.sha256(UPSTREAM_INITIALIZER).digest())
        mutations = {
            "retired-backend": [*rows, [f'{PRUNER["WHISPER_PATH"]}/model.py', "sha256=stale", "1"]],
            "original-initializer": [
                [row[0], f"sha256={upstream_digest.decode().rstrip('=')}", row[2]]
                if row == initializer_row else row for row in rows
            ],
            "marker-hash": [
                [row[0], "sha256=wrong", row[2]] if row == marker_row else row for row in rows
            ],
            "initializer-size": [
                [row[0], row[1], "999"] if row == initializer_row else row for row in rows
            ],
            "marker-size": [
                [row[0], row[1], "999"] if row == marker_row else row for row in rows
            ],
            "duplicate-initializer": [*rows, initializer_row],
            "duplicate-marker": [*rows, marker_row],
            "missing-initializer": [row for row in rows if row != initializer_row],
            "missing-marker": [row for row in rows if row != marker_row],
            "malformed-columns": [*rows, ["unrelated.py", "extra", "four", "columns"]],
        }
        for label, changed_rows in mutations.items():
            with self.subTest(mutation=label):
                altered = io.StringIO()
                csv.writer(altered).writerows(changed_rows)
                self.record.write_text(altered.getvalue())
                with self.assertRaises(ValueError):
                    PRUNER["verify_pruned_whisper"](self.site)
                self.assertEqual(self.record.read_bytes(), altered.getvalue().encode())

    def test_verifier_requires_an_ordinary_record_file(self) -> None:
        PRUNER["prune_whisper"](self.site)
        external = self.root / "external-record"
        self.record.rename(external)
        self.record.symlink_to(external)
        with self.assertRaises(ValueError):
            PRUNER["verify_pruned_whisper"](self.site)
        self.record.unlink()
        self.record.mkdir()
        with self.assertRaises(ValueError):
            PRUNER["verify_pruned_whisper"](self.site)


if __name__ == "__main__":
    unittest.main()
