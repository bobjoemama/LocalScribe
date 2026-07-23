from __future__ import annotations

import hashlib
import io
import json
import sys
import tempfile
import types
import unittest
import uuid
import wave
from pathlib import Path
from typing import Any
from unittest.mock import patch

import localscribe_windows_worker.worker as worker_module
from localscribe_windows_worker.worker import (
    BACKEND_NAME,
    BACKEND_VERSION,
    MAX_REQUEST_BYTES,
    MODEL_DIRECTORY_NAME,
    MODEL_FILES,
    MODEL_ID,
    MODEL_REVISION,
    DeviceInfo,
    FasterWhisperRuntime,
    TranscriptionResult,
    WorkerError,
    run_worker,
)

TEST_MODEL_BYTES = b"model"
TEST_MODEL_FILES = {
    "model.bin": {
        "bytes": len(TEST_MODEL_BYTES),
        "sha256": hashlib.sha256(TEST_MODEL_BYTES).hexdigest(),
    }
}


class FakeArray:
    def __init__(self, raw: bytes) -> None:
        self.raw = raw
        self.dtype: Any = "<i2"
        self.shape = (len(raw) // 2,)

    def astype(self, dtype: Any) -> "FakeArray":
        self.dtype = dtype
        return self

    def __truediv__(self, _value: float) -> "FakeArray":
        return self


class FakeNumpyModule:
    float32 = "float32"
    ndarray = FakeArray

    @staticmethod
    def frombuffer(raw: bytes, dtype: Any) -> FakeArray:
        array = FakeArray(raw)
        array.dtype = dtype
        return array


def request(message_type: str, **fields: Any) -> dict[str, Any]:
    if message_type == "load_model":
        fields.setdefault("allowDownload", True)
        fields.setdefault("tier", "medium")
        fields.setdefault("computeType", "int8_float16")
    return {"type": message_type, "id": str(uuid.uuid4()), **fields}


def encode_requests(*messages: dict[str, Any]) -> io.BytesIO:
    body = b"".join(
        json.dumps(message, separators=(",", ":")).encode("utf-8") + b"\n"
        for message in messages
    )
    return io.BytesIO(body)


def parse_output(stream: io.StringIO) -> list[dict[str, Any]]:
    return [json.loads(line) for line in stream.getvalue().splitlines()]


def write_wav(path: Path, *, sample_rate: int = 16_000, channels: int = 1) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"\x00\x00" * channels * 160)


def write_test_model(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "model.bin").write_bytes(TEST_MODEL_BYTES)
    return directory


class FakeRuntime:
    def __init__(self, compute_type: str = "int8_float16") -> None:
        self.compute_type = compute_type
        self.calls: list[tuple[Path, str | None, str]] = []
        self.closed = False

    def transcribe(
        self,
        audio_path: Path,
        *,
        language: str | None,
        context: str,
    ) -> TranscriptionResult:
        self.calls.append((audio_path, language, context))
        return TranscriptionResult("Hello from CUDA.", language or "en")

    def close(self) -> None:
        self.closed = True


