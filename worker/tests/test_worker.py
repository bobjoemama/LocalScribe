from __future__ import annotations

import hashlib
import io
import json
import tempfile
import unittest
import uuid
import wave
from pathlib import Path
from typing import Any
from unittest.mock import patch

import numpy as np

import localscribe_worker.worker as worker_module
from localscribe_worker.worker import (
    MAX_REQUEST_BYTES,
    HardwareInfo,
    MLXWhisperRuntime,
    ModelFile,
    ModelManifest,
    TIER_SPECS,
    TranscriptionResult,
    WorkerError,
    ensure_model,
    run_worker,
)


def request(message_type: str, **fields: Any) -> dict[str, Any]:
    return {"type": message_type, "id": str(uuid.uuid4()), **fields}


def load_request(
    tier: str,
    model_root: Path,
    *,
    allow_download: bool = True,
    **overrides: Any,
) -> dict[str, Any]:
    spec = TIER_SPECS[tier]
    fields: dict[str, Any] = {
        "tier": tier,
        "modelId": spec.model_id,
        "computeType": spec.compute_type,
        "modelRoot": str(model_root),
        "allowDownload": allow_download,
    }
    fields.update(overrides)
    return request("load_model", **fields)


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


def tiny_manifest() -> ModelManifest:
    config = b'{"model_type":"whisper"}'
    weights = b"tiny-test-weights"
    return ModelManifest(
        tier="low",
        backend="MLX Whisper",
        display_name="Test Whisper",
        model_id="example/whisper",
        storage_directory="test-whisper",
        revision="a" * 40,
        license="MIT",
        files={
            "config.json": ModelFile(
                bytes=len(config),
                sha256=hashlib.sha256(config).hexdigest(),
            ),
            "weights.npz": ModelFile(
                bytes=len(weights),
                sha256=hashlib.sha256(weights).hexdigest(),
            ),
        },
    )


def write_tiny_model(path: Path, manifest: ModelManifest) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "config.json").write_bytes(b'{"model_type":"whisper"}')
    (path / "weights.npz").write_bytes(b"tiny-test-weights")


class FakeRuntime:
    def __init__(self, label: str = "fake") -> None:
        self.label = label
        self.calls: list[tuple[bytes, str | None, str]] = []
        self.closed = False

    def transcribe(
        self,
        pcm16: bytes,
        *,
        language: str | None,
        context: str,
    ) -> TranscriptionResult:
        self.calls.append((pcm16, language, context))
        return TranscriptionResult(
            text=f"Hello from {self.label}.",
            language=language or "en",
        )

    def close(self) -> None:
        self.closed = True


