from __future__ import annotations

import ctypes
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
from localscribe_worker import canary_runtime as canary
from localscribe_worker.worker import MODEL_MANIFESTS, TIER_SPECS, WorkerError, _load_runtime


def spec_for(tier: str = "medium"):
    return next(spec for spec in TIER_SPECS.values()
                if spec.family_id == "canary-qwen-2-5b" and spec.tier == tier)


def fake_library():
    library = MagicMock()
    library.localscribe_canary_abi.return_value = 1
    library.localscribe_canary_revision.return_value = canary.REVISION

    def load(_path, output):
        ctypes.cast(output, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.c_void_p(123)
        return 0

    library.localscribe_canary_load.side_effect = load

    def transcribe(_model, _audio, _count, output, _capacity):
        output.value = b"A complete result."
        return 0

    library.localscribe_canary_transcribe.side_effect = transcribe
    return library


class CanaryRuntimeTests(unittest.TestCase):
    def test_chunk_partition_preserves_all_samples_without_overlap(self):
        for length in (1, 16000, canary.CHUNK_SAMPLES, canary.CHUNK_SAMPLES + 1,
                       95 * canary.SAMPLE_RATE, canary.MAX_SAMPLES):
            audio = np.arange(length, dtype=np.float32) / max(length, 1)
            parts = list(canary._chunks(audio))
            self.assertTrue(all(0 < part.size <= canary.CHUNK_SAMPLES for part in parts))
            np.testing.assert_array_equal(np.concatenate(parts), audio)

    def test_chunk_boundary_prefers_quiet_audio(self):
        audio = np.ones(60 * canary.SAMPLE_RATE, dtype=np.float32)
        audio[27 * canary.SAMPLE_RATE:28 * canary.SAMPLE_RATE] = 0
        first = next(canary._chunks(audio))
        self.assertGreater(first.size, 27 * canary.SAMPLE_RATE)
        self.assertLess(first.size, 28 * canary.SAMPLE_RATE)

    def test_pinned_profiles_and_bridge_revision_match_source_pin(self):
        root = Path(__file__).resolve().parents[2]
        pin = json.loads((root / "tools/canary-runtime/pin.json").read_text())
        self.assertEqual(pin["revision"].encode(), canary.REVISION)
        self.assertEqual([spec_for(tier).compute_type for tier in ("high", "medium", "low")],
                         ["bfloat16", "int8", "int4"])

    def test_load_uses_exact_manifest_filename_without_network(self):
        for tier in ("high", "medium", "low"):
            spec = spec_for(tier)
            manifest = MODEL_MANIFESTS[(spec.model_id, spec.tier, spec.compute_type)]
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                file = root / next(iter(manifest.files))
                file.write_bytes(b"fixture, not model weights")
                library = fake_library()
                with patch.object(canary, "_library_path", return_value=root / "bridge.dylib"), \
                     patch.object(canary.ctypes, "CDLL", return_value=library):
                    runtime = _load_runtime(root, spec)
                self.assertIsInstance(runtime, canary.CanaryRuntime)
                self.assertEqual(library.localscribe_canary_load.call_args.args[0], str(file).encode())
                runtime.close()
                runtime.close()
                library.localscribe_canary_free.assert_called_once()

    def test_rejects_live_before_loading_library(self):
        with patch.object(canary.ctypes, "CDLL") as loader:
            with self.assertRaises(WorkerError):
                canary.CanaryRuntime.load(Path("/unused"), replace(spec_for(), asr_mode="live"))
            loader.assert_not_called()

    def test_library_lookup_is_bundle_bound_and_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            module = root / "worker/localscribe_worker/canary_runtime.py"
            module.parent.mkdir(parents=True)
            module.touch()
            library = root / "native/macos" / canary.LIBRARY_FILENAME
            library.parent.mkdir(parents=True)
            outside = root / "outside.dylib"
            outside.write_bytes(b"fixture")
            library.symlink_to(outside)
            with patch.object(canary, "__file__", str(module)):
                with self.assertRaises(WorkerError):
                    canary._library_path()
                library.unlink()
                library.write_bytes(b"fixture")
                self.assertEqual(canary._library_path(), library)

    def test_failed_load_releases_any_returned_native_handle(self):
        spec = spec_for()
        manifest = MODEL_MANIFESTS[(spec.model_id, spec.tier, spec.compute_type)]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / next(iter(manifest.files))).write_bytes(b"fixture")
            library = fake_library()

            def failed_load(_path, output):
                ctypes.cast(output, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.c_void_p(123)
                return 2

            library.localscribe_canary_load.side_effect = failed_load
            with patch.object(canary, "_library_path", return_value=root / "bridge.dylib"), \
                 patch.object(canary.ctypes, "CDLL", return_value=library):
                with self.assertRaises(WorkerError):
                    canary.CanaryRuntime.load(root, spec)
            library.localscribe_canary_free.assert_called_once()

    def test_runtime_identity_mismatch_fails_before_model_load(self):
        spec = spec_for()
        manifest = MODEL_MANIFESTS[(spec.model_id, spec.tier, spec.compute_type)]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / next(iter(manifest.files))).write_bytes(b"fixture")
            for abi, revision in ((2, canary.REVISION), (1, b"wrong")):
                library = fake_library()
                library.localscribe_canary_abi.return_value = abi
                library.localscribe_canary_revision.return_value = revision
                with patch.object(canary, "_library_path", return_value=root / "bridge.dylib"), \
                     patch.object(canary.ctypes, "CDLL", return_value=library):
                    with self.assertRaisesRegex(WorkerError, "identity"):
                        canary.CanaryRuntime.load(root, spec)
                library.localscribe_canary_load.assert_not_called()

    def test_long_recording_returns_one_final_and_preserves_warm_model(self):
        library = fake_library()
        runtime = canary.CanaryRuntime(library, ctypes.c_void_p(123))
        result = runtime.transcribe(b"\x00\x00" * (61 * canary.SAMPLE_RATE), language="en", context="")
        self.assertEqual(result.text, "A complete result. A complete result. A complete result.")
        self.assertEqual(result.language, "en")
        self.assertEqual(library.localscribe_canary_transcribe.call_count, 3)
        self.assertEqual(sum(call.args[2] for call in library.localscribe_canary_transcribe.call_args_list),
                         61 * canary.SAMPLE_RATE)
        runtime.release_transient_memory()
        library.localscribe_canary_free.assert_not_called()
        runtime.transcribe(b"\x00\x00" * 160, language="en", context="")
        runtime.close()
        library.localscribe_canary_free.assert_called_once()

    def test_truncated_or_failed_later_chunk_never_returns_partial_success(self):
        for status in (2, 3, 4):
            library = fake_library()
            first = library.localscribe_canary_transcribe.side_effect
            count = 0

            def run(*args, first=first, status=status):
                nonlocal count
                count += 1
                return first(*args) if count == 1 else status

            library.localscribe_canary_transcribe.side_effect = run
            runtime = canary.CanaryRuntime(library, ctypes.c_void_p(123))
            with self.assertRaises(WorkerError):
                runtime.transcribe(b"\x00\x00" * (31 * canary.SAMPLE_RATE), language="en", context="")
            runtime.close()
            library.localscribe_canary_free.assert_called_once()

    def test_invalid_input_and_unsupported_features_never_reach_native_code(self):
        library = fake_library()
        runtime = canary.CanaryRuntime(library, ctypes.c_void_p(123))
        for audio, language, context in ((b"", "en", ""), (b"x", "en", ""),
                                         (b"xx", "es", ""), (b"xx", "en", "prompt")):
            with self.assertRaises(WorkerError):
                runtime.transcribe(audio, language=language, context=context)
        runtime.close()
        with self.assertRaises(WorkerError):
            runtime.transcribe(b"xx", language="en", context="")
        library.localscribe_canary_transcribe.assert_not_called()

    def test_pcm_conversion_is_float32_and_correctly_normalized(self):
        library = fake_library()

        def inspect(_model, pcm, count, output, _capacity):
            np.testing.assert_array_equal(np.ctypeslib.as_array(pcm, shape=(count,)),
                                          [-1.0, 0.0, 32767 / 32768])
            output.value = b""
            return 0

        library.localscribe_canary_transcribe.side_effect = inspect
        runtime = canary.CanaryRuntime(library, ctypes.c_void_p(123))
        self.assertEqual(runtime.transcribe(np.array([-32768, 0, 32767], dtype="<i2").tobytes(),
                                            language="en", context="").text, "")

    def test_invalid_utf8_is_an_error(self):
        library = fake_library()

        def invalid(_model, _pcm, _count, output, _capacity):
            output.value = b"\xff"
            return 0

        library.localscribe_canary_transcribe.side_effect = invalid
        runtime = canary.CanaryRuntime(library, ctypes.c_void_p(123))
        with self.assertRaises(WorkerError):
            runtime.transcribe(b"\x00\x00", language="en", context="")