class WorkerProtocolTests(unittest.TestCase):
    def run_protocol(
        self,
        input_stream: io.BytesIO,
        *,
        installer=None,
        factory=None,
        device_info_provider=None,
        platform_name: str = "win32",
    ) -> tuple[list[dict[str, Any]], str, int]:
        output = io.StringIO()
        errors = io.StringIO()
        kwargs: dict[str, Any] = {
            "input_stream": input_stream,
            "output_stream": output,
            "error_stream": errors,
            "platform_name": platform_name,
        }
        if installer is not None:
            kwargs["model_installer"] = installer
        if factory is not None:
            kwargs["runtime_factory"] = factory
        if device_info_provider is not None:
            kwargs["device_info_provider"] = device_info_provider
        with patch.object(worker_module, "MODEL_FILES", TEST_MODEL_FILES):
            exit_code = run_worker(**kwargs)
        return parse_output(output), errors.getvalue(), exit_code

    def test_hello_health_and_shutdown_without_loading(self) -> None:
        health = request("health")
        shutdown = request("shutdown")
        messages, errors, exit_code = self.run_protocol(encode_requests(health, shutdown))

        self.assertEqual(exit_code, 0)
        self.assertEqual(errors, "")
        self.assertEqual(
            messages[0],
            {
                "type": "hello",
                "protocol": 1,
                "backend": BACKEND_NAME,
                "version": BACKEND_VERSION,
            },
        )
        self.assertEqual(messages[1], {"type": "health", "id": health["id"], "ready": False})
        self.assertEqual(messages[2], {"type": "shutdown", "id": shutdown["id"]})

    def test_loads_and_switches_all_validated_tiers(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model_root = root / "models"
            model_root.mkdir()
            model_directory = write_test_model(model_root / "installed")
            runtimes: list[FakeRuntime] = []
            factory_calls: list[tuple[Path, str]] = []

            def factory(path: Path, compute_type: str) -> FakeRuntime:
                factory_calls.append((path, compute_type))
                runtime = FakeRuntime(compute_type)
                runtimes.append(runtime)
                return runtime

            loads = [
                request(
                    "load_model",
                    modelId=MODEL_ID,
                    modelRoot=str(model_root),
                    tier="high",
                    computeType="float16",
                ),
                request(
                    "load_model",
                    modelId=MODEL_ID,
                    modelRoot=str(model_root),
                    tier="medium",
                    computeType="int8_float16",
                ),
                request(
                    "load_model",
                    modelId=MODEL_ID,
                    modelRoot=str(model_root),
                    tier="low",
                    computeType="int8",
                ),
            ]
            shutdown = request("shutdown")
            messages, errors, exit_code = self.run_protocol(
                encode_requests(*loads, shutdown),
                installer=lambda _path: model_directory,
                factory=factory,
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(errors, "")
            self.assertEqual(
                [(message["tier"], message["computeType"]) for message in messages[1:4]],
                [
                    ("high", "float16"),
                    ("medium", "int8_float16"),
                    ("low", "int8"),
                ],
            )
            self.assertEqual(
                [compute_type for _path, compute_type in factory_calls],
                ["float16", "int8_float16", "int8"],
            )
            self.assertTrue(all(runtime.closed for runtime in runtimes))

    def test_same_tier_load_is_a_zero_ms_noop(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model_root = root / "models"
            model_root.mkdir()
            model_directory = write_test_model(model_root / "installed")
            runtime = FakeRuntime()
            installer_calls = 0
            factory_calls = 0

            def installer(_path: Path) -> Path:
                nonlocal installer_calls
                installer_calls += 1
                return model_directory

            def factory(_path: Path, _compute_type: str) -> FakeRuntime:
                nonlocal factory_calls
                factory_calls += 1
                return runtime

            first = request("load_model", modelId=MODEL_ID, modelRoot=str(model_root))
            second = request("load_model", modelId=MODEL_ID, modelRoot=str(model_root))
            shutdown = request("shutdown")
            messages, _errors, _exit_code = self.run_protocol(
                encode_requests(first, second, shutdown),
                installer=installer,
                factory=factory,
            )

            self.assertEqual(installer_calls, 1)
            self.assertEqual(factory_calls, 1)
            self.assertEqual(messages[2]["loadMs"], 0)
            self.assertTrue(runtime.closed)

    def test_rejects_invalid_tier_compute_pairs_without_loading(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            invalid_messages = [
                request(
                    "load_model",
                    modelId=MODEL_ID,
                    modelRoot=temporary,
                    tier="auto",
                    computeType="float16",
                ),
                request(
                    "load_model",
                    modelId=MODEL_ID,
                    modelRoot=temporary,
                    tier="high",
                    computeType="int8",
                ),
            ]
            shutdown = request("shutdown")
            messages, _errors, _exit_code = self.run_protocol(
                encode_requests(*invalid_messages, shutdown),
                installer=lambda _path: self.fail("installer must not run"),
                factory=lambda _path, _compute: self.fail("factory must not run"),
            )

            self.assertEqual(messages[1]["code"], "invalid_tier")
            self.assertEqual(messages[2]["code"], "invalid_compute_type")

    def test_failed_switch_leaves_worker_unloaded(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model_root = root / "models"
            model_root.mkdir()
            model_directory = write_test_model(model_root / "installed")
            first_runtime = FakeRuntime("float16")
            factory_calls = 0

            def factory(_path: Path, compute_type: str) -> FakeRuntime:
                nonlocal factory_calls
                factory_calls += 1
                if factory_calls == 1:
                    return first_runtime
                raise WorkerError("model_load_failed", "load failed")

            first = request(
                "load_model",
                modelId=MODEL_ID,
                modelRoot=str(model_root),
                tier="high",
                computeType="float16",
            )
            switch = request(
                "load_model",
                modelId=MODEL_ID,
                modelRoot=str(model_root),
                tier="low",
                computeType="int8",
            )
            health = request("health")
            shutdown = request("shutdown")
            messages, _errors, _exit_code = self.run_protocol(
                encode_requests(first, switch, health, shutdown),
                installer=lambda _path: model_directory,
                factory=factory,
            )

            self.assertTrue(first_runtime.closed)
            self.assertEqual(messages[2]["code"], "model_load_failed")
            self.assertEqual(messages[3], {"type": "health", "id": health["id"], "ready": False})

    def test_load_transcribe_uses_iso_language_and_context(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model_root = root / "models"
            model_root.mkdir()
            model_directory = write_test_model(model_root / "installed")
            audio_root = root / "audio"
            audio_root.mkdir()
            audio_path = audio_root / "utterance.wav"
            write_wav(audio_path)
            runtime = FakeRuntime()

            load = request("load_model", modelId=MODEL_ID, modelRoot=str(model_root))
            transcribe = request(
                "transcribe",
                audioPath=str(audio_path),
                allowedRoot=str(audio_root),
                language="English",
                context="LocalScribe vocabulary",
            )
            health = request("health")
            shutdown = request("shutdown")
            messages, errors, exit_code = self.run_protocol(
                encode_requests(load, transcribe, health, shutdown),
                installer=lambda _path: model_directory,
                factory=lambda _path, _compute: runtime,
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(errors, "")
            self.assertEqual(messages[1]["modelId"], MODEL_ID)
            self.assertEqual(messages[1]["tier"], "medium")
            self.assertEqual(messages[1]["computeType"], "int8_float16")
            self.assertEqual(messages[2]["text"], "Hello from CUDA.")
            self.assertEqual(messages[2]["language"], "en")
            self.assertIsInstance(messages[2]["inferenceMs"], int)
            self.assertEqual(messages[3], {"type": "health", "id": health["id"], "ready": True})
            self.assertEqual(
                runtime.calls,
                [(audio_path.resolve(), "en", "LocalScribe vocabulary")],
            )

    def test_device_info_reports_measured_nvml_values(self) -> None:
        info_request = request("device_info")
        shutdown = request("shutdown")
        messages, errors, exit_code = self.run_protocol(
            encode_requests(info_request, shutdown),
            device_info_provider=lambda: DeviceInfo(
                "NVIDIA GeForce RTX 4090",
                25_769_803_776,
                20_000_000_000,
            ),
        )

        self.assertEqual(exit_code, 0)
        self.assertEqual(errors, "")
        self.assertEqual(
            messages[1],
            {
                "type": "device_info",
                "id": info_request["id"],
                "acceleratorKind": "nvidia-cuda",
                "deviceName": "NVIDIA GeForce RTX 4090",
                "totalVramBytes": 25_769_803_776,
                "freeVramBytes": 20_000_000_000,
                "memoryBasis": "nvml-current",
            },
        )

    def test_rejects_windows_operations_off_windows_before_dependencies(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            load = request("load_model", modelId=MODEL_ID, modelRoot=temporary)
            device_info = request("device_info")
            shutdown = request("shutdown")
            messages, errors, _exit_code = self.run_protocol(
                encode_requests(load, device_info, shutdown),
                installer=lambda _path: self.fail("installer must not run"),
                factory=lambda _path, _compute: self.fail("factory must not run"),
                device_info_provider=lambda: self.fail("device provider must not run"),
                platform_name="darwin",
            )

            self.assertEqual(messages[1]["code"], "windows_only")
            self.assertEqual(messages[2]["code"], "windows_only")
            self.assertEqual(errors.count("windows_only"), 2)

    def test_rejects_unapproved_model(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            load = request("load_model", modelId="other/model", modelRoot=temporary)
            shutdown = request("shutdown")
            messages, _errors, _exit_code = self.run_protocol(encode_requests(load, shutdown))
            self.assertEqual(messages[1]["code"], "model_not_allowed")

    def test_requires_an_explicit_model_download_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            load = {
                "type": "load_model",
                "id": str(uuid.uuid4()),
                "modelId": MODEL_ID,
                "modelRoot": temporary,
                "tier": "medium",
                "computeType": "int8_float16",
            }
            shutdown = request("shutdown")
            messages, _errors, _exit_code = self.run_protocol(encode_requests(load, shutdown))
            self.assertEqual(messages[1]["code"], "allow_download_required")

    def test_forbids_implicit_download_when_model_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            installer_called = False

            def installer(_path: Path) -> Path:
                nonlocal installer_called
                installer_called = True
                return Path(temporary) / "unexpected"

            load = request(
                "load_model",
                modelId=MODEL_ID,
                modelRoot=temporary,
                allowDownload=False,
            )
            shutdown = request("shutdown")
            messages, _errors, _exit_code = self.run_protocol(
                encode_requests(load, shutdown),
                installer=installer,
            )
            self.assertEqual(messages[1]["code"], "model_not_installed")
            self.assertFalse(installer_called)

    def test_rejects_audio_outside_allowed_root_and_remains_healthy(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model_root = root / "models"
            model_root.mkdir()
            model_directory = write_test_model(model_root / "installed")
            allowed_root = root / "allowed"
            allowed_root.mkdir()
            outside_root = root / "outside"
            outside_root.mkdir()
            outside_audio = outside_root / "utterance.wav"
            write_wav(outside_audio)
            runtime = FakeRuntime()
            load = request("load_model", modelId=MODEL_ID, modelRoot=str(model_root))
            transcribe = request(
                "transcribe",
                audioPath=str(outside_audio),
                allowedRoot=str(allowed_root),
                language="auto",
                context="",
            )
            health = request("health")
            shutdown = request("shutdown")
            messages, _errors, _exit_code = self.run_protocol(
                encode_requests(load, transcribe, health, shutdown),
                installer=lambda _path: model_directory,
                factory=lambda _path, _compute: runtime,
            )

            self.assertEqual(messages[2]["code"], "audio_path_not_allowed")
            self.assertEqual(messages[3], {"type": "health", "id": health["id"], "ready": True})
            self.assertEqual(runtime.calls, [])

    def test_rejects_wrong_wav_format(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model_root = root / "models"
            model_root.mkdir()
            model_directory = write_test_model(model_root / "installed")
            audio_root = root / "audio"
            audio_root.mkdir()
            audio_path = audio_root / "stereo.wav"
            write_wav(audio_path, channels=2)
            load = request("load_model", modelId=MODEL_ID, modelRoot=str(model_root))
            transcribe = request(
                "transcribe",
                audioPath=str(audio_path),
                allowedRoot=str(audio_root),
                language="auto",
                context="",
            )
            shutdown = request("shutdown")
            messages, _errors, _exit_code = self.run_protocol(
                encode_requests(load, transcribe, shutdown),
                installer=lambda _path: model_directory,
                factory=lambda _path, _compute: FakeRuntime(),
            )
            self.assertEqual(messages[2]["code"], "invalid_audio_format")

    def test_normalizes_language_alias_and_rejects_unknown_language(self) -> None:
        self.assertEqual(worker_module._normalize_language("Filipino"), "tl")
        self.assertEqual(worker_module._normalize_language("PT"), "pt")
        self.assertIsNone(worker_module._normalize_language("automatic"))
        with self.assertRaises(WorkerError) as raised:
            worker_module._normalize_language("Klingon")
        self.assertEqual(raised.exception.code, "invalid_language")

    def test_rejects_oversized_ndjson_line_and_continues(self) -> None:
        oversized = b"{" + b"x" * MAX_REQUEST_BYTES + b"}\n"
        shutdown = request("shutdown")
        stream = io.BytesIO(oversized + json.dumps(shutdown).encode("utf-8") + b"\n")
        messages, _errors, exit_code = self.run_protocol(stream)
        self.assertEqual(exit_code, 0)
        self.assertEqual(messages[1]["code"], "request_too_large")
        self.assertEqual(messages[2]["type"], "shutdown")


class ModelIntegrityTests(unittest.TestCase):
    def test_manifest_identity_revision_allowlist_and_total(self) -> None:
        self.assertEqual(MODEL_ID, "Systran/faster-whisper-large-v3")
        self.assertEqual(MODEL_REVISION, "edaa852ec7e145841d8ffdb056a99866b5f0a478")
        self.assertEqual(MODEL_DIRECTORY_NAME, "faster-whisper-large-v3-edaa852")
        self.assertEqual(
            set(MODEL_FILES),
            {
                "config.json",
                "model.bin",
                "preprocessor_config.json",
                "tokenizer.json",
                "vocabulary.json",
            },
        )
        self.assertEqual(sum(metadata["bytes"] for metadata in MODEL_FILES.values()), 3_090_835_702)

    def test_model_verification_rejects_tampering_and_unexpected_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary, patch.object(
            worker_module, "MODEL_FILES", TEST_MODEL_FILES
        ):
            model_directory = write_test_model(Path(temporary))
            self.assertTrue(worker_module._valid_model_directory(model_directory))

            (model_directory / "model.bin").write_bytes(b"other")
            self.assertFalse(worker_module._valid_model_directory(model_directory))
            (model_directory / "model.bin").write_bytes(TEST_MODEL_BYTES)

            (model_directory / "README.md").write_text("unexpected", encoding="utf-8")
            self.assertFalse(worker_module._valid_model_directory(model_directory))
            (model_directory / "README.md").unlink()

            (model_directory / "model.bin").unlink()
            (model_directory / "model.bin").mkdir()
            self.assertFalse(worker_module._valid_model_directory(model_directory))

    def test_model_verification_rejects_symlinked_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary, patch.object(
            worker_module, "MODEL_FILES", TEST_MODEL_FILES
        ):
            root = Path(temporary)
            target = root / "target.bin"
            target.write_bytes(TEST_MODEL_BYTES)
            model_directory = root / "model"
            model_directory.mkdir()
            try:
                (model_directory / "model.bin").symlink_to(target)
            except OSError as error:
                self.skipTest(f"symlinks unavailable: {error}")
            self.assertFalse(worker_module._valid_model_directory(model_directory))

    def test_explicit_download_uses_pinned_revision_no_token_and_atomic_activation(self) -> None:
        calls: list[dict[str, Any]] = []

        def snapshot_download(**kwargs: Any) -> str:
            calls.append(kwargs)
            staging = Path(kwargs["local_dir"])
            (staging / "model.bin").write_bytes(TEST_MODEL_BYTES)
            (staging / ".cache").mkdir()
            (staging / ".cache" / "transfer.json").write_text("{}", encoding="utf-8")
            return str(staging)

        fake_hub = types.SimpleNamespace(snapshot_download=snapshot_download)
        with tempfile.TemporaryDirectory() as temporary, patch.object(
            worker_module, "MODEL_FILES", TEST_MODEL_FILES
        ), patch.object(worker_module, "MIN_FREE_DISK_BYTES", 0), patch.dict(
            sys.modules, {"huggingface_hub": fake_hub}
        ):
            root = Path(temporary)
            old_directory = root / MODEL_DIRECTORY_NAME
            old_directory.mkdir()
            (old_directory / "tampered.bin").write_bytes(b"bad")

            installed = worker_module.ensure_model(root)

            self.assertEqual(installed, old_directory.resolve())
            self.assertTrue(worker_module._valid_model_directory(installed))
            self.assertEqual(set(path.name for path in installed.iterdir()), {"model.bin"})
            self.assertFalse(any(path.name.startswith(".faster-whisper-") for path in root.iterdir()))

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["repo_id"], MODEL_ID)
        self.assertEqual(calls[0]["revision"], MODEL_REVISION)
        self.assertEqual(calls[0]["allow_patterns"], ["model.bin"])
        self.assertIs(calls[0]["token"], False)

    def test_valid_installed_model_never_calls_network_installer(self) -> None:
        fake_hub = types.SimpleNamespace(
            snapshot_download=lambda **_kwargs: self.fail("download must not run")
        )
        with tempfile.TemporaryDirectory() as temporary, patch.object(
            worker_module, "MODEL_FILES", TEST_MODEL_FILES
        ), patch.dict(sys.modules, {"huggingface_hub": fake_hub}):
            root = Path(temporary)
            expected = write_test_model(root / MODEL_DIRECTORY_NAME)
            self.assertEqual(worker_module.ensure_model(root), expected.resolve())


class FasterWhisperRuntimeTests(unittest.TestCase):
    def test_load_is_local_only_cuda_and_validates_supported_compute_type(self) -> None:
        calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

        class WhisperModel:
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                calls.append((args, kwargs))

        fake_faster_whisper = types.SimpleNamespace(WhisperModel=WhisperModel)
        fake_ctranslate2 = types.SimpleNamespace(
            get_cuda_device_count=lambda: 1,
            get_supported_compute_types=lambda device, index: {
                "float16",
                "int8_float16",
                "int8",
            }
            if (device, index) == ("cuda", 0)
            else set(),
        )
        fake_numpy = FakeNumpyModule()
        with tempfile.TemporaryDirectory() as temporary, patch.object(
            worker_module, "_valid_model_directory", return_value=True
        ), patch.object(worker_module, "_configure_windows_cuda_dlls"), patch.dict(
            sys.modules,
            {
                "ctranslate2": fake_ctranslate2,
                "faster_whisper": fake_faster_whisper,
                "numpy": fake_numpy,
            },
        ):
            runtime = FasterWhisperRuntime.load(Path(temporary), "int8_float16")

        self.assertEqual(runtime.compute_type, "int8_float16")
        self.assertEqual(calls[0][0], (temporary,))
        self.assertEqual(
            calls[0][1],
            {
                "device": "cuda",
                "device_index": 0,
                "compute_type": "int8_float16",
                "local_files_only": True,
            },
        )

    def test_load_rejects_compute_type_not_supported_by_gpu(self) -> None:
        fake_ctranslate2 = types.SimpleNamespace(
            get_cuda_device_count=lambda: 1,
            get_supported_compute_types=lambda _device, _index: {"float16"},
        )
        fake_faster_whisper = types.SimpleNamespace(
            WhisperModel=lambda *_args, **_kwargs: self.fail("model must not load")
        )
        fake_numpy = FakeNumpyModule()
        with tempfile.TemporaryDirectory() as temporary, patch.object(
            worker_module, "_valid_model_directory", return_value=True
        ), patch.object(worker_module, "_configure_windows_cuda_dlls"), patch.dict(
            sys.modules,
            {
                "ctranslate2": fake_ctranslate2,
                "faster_whisper": fake_faster_whisper,
                "numpy": fake_numpy,
            },
        ):
            with self.assertRaises(WorkerError) as raised:
                FasterWhisperRuntime.load(Path(temporary), "int8")
        self.assertEqual(raised.exception.code, "compute_type_unsupported")

    def test_transcribe_disables_timestamps_and_fully_materializes_final_text(self) -> None:
        iteration_completed = False
        transcribe_calls: list[tuple[Any, dict[str, Any]]] = []

        class Segment:
            def __init__(self, text: str) -> None:
                self.text = text

            def __getattr__(self, name: str) -> Any:
                if name in {"start", "end", "words"}:
                    self.fail_unused_metadata(name)
                raise AttributeError(name)

            @staticmethod
            def fail_unused_metadata(name: str) -> None:
                raise AssertionError(f"unused segment metadata was accessed: {name}")

        def segments():
            nonlocal iteration_completed
            yield Segment(" Hello")
            yield Segment(" world.")
            iteration_completed = True

        class Model:
            def transcribe(self, audio: Any, **kwargs: Any) -> tuple[Any, Any]:
                transcribe_calls.append((audio, kwargs))
                return segments(), types.SimpleNamespace(language="en")

        with tempfile.TemporaryDirectory() as temporary:
            audio_path = Path(temporary) / "audio.wav"
            write_wav(audio_path)
            runtime = FasterWhisperRuntime(Model(), FakeNumpyModule(), "float16")

            result = runtime.transcribe(
                audio_path,
                language="en",
                context="LocalScribe vocabulary",
            )

        self.assertTrue(iteration_completed)
        self.assertEqual(result.text, "Hello world.")
        self.assertEqual(result.language, "en")
        audio, kwargs = transcribe_calls[0]
        self.assertIsInstance(audio, FakeArray)
        self.assertEqual(audio.dtype, "float32")
        self.assertEqual(audio.shape, (160,))
        self.assertEqual(
            kwargs,
            {
                "language": "en",
                "initial_prompt": "LocalScribe vocabulary",
                "beam_size": 5,
                "word_timestamps": False,
            },
        )

    def test_runtime_revalidates_wav_before_creating_numpy_input(self) -> None:
        model = types.SimpleNamespace(
            transcribe=lambda *_args, **_kwargs: self.fail("model must not run")
        )
        with tempfile.TemporaryDirectory() as temporary:
            audio_path = Path(temporary) / "stereo.wav"
            write_wav(audio_path, channels=2)
            runtime = FasterWhisperRuntime(model, FakeNumpyModule(), "int8")
            with self.assertRaises(WorkerError) as raised:
                runtime.transcribe(audio_path, language=None, context="")
        self.assertEqual(raised.exception.code, "invalid_audio_format")

    def test_close_unloads_ctranslate2_model_and_is_idempotent(self) -> None:
        unloaded = 0

        class InnerModel:
            def unload_model(self) -> None:
                nonlocal unloaded
                unloaded += 1

        model = types.SimpleNamespace(model=InnerModel())
        runtime = FasterWhisperRuntime(model, object(), "int8")
        runtime.close()
        runtime.close()
        self.assertEqual(unloaded, 1)

    def test_query_device_info_reads_current_nvml_memory_and_shuts_down(self) -> None:
        events: list[str] = []
        fake_pynvml = types.SimpleNamespace(
            nvmlInit=lambda: events.append("init"),
            nvmlShutdown=lambda: events.append("shutdown"),
            nvmlDeviceGetCount=lambda: 1,
            nvmlDeviceGetHandleByIndex=lambda index: f"gpu-{index}",
            nvmlDeviceGetName=lambda _handle: b"NVIDIA RTX 5000 Ada",
            nvmlDeviceGetMemoryInfo=lambda _handle: types.SimpleNamespace(
                total=34_359_738_368,
                free=28_000_000_000,
            ),
        )
        with patch.dict(sys.modules, {"pynvml": fake_pynvml}):
            info = worker_module.query_device_info()

        self.assertEqual(
            info,
            DeviceInfo("NVIDIA RTX 5000 Ada", 34_359_738_368, 28_000_000_000),
        )
        self.assertEqual(events, ["init", "shutdown"])


if __name__ == "__main__":
    unittest.main()