class WorkerProtocolTests(unittest.TestCase):
    def run_protocol(
        self,
        input_stream: io.BytesIO,
        *,
        installer=None,
        factory=None,
        hardware_probe=None,
        platform_name: str = "darwin",
        machine_name: str = "arm64",
    ) -> tuple[list[dict[str, Any]], str, int]:
        output = io.StringIO()
        errors = io.StringIO()
        kwargs: dict[str, Any] = {
            "input_stream": input_stream,
            "output_stream": output,
            "error_stream": errors,
            "platform_name": platform_name,
            "machine_name": machine_name,
        }
        if installer is not None:
            kwargs["model_installer"] = installer
        if factory is not None:
            kwargs["runtime_factory"] = factory
        if hardware_probe is not None:
            kwargs["hardware_probe"] = hardware_probe
        exit_code = run_worker(**kwargs)
        return parse_output(output), errors.getvalue(), exit_code

    def test_hello_health_device_info_and_shutdown_without_loading(self) -> None:
        health = request("health")
        device_info = request("device_info")
        shutdown = request("shutdown")
        hardware = HardwareInfo(
            chip="Apple M4 Max",
            total_bytes=48 * 1024**3,
            available_bytes=31 * 1024**3,
        )
        messages, errors, exit_code = self.run_protocol(
            encode_requests(health, device_info, shutdown),
            hardware_probe=lambda: hardware,
        )

        self.assertEqual(exit_code, 0)
        self.assertEqual(errors, "")
        self.assertEqual(
            messages[0],
            {
                "type": "hello",
                "protocol": 1,
                "backend": "mlx-whisper",
                "version": "0.4.3",
            },
        )
        self.assertEqual(
            messages[1],
            {"type": "health", "id": health["id"], "ready": False},
        )
        self.assertEqual(
            messages[2],
            {
                "type": "device_info",
                "id": device_info["id"],
                "hardware": {
                    "platform": "darwin",
                    "architecture": "arm64",
                    "chip": "Apple M4 Max",
                    "unifiedMemory": {
                        "totalBytes": 48 * 1024**3,
                        "availableBytes": 31 * 1024**3,
                        "availableIsEstimated": True,
                        "memoryBasis": "vm_stat_free_inactive_speculative",
                    },
                },
            },
        )
        self.assertEqual(
            messages[3],
            {"type": "shutdown", "id": shutdown["id"]},
        )

    def test_load_transcribe_switch_tiers_and_unload(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model_root = root / "models"
            model_root.mkdir()
            audio_root = root / "audio"
            audio_root.mkdir()
            audio_path = audio_root / "utterance.wav"
            write_wav(audio_path)
            runtimes: dict[str, FakeRuntime] = {}
            installer_calls: list[tuple[str, bool]] = []

            def installer(
                path: Path,
                manifest: ModelManifest,
                allow_download: bool,
            ) -> Path:
                installer_calls.append((manifest.tier, allow_download))
                installed = path / manifest.storage_directory
                installed.mkdir(exist_ok=True)
                return installed

            def factory(path: Path, spec: Any) -> FakeRuntime:
                self.assertEqual(path.name, spec.storage_directory)
                runtime = FakeRuntime(spec.tier)
                runtimes[spec.tier] = runtime
                return runtime

            load_low = load_request("low", model_root)
            transcribe = request(
                "transcribe",
                audioPath=str(audio_path),
                allowedRoot=str(audio_root),
                language="English",
                context="LocalScribe vocabulary",
            )
            load_medium = load_request("medium", model_root)
            shutdown = request("shutdown")
            messages, errors, exit_code = self.run_protocol(
                encode_requests(load_low, transcribe, load_medium, shutdown),
                installer=installer,
                factory=factory,
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(errors, "")
            self.assertEqual(installer_calls, [("low", True), ("medium", True)])
            self.assertEqual(
                messages[1],
                {
                    "type": "model_ready",
                    "id": load_low["id"],
                    "tier": "low",
                    "modelId": TIER_SPECS["low"].model_id,
                    "computeType": "int4",
                    "loadMs": messages[1]["loadMs"],
                },
            )
            self.assertEqual(messages[2]["type"], "final")
            self.assertEqual(messages[2]["text"], "Hello from low.")
            self.assertEqual(messages[2]["language"], "en")
            self.assertEqual(len(runtimes["low"].calls[0][0]), 320)
            self.assertEqual(runtimes["low"].calls[0][1:], ("en", "LocalScribe vocabulary"))
            self.assertTrue(runtimes["low"].closed)
            self.assertEqual(messages[3]["tier"], "medium")
            self.assertEqual(messages[3]["computeType"], "int8")
            self.assertTrue(runtimes["medium"].closed)

    def test_same_tier_and_root_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary) / "models"
            model_root.mkdir()
            install_count = 0
            runtime = FakeRuntime()

            def installer(
                path: Path,
                manifest: ModelManifest,
                _allow_download: bool,
            ) -> Path:
                nonlocal install_count
                install_count += 1
                installed = path / manifest.storage_directory
                installed.mkdir(exist_ok=True)
                return installed

            first = load_request("high", model_root)
            second = load_request("high", model_root, allow_download=False)
            shutdown = request("shutdown")
            messages, _errors, _exit_code = self.run_protocol(
                encode_requests(first, second, shutdown),
                installer=installer,
                factory=lambda _path, _spec: runtime,
            )
            self.assertEqual(install_count, 1)
            self.assertEqual(messages[2]["loadMs"], 0)
            self.assertTrue(runtime.closed)

    def test_rejects_tier_model_or_compute_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary)
            wrong_model = load_request(
                "low",
                model_root,
                modelId=TIER_SPECS["high"].model_id,
            )
            wrong_compute = load_request(
                "medium",
                model_root,
                computeType="float16",
            )
            unknown_tier = load_request("low", model_root)
            unknown_tier["tier"] = "ultra"
            shutdown = request("shutdown")
            messages, _errors, _exit_code = self.run_protocol(
                encode_requests(
                    wrong_model,
                    wrong_compute,
                    unknown_tier,
                    shutdown,
                ),
                installer=lambda *_args: self.fail("installer must not run"),
                factory=lambda *_args: self.fail("factory must not run"),
            )
            self.assertEqual([message["code"] for message in messages[1:4]], [
                "model_not_allowed",
                "model_not_allowed",
                "model_not_allowed",
            ])

    def test_requires_explicit_download_policy_and_forbids_implicit_download(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary)
            missing_policy = load_request("low", model_root)
            del missing_policy["allowDownload"]
            no_download = load_request(
                "low",
                model_root,
                allow_download=False,
            )
            shutdown = request("shutdown")
            messages, _errors, _exit_code = self.run_protocol(
                encode_requests(missing_policy, no_download, shutdown),
                installer=lambda *_args: self.fail("installer must not run"),
                factory=lambda *_args: self.fail("factory must not run"),
            )
            self.assertEqual(messages[1]["code"], "invalid_request")
            self.assertEqual(messages[2]["code"], "model_not_installed")

    def test_transcribe_rejects_symlink_and_outside_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model_root = root / "models"
            model_root.mkdir()
            audio_root = root / "audio"
            audio_root.mkdir()
            outside = root / "outside.wav"
            write_wav(outside)
            symlink = audio_root / "linked.wav"
            symlink.symlink_to(outside)

            def installer(
                path: Path,
                manifest: ModelManifest,
                _allow_download: bool,
            ) -> Path:
                installed = path / manifest.storage_directory
                installed.mkdir(exist_ok=True)
                return installed

            load = load_request("low", model_root)
            linked_request = request(
                "transcribe",
                audioPath=str(symlink),
                allowedRoot=str(audio_root),
                language="auto",
                context="",
            )
            outside_request = request(
                "transcribe",
                audioPath=str(outside),
                allowedRoot=str(audio_root),
                language="auto",
                context="",
            )
            shutdown = request("shutdown")
            messages, _errors, _exit_code = self.run_protocol(
                encode_requests(load, linked_request, outside_request, shutdown),
                installer=installer,
                factory=lambda *_args: FakeRuntime(),
            )
            self.assertEqual(messages[2]["code"], "invalid_audio_file")
            self.assertEqual(messages[3]["code"], "audio_path_not_allowed")

    def test_rejects_wrong_wav_format_and_overlong_context(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model_root = root / "models"
            model_root.mkdir()
            audio_root = root / "audio"
            audio_root.mkdir()
            audio_path = audio_root / "stereo.wav"
            write_wav(audio_path, channels=2)

            def installer(
                path: Path,
                manifest: ModelManifest,
                _allow_download: bool,
            ) -> Path:
                installed = path / manifest.storage_directory
                installed.mkdir(exist_ok=True)
                return installed

            load = load_request("low", model_root)
            wrong_format = request(
                "transcribe",
                audioPath=str(audio_path),
                allowedRoot=str(audio_root),
                language="auto",
                context="",
            )
            overlong = request(
                "transcribe",
                audioPath=str(audio_path),
                allowedRoot=str(audio_root),
                language="auto",
                context="x" * 4_001,
            )
            shutdown = request("shutdown")
            messages, _errors, _exit_code = self.run_protocol(
                encode_requests(load, wrong_format, overlong, shutdown),
                installer=installer,
                factory=lambda *_args: FakeRuntime(),
            )
            self.assertEqual(messages[2]["code"], "invalid_audio_format")
            # Audio validation runs before context validation, so use a valid
            # WAV to isolate the context boundary.
            write_wav(audio_path)
            messages, _errors, _exit_code = self.run_protocol(
                encode_requests(
                    load,
                    overlong,
                    request("shutdown"),
                ),
                installer=installer,
                factory=lambda *_args: FakeRuntime(),
            )
            self.assertEqual(messages[2]["code"], "invalid_context")

    def test_rejects_oversized_duplicate_noncanonical_and_extra_fields(self) -> None:
        oversized = b"{" + b"x" * MAX_REQUEST_BYTES + b"}\n"
        duplicate_id = str(uuid.uuid4())
        duplicate = (
            '{"type":"health","id":"'
            + duplicate_id
            + '","id":"'
            + duplicate_id
            + '"}\n'
        ).encode("utf-8")
        noncanonical = {
            "type": "health",
            "id": str(uuid.uuid4()).upper(),
        }
        extra = request("health", unexpected=True)
        shutdown = request("shutdown")
        stream = io.BytesIO(
            oversized
            + duplicate
            + json.dumps(noncanonical).encode("utf-8")
            + b"\n"
            + json.dumps(extra).encode("utf-8")
            + b"\n"
            + json.dumps(shutdown).encode("utf-8")
            + b"\n"
        )
        messages, errors, exit_code = self.run_protocol(stream)
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            [message["code"] for message in messages[1:5]],
            [
                "request_too_large",
                "invalid_json",
                "invalid_request_id",
                "invalid_request",
            ],
        )
        self.assertNotIn("Traceback", errors)
        self.assertEqual(messages[5]["type"], "shutdown")

    def test_unexpected_failure_is_bounded_and_does_not_expose_exception(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary)

            def installer(
                path: Path,
                manifest: ModelManifest,
                _allow_download: bool,
            ) -> Path:
                installed = path / manifest.storage_directory
                installed.mkdir()
                return installed

            load = load_request("low", model_root)
            shutdown = request("shutdown")
            messages, errors, _exit_code = self.run_protocol(
                encode_requests(load, shutdown),
                installer=installer,
                factory=lambda *_args: (_ for _ in ()).throw(
                    RuntimeError("/private/secret/model/path")
                ),
            )
            self.assertEqual(messages[1], {
                "type": "error",
                "id": load["id"],
                "code": "internal_error",
                "message": "request failed",
            })
            self.assertNotIn("secret", errors)
            self.assertNotIn("Traceback", errors)
            self.assertIn("internal_error:RuntimeError", errors)

    def test_root_directory_and_non_apple_platform_are_rejected(self) -> None:
        root_request = load_request("low", Path("/"))
        shutdown = request("shutdown")
        messages, _errors, _exit_code = self.run_protocol(
            encode_requests(root_request, shutdown),
        )
        self.assertEqual(messages[1]["code"], "invalid_model_root")

        with tempfile.TemporaryDirectory() as temporary:
            messages, _errors, _exit_code = self.run_protocol(
                encode_requests(
                    load_request("low", Path(temporary)),
                    request("shutdown"),
                ),
                platform_name="linux",
                machine_name="x86_64",
            )
            self.assertEqual(messages[1]["code"], "apple_silicon_only")


class ModelInstallationTests(unittest.TestCase):
    def test_staged_install_uses_only_pinned_files_and_promotes_verified_directory(self) -> None:
        manifest = tiny_manifest()
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary)
            observed: dict[str, Any] = {}

            def downloader(**kwargs: Any) -> None:
                observed.update(kwargs)
                staging = Path(kwargs["local_dir"])
                write_tiny_model(staging, manifest)
                metadata = staging / ".cache" / "huggingface"
                metadata.mkdir(parents=True)
                (metadata / "download.json").write_text("{}", encoding="utf-8")

            installed = ensure_model(
                model_root,
                manifest,
                True,
                snapshot_downloader=downloader,
            )
            self.assertEqual(
                installed,
                model_root.resolve() / manifest.storage_directory,
            )
            self.assertEqual(observed["repo_id"], manifest.model_id)
            self.assertEqual(observed["revision"], manifest.revision)
            self.assertEqual(observed["allow_patterns"], ["config.json", "weights.npz"])
            self.assertEqual(observed["max_workers"], 4)
            self.assertIs(observed["token"], False)
            self.assertEqual(Path(observed["local_dir"]).parent, model_root.resolve())
            self.assertIn("staging", Path(observed["local_dir"]).name)
            self.assertEqual(
                {entry.name for entry in installed.iterdir()},
                {"config.json", "weights.npz"},
            )
            self.assertFalse(any("staging" in entry.name for entry in model_root.iterdir()))

    def test_corrupt_staged_download_is_removed_and_never_promoted(self) -> None:
        manifest = tiny_manifest()
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary)

            def downloader(**kwargs: Any) -> None:
                staging = Path(kwargs["local_dir"])
                write_tiny_model(staging, manifest)
                (staging / "weights.npz").write_bytes(b"corrupt-test-data")

            with self.assertRaisesRegex(WorkerError, "downloaded model verification failed"):
                ensure_model(
                    model_root,
                    manifest,
                    True,
                    snapshot_downloader=downloader,
                )
            self.assertFalse((model_root / manifest.storage_directory).exists())
            self.assertEqual(list(model_root.iterdir()), [])

    def test_model_validation_rejects_symlink_and_extra_file(self) -> None:
        manifest = tiny_manifest()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model = root / manifest.storage_directory
            write_tiny_model(model, manifest)
            self.assertTrue(worker_module._valid_model_directory(model, manifest))

            external = root / "external.npz"
            external.write_bytes(b"tiny-test-weights")
            (model / "weights.npz").unlink()
            (model / "weights.npz").symlink_to(external)
            self.assertFalse(worker_module._valid_model_directory(model, manifest))

            (model / "weights.npz").unlink()
            (model / "weights.npz").write_bytes(b"tiny-test-weights")
            (model / "unexpected.bin").write_bytes(b"x")
            self.assertFalse(worker_module._valid_model_directory(model, manifest))

    def test_packaged_catalog_has_exact_three_whisper_manifests_and_files(self) -> None:
        self.assertEqual(set(TIER_SPECS), {"high", "medium", "low"})
        self.assertEqual(
            {spec.manifest_filename for spec in TIER_SPECS.values()},
            {
                "whisper-large-v3-mlx.json",
                "whisper-large-v3-mlx-8bit.json",
                "whisper-large-v3-mlx-4bit.json",
            },
        )
        self.assertEqual(
            [TIER_SPECS[tier].compute_type for tier in ("high", "medium", "low")],
            ["float16", "int8", "int4"],
        )
        for tier, manifest in worker_module.MODEL_MANIFESTS.items():
            spec = TIER_SPECS[tier]
            self.assertEqual(manifest.model_id, spec.model_id)
            self.assertEqual(manifest.revision, spec.revision)
            self.assertEqual(set(manifest.files), {"config.json", "weights.npz"})
            for model_file in manifest.files.values():
                self.assertGreater(model_file.bytes, 0)
                self.assertRegex(model_file.sha256, r"^[a-f0-9]{64}$")


class RuntimeAndHardwareTests(unittest.TestCase):
    def test_runtime_passes_pcm_array_and_verified_local_path_to_mlx_whisper(self) -> None:
        class FakeMetal:
            def clear_cache(self) -> None:
                pass

        class FakeMlx:
            metal = FakeMetal()

            @staticmethod
            def synchronize() -> None:
                pass

        class Holder:
            model = None
            model_path = None

        captured: dict[str, Any] = {}
        model = object()
        Holder.model = model
        Holder.model_path = "/verified/local/model"

        def transcribe(waveform: Any, **kwargs: Any) -> dict[str, Any]:
            captured["waveform"] = waveform
            captured["kwargs"] = kwargs
            return {"text": "Local audio.", "language": "en"}

        runtime = MLXWhisperRuntime(
            mlx_module=FakeMlx(),
            numpy_module=np,
            model_holder=Holder,
            transcribe_function=transcribe,
            model=model,
            model_path="/verified/local/model",
        )
        result = runtime.transcribe(
            b"\x00\x00\xff\x7f",
            language="en",
            context="Devesh LocalScribe",
        )
        self.assertEqual(result, TranscriptionResult("Local audio.", "en"))
        self.assertIsInstance(captured["waveform"], np.ndarray)
        self.assertEqual(
            captured["kwargs"],
            {
                "path_or_hf_repo": "/verified/local/model",
                "verbose": None,
                "language": "en",
                "initial_prompt": "Devesh LocalScribe",
                "fp16": True,
            },
        )
        runtime.close()
        self.assertIsNone(Holder.model)
        self.assertIsNone(Holder.model_path)

    def test_hardware_probe_parses_total_and_estimated_available_memory(self) -> None:
        outputs = {
            ("/usr/sbin/sysctl", "-n", "hw.memsize"): str(48 * 1024**3),
            ("/usr/bin/vm_stat",): "\n".join(
                [
                    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
                    "Pages free:                               1000.",
                    "Pages active:                             2000.",
                    "Pages inactive:                           3000.",
                    "Pages speculative:                         500.",
                ]
            ),
            ("/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"): "Apple M4 Max",
        }

        def command(args: list[str]) -> str:
            return outputs[tuple(args)]

        with patch.object(worker_module, "_run_read_only_command", command):
            hardware = worker_module.read_apple_hardware_info()
        self.assertEqual(hardware.chip, "Apple M4 Max")
        self.assertEqual(hardware.total_bytes, 48 * 1024**3)
        self.assertEqual(hardware.available_bytes, 4_500 * 16_384)


if __name__ == "__main__":
    unittest.main()
