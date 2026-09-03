from __future__ import annotations

import base64
import hashlib
import io
import json
import shutil
import stat
import tempfile
import unittest
import uuid
import wave
from pathlib import Path
from typing import Any
from unittest.mock import patch

import localscribe_worker.worker as worker_module
import numpy as np
from localscribe_worker.worker import (
    MAX_REQUEST_BYTES,
    TIER_SPECS,
    FluidAudioParakeetRuntime,
    HardwareInfo,
    MLXAudioRuntime,
    MLXWhisperRuntime,
    ModelFile,
    ModelManifest,
    TierSpec,
    TranscriptionResult,
    WorkerError,
    ensure_model,
    run_worker,
)
from tqdm.contrib.concurrent import thread_map


def request(message_type: str, **fields: Any) -> dict[str, Any]:
    return {"type": message_type, "id": str(uuid.uuid4()), **fields}


def tier_spec(tier: str, *, family: str = "v3") -> TierSpec:
    family_fragment = {
        "qwen": "Qwen3-ASR-1.7B",
        "qwen06": "Qwen3-ASR-0.6B",
        "parakeet": "parakeet-unified-en-0.6b-coreml",
    }.get(family, f"whisper-large-{family}-mlx")
    matches = [
        spec
        for spec in TIER_SPECS.values()
        if spec.tier == tier and family_fragment in spec.model_id
    ]
    if len(matches) != 1:
        raise AssertionError(f"missing unique {family}/{tier} catalog selection")
    return matches[0]


def load_request(
    tier: str,
    model_root: Path,
    *,
    allow_download: bool = False,
    family: str = "v3",
    asr_mode: str = "after-stop",
    **overrides: Any,
) -> dict[str, Any]:
    spec = tier_spec(tier, family=family)
    fields: dict[str, Any] = {
        "tier": tier,
        "modelId": spec.model_id,
        "computeType": spec.compute_type,
        "modelRoot": str(model_root),
        "allowDownload": allow_download,
        "asrMode": asr_mode,
    }
    fields.update(overrides)
    return request("load_model", **fields)


def install_request(
    tier: str,
    model_root: Path,
    *,
    allow_download: bool = True,
    family: str = "v3",
    **overrides: Any,
) -> dict[str, Any]:
    spec = tier_spec(tier, family=family)
    fields: dict[str, Any] = {
        "tier": tier,
        "modelId": spec.model_id,
        "computeType": spec.compute_type,
        "modelRoot": str(model_root),
        "allowDownload": allow_download,
    }
    fields.update(overrides)
    return request("install_model", **fields)


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
        family_id="example-whisper",
        artifact_id="example-whisper-test",
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


def nested_manifest() -> ModelManifest:
    files = {
        "metadata.json": b'{"format":"coreml"}',
        "encoder.mlmodelc/model.mil": b"coreml-model",
        "encoder.mlmodelc/weights/weight.bin": b"coreml-weights",
    }
    return ModelManifest(
        tier="medium",
        backend="FluidAudio CoreML / ANE",
        display_name="Test Parakeet",
        model_id="FluidInference/parakeet-unified-en-0.6b-coreml",
        family_id="parakeet-unified-en-0-6b",
        artifact_id="parakeet-test-int8",
        storage_directory="parakeet-unified-en-0-6b-coreml-int8",
        revision="b" * 40,
        license="CC-BY-4.0",
        files={
            name: ModelFile(bytes=len(contents), sha256=hashlib.sha256(contents).hexdigest())
            for name, contents in files.items()
        },
    )


def write_nested_model(path: Path, manifest: ModelManifest) -> None:
    contents = {
        "metadata.json": b'{"format":"coreml"}',
        "encoder.mlmodelc/model.mil": b"coreml-model",
        "encoder.mlmodelc/weights/weight.bin": b"coreml-weights",
    }
    for filename, data in contents.items():
        target = path / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


class FakeRuntime:
    def __init__(self, label: str = "fake", *, fail: bool = False) -> None:
        self.label = label
        self.calls: list[tuple[bytes, str | None, str]] = []
        self.closed = False
        self.releases = 0
        self.releases_at_transcribe_return: list[int] = []
        self._fail = fail

    def transcribe(
        self,
        pcm16: bytes,
        *,
        language: str | None,
        context: str,
    ) -> TranscriptionResult:
        self.calls.append((pcm16, language, context))
        self.releases_at_transcribe_return.append(self.releases)
        if self._fail:
            raise RuntimeError("transcription failed")
        return TranscriptionResult(
            text=f"Hello from {self.label}.",
            language=language or "en",
        )

    def release_transient_memory(self) -> None:
        self.releases += 1

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
        worker_role: str = "inference",
    ) -> tuple[list[dict[str, Any]], str, int]:
        output = io.StringIO()
        errors = io.StringIO()
        kwargs: dict[str, Any] = {
            "input_stream": input_stream,
            "output_stream": output,
            "error_stream": errors,
            "platform_name": platform_name,
            "machine_name": machine_name,
            "worker_role": worker_role,
        }
        if installer is not None:
            kwargs["model_installer"] = installer
        if factory is not None:
            kwargs["runtime_factory"] = factory
        if hardware_probe is not None:
            kwargs["hardware_probe"] = hardware_probe
        if installer is None:
            exit_code = run_worker(**kwargs)
        else:
            # Runtime-flow tests inject a lightweight installer rather than a
            # real model archive. Exact file/hash verification is separately
            # covered by ModelInstallationTests and install_model protocol tests.
            actual_validation = worker_module._valid_model_directory
            actual_identity_capture = worker_module._capture_model_tree_identity

            def model_is_available(
                path: Path,
                manifest: ModelManifest,
                **kwargs: Any,
            ) -> bool:
                if manifest.model_id == "example/whisper":
                    return actual_validation(path, manifest, **kwargs)
                return True

            def model_identity(
                path: Path,
                root: Path,
                manifest: ModelManifest,
            ) -> worker_module.ModelTreeIdentity:
                if manifest.model_id == "example/whisper":
                    return actual_identity_capture(path, root, manifest)
                # These runtime-flow doubles deliberately do not materialize
                # multi-gigabyte manifests. Identity/race behaviour uses the
                # real filesystem in the dedicated example/whisper tests.
                marker = sum(manifest.storage_directory.encode("utf-8"))
                return worker_module.ModelTreeIdentity(
                    root=(marker, 1, stat.S_IFDIR, 1, 1),
                    directory=(marker, 2, stat.S_IFDIR, 1, 1),
                    files=(),
                )

            with (
                patch.object(
                    worker_module,
                    "_valid_model_directory",
                    side_effect=model_is_available,
                ),
                patch.object(
                    worker_module,
                    "_capture_model_tree_identity",
                    side_effect=model_identity,
                ),
            ):
                exit_code = run_worker(**kwargs)
        return parse_output(output), errors.getvalue(), exit_code

    def test_parakeet_live_session_is_mode_bound_and_resets_after_finish(self) -> None:
        class FakeLiveRuntime(FluidAudioParakeetRuntime):
            def __init__(self) -> None:
                self._mode = "live"
                self.events: list[tuple[str, Any]] = []
                self.closed = False

            def begin_live(self, *, language: str | None, context: str) -> None:
                self.events.append(("begin", (language, context)))

            def append_live(self, pcm16: bytes) -> str:
                self.events.append(("append", pcm16))
                return "local partial"

            def finish_live(self) -> TranscriptionResult:
                self.events.append(("finish", None))
                return TranscriptionResult("local final", "en")

            def cancel_live(self) -> None:
                self.events.append(("cancel", None))

            def close(self) -> None:
                self.closed = True

        manifest = nested_manifest()
        spec = TierSpec(
            tier=manifest.tier,
            manifest_filename="parakeet-unified-en-0-6b-coreml-int8.json",
            model_id=manifest.model_id,
            family_id=manifest.family_id,
            artifact_id=manifest.artifact_id,
            revision=manifest.revision,
            storage_directory=manifest.storage_directory,
            compute_type="coreml-int8",
        )
        selection = (spec.model_id, spec.tier, spec.compute_type)
        runtime = FakeLiveRuntime()
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.dict(worker_module.TIER_SPECS, {selection: spec}),
            patch.dict(worker_module.MODEL_MANIFESTS, {selection: manifest}),
        ):
            model_root = Path(temporary)
            pcm16 = b"\x00\x00" * 160
            load = request(
                "load_model",
                tier=spec.tier,
                modelId=spec.model_id,
                computeType=spec.compute_type,
                modelRoot=str(model_root),
                allowDownload=False,
                asrMode="live",
            )
            messages, errors, exit_code = self.run_protocol(
                encode_requests(
                    load,
                    request("begin_live", language="en", context=""),
                    request("append_live", audioBase64=base64.b64encode(pcm16).decode("ascii")),
                    request("finish_live"),
                    request("shutdown"),
                ),
                installer=lambda root, _manifest, _allow: root / manifest.storage_directory,
                factory=lambda _path, _spec: runtime,
            )

        self.assertEqual(exit_code, 0)
        self.assertEqual(errors, "")
        self.assertEqual([message["type"] for message in messages], [
            "hello", "model_ready", "live_started", "partial", "final", "shutdown",
        ])
        self.assertEqual(messages[3]["text"], "local partial")
        self.assertEqual(messages[4]["text"], "local final")
        self.assertEqual(runtime.events, [
            ("begin", ("en", "")),
            ("append", pcm16),
            ("finish", None),
        ])
        self.assertTrue(runtime.closed)

    def test_live_mode_is_rejected_for_non_streaming_models(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            messages, _errors, exit_code = self.run_protocol(
                encode_requests(load_request("low", Path(temporary), asr_mode="live"))
            )
        self.assertEqual(exit_code, 0)
        self.assertEqual(messages[1]["code"], "invalid_asr_mode")

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
                "backend": "localscribe-mlx-asr",
                "version": "mlx-whisper/0.4.3;mlx-audio/0.4.6",
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
            self.assertEqual(installer_calls, [("low", False), ("medium", False)])
            self.assertEqual(
                messages[1],
                {
                    "type": "model_ready",
                    "id": load_low["id"],
                    "tier": "low",
                    "modelId": tier_spec("low").model_id,
                    "computeType": "int4",
                    "asrMode": "after-stop",
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
            # The dictation's scratch buffers are returned once the transcription
            # is done, not left for the life of the resident worker.
            self.assertEqual(runtimes["low"].releases_at_transcribe_return, [0])
            self.assertEqual(runtimes["low"].releases, 1)

    def test_transcription_failure_still_releases_scratch_memory(self) -> None:
        """A rejected dictation must not strand the buffers it allocated.

        The worker stays resident with the model warm, so anything not released
        here is held until the user quits or switches models.
        """
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary) / "models"
            model_root.mkdir()
            audio_root = Path(temporary) / "audio"
            audio_root.mkdir()
            audio_path = audio_root / "clip.wav"
            write_wav(audio_path)
            runtime = FakeRuntime("low", fail=True)

            def installer(
                path: Path,
                manifest: ModelManifest,
                allow_download: bool,
            ) -> Path:
                directory = path / manifest.storage_directory
                directory.mkdir(parents=True, exist_ok=True)
                return directory

            messages, errors, exit_code = self.run_protocol(
                encode_requests(
                    load_request("low", model_root),
                    request(
                        "transcribe",
                        audioPath=str(audio_path),
                        allowedRoot=str(audio_root),
                        language="English",
                        context="",
                    ),
                    request("shutdown"),
                ),
                installer=installer,
                factory=lambda directory, spec: runtime,
            )

            self.assertEqual(exit_code, 0)
            self.assertIn("internal_error", errors)
            self.assertEqual(messages[2]["type"], "error")
            self.assertEqual(runtime.releases, 1)

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
                modelId=tier_spec("high").model_id,
            )
            wrong_compute = load_request(
                "medium",
                model_root,
                computeType="float16",
            )
            wrong_v2_tier = load_request(
                "low",
                model_root,
                modelId=tier_spec("high", family="v2").model_id,
            )
            unknown_tier = load_request("low", model_root)
            unknown_tier["tier"] = "ultra"
            shutdown = request("shutdown")
            messages, _errors, _exit_code = self.run_protocol(
                encode_requests(
                    wrong_model,
                    wrong_compute,
                    wrong_v2_tier,
                    unknown_tier,
                    shutdown,
                ),
                installer=lambda *_args: self.fail("installer must not run"),
                factory=lambda *_args: self.fail("factory must not run"),
            )
            self.assertEqual([message["code"] for message in messages[1:5]], [
                "model_not_allowed",
                "model_not_allowed",
                "model_not_allowed",
                "model_not_allowed",
            ])

    def test_loads_exact_large_v2_catalog_selection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary) / "models"
            model_root.mkdir()
            v2_medium = tier_spec("medium", family="v2")
            load = load_request("medium", model_root, family="v2")
            shutdown = request("shutdown")
            installed: list[ModelManifest] = []
            runtimes: list[FakeRuntime] = []

            def installer(
                path: Path,
                manifest: ModelManifest,
                _allow_download: bool,
            ) -> Path:
                installed.append(manifest)
                installed_path = path / manifest.storage_directory
                installed_path.mkdir(exist_ok=True)
                return installed_path

            def factory(_path: Path, spec: TierSpec) -> FakeRuntime:
                self.assertEqual(spec, v2_medium)
                runtime = FakeRuntime("large-v2")
                runtimes.append(runtime)
                return runtime

            messages, errors, exit_code = self.run_protocol(
                encode_requests(load, shutdown),
                installer=installer,
                factory=factory,
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(errors, "")
            expected_manifest = worker_module.MODEL_MANIFESTS[
                (v2_medium.model_id, v2_medium.tier, v2_medium.compute_type)
            ]
            self.assertEqual(installed, [expected_manifest])
            self.assertEqual(
                messages[1],
                {
                    "type": "model_ready",
                    "id": load["id"],
                    "tier": "medium",
                    "modelId": v2_medium.model_id,
                    "computeType": "int8",
                    "asrMode": "after-stop",
                    "loadMs": messages[1]["loadMs"],
                },
            )
            self.assertTrue(runtimes[0].closed)

    def test_switching_model_families_unloads_previous_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary) / "models"
            model_root.mkdir()
            v3_low = tier_spec("low", family="v3")
            v2_low = tier_spec("low", family="v2")
            runtimes: dict[str, FakeRuntime] = {}

            def installer(
                path: Path,
                manifest: ModelManifest,
                _allow_download: bool,
            ) -> Path:
                if manifest.model_id == v2_low.model_id:
                    self.assertTrue(runtimes[v3_low.model_id].closed)
                installed_path = path / manifest.storage_directory
                installed_path.mkdir(exist_ok=True)
                return installed_path

            def factory(_path: Path, spec: TierSpec) -> FakeRuntime:
                runtime = FakeRuntime(spec.model_id)
                runtimes[spec.model_id] = runtime
                return runtime

            load_v3 = load_request("low", model_root, family="v3")
            load_v2 = load_request("low", model_root, family="v2")
            messages, errors, exit_code = self.run_protocol(
                encode_requests(load_v3, load_v2, request("shutdown")),
                installer=installer,
                factory=factory,
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(errors, "")
            self.assertEqual(messages[1]["modelId"], v3_low.model_id)
            self.assertEqual(messages[2]["modelId"], v2_low.model_id)
            self.assertTrue(runtimes[v3_low.model_id].closed)
            self.assertTrue(runtimes[v2_low.model_id].closed)

    def test_load_model_requires_explicit_no_download_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary)
            missing_policy = load_request("low", model_root)
            del missing_policy["allowDownload"]
            requested_download = load_request(
                "low",
                model_root,
                allow_download=True,
            )
            no_download = load_request(
                "low",
                model_root,
                allow_download=False,
            )
            shutdown = request("shutdown")
            messages, _errors, _exit_code = self.run_protocol(
                encode_requests(missing_policy, requested_download, no_download, shutdown),
                factory=lambda *_args: self.fail("factory must not run"),
            )
            self.assertEqual(messages[1]["code"], "invalid_request")
            self.assertEqual(messages[2]["code"], "allow_download_not_allowed")
            self.assertEqual(messages[3]["code"], "model_not_installed")

    def test_load_model_uses_preinstalled_verified_model_without_download(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary) / "models"
            spec = tier_spec("low")
            selection = (spec.model_id, spec.tier, spec.compute_type)
            manifest = tiny_manifest()
            write_tiny_model(model_root / manifest.storage_directory, manifest)
            load = load_request("low", model_root, allow_download=False)
            runtime = FakeRuntime()

            with (
                patch.dict(worker_module.MODEL_MANIFESTS, {selection: manifest}),
                patch.object(worker_module, "ensure_model", wraps=ensure_model) as ensured,
            ):
                messages, errors, exit_code = self.run_protocol(
                    encode_requests(load, request("shutdown")),
                    factory=lambda _path, _spec: runtime,
                )

            self.assertEqual(exit_code, 0)
            self.assertEqual(errors, "")
            ensured.assert_called_once()
            self.assertEqual(
                ensured.call_args.args,
                (model_root.resolve(), manifest, False),
            )
            verified_identities = ensured.call_args.kwargs["verified_identity_out"]
            self.assertEqual(len(verified_identities), 1)
            self.assertIsInstance(
                verified_identities[0],
                worker_module.ModelTreeIdentity,
            )
            self.assertEqual(messages[1]["type"], "model_ready")
            self.assertEqual(messages[1]["modelId"], spec.model_id)
            self.assertEqual(messages[1]["asrMode"], "after-stop")
            self.assertTrue(runtime.closed)

    def test_model_ready_reports_mode_for_cold_and_already_warm_loads(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary) / "models"
            spec = tier_spec("low")
            selection = (spec.model_id, spec.tier, spec.compute_type)
            manifest = tiny_manifest()
            write_tiny_model(model_root / manifest.storage_directory, manifest)
            first = load_request("low", model_root, allow_download=False)
            second = load_request("low", model_root, allow_download=False)
            runtime = FakeRuntime()

            with patch.dict(worker_module.MODEL_MANIFESTS, {selection: manifest}):
                messages, errors, exit_code = self.run_protocol(
                    encode_requests(first, second, request("shutdown")),
                    factory=lambda _path, _spec: runtime,
                )

            self.assertEqual(exit_code, 0)
            self.assertEqual(errors, "")
            self.assertEqual(messages[1]["asrMode"], "after-stop")
            self.assertEqual(messages[2]["asrMode"], "after-stop")
            self.assertGreaterEqual(messages[1]["loadMs"], 0)
            self.assertEqual(messages[2]["loadMs"], 0)

    def test_cold_load_hashes_the_artifact_exactly_once(self) -> None:
        """A cold load used to read every artifact byte through SHA-256 twice.

        The pre-check that refuses a load before the warm model is unloaded only
        needs to know whether the artifact is installed; ``ensure_model`` runs
        the authoritative digest verification immediately afterwards and no
        runtime is constructed until it passes. Hashing in both places doubled
        the load time of a multi-gigabyte artifact for no added guarantee.
        """
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary) / "models"
            spec = tier_spec("low")
            selection = (spec.model_id, spec.tier, spec.compute_type)
            manifest = tiny_manifest()
            write_tiny_model(model_root / manifest.storage_directory, manifest)
            hashed: list[str] = []
            real_sha256_with_identity = worker_module._sha256_with_identity

            def counting_sha256_with_identity(
                path: Path,
                on_chunk: Any = None,
            ) -> tuple[str, tuple[str, int, int, int, int, int]]:
                hashed.append(path.name)
                return real_sha256_with_identity(path, on_chunk)

            with (
                patch.dict(worker_module.MODEL_MANIFESTS, {selection: manifest}),
                patch.object(
                    worker_module,
                    "_sha256_with_identity",
                    counting_sha256_with_identity,
                ),
            ):
                messages, errors, exit_code = self.run_protocol(
                    encode_requests(
                        load_request("low", model_root, allow_download=False),
                        request("shutdown"),
                    ),
                    factory=lambda _path, _spec: FakeRuntime(),
                )

            self.assertEqual(exit_code, 0)
            self.assertEqual(errors, "")
            self.assertEqual(messages[1]["type"], "model_ready")
            self.assertEqual(sorted(hashed), ["config.json", "weights.npz"])

    def test_load_refuses_an_uninstalled_model_before_unloading_the_warm_one(
        self,
    ) -> None:
        """The cheap pre-check must still fire, and must still fire early.

        Skipping the digest pass must not turn "not installed" into an error
        raised only after the previously applied model has been evicted.
        """
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model_root = root / "models"
            spec = tier_spec("low")
            selection = (spec.model_id, spec.tier, spec.compute_type)
            manifest = tiny_manifest()
            write_tiny_model(model_root / manifest.storage_directory, manifest)
            audio_root = root / "audio"
            audio_root.mkdir()
            audio_path = audio_root / "utterance.wav"
            write_wav(audio_path)
            empty_root = root / "empty-models"
            empty_root.mkdir()
            warm = FakeRuntime("warm")

            with patch.dict(worker_module.MODEL_MANIFESTS, {selection: manifest}):
                messages, _errors, exit_code = self.run_protocol(
                    encode_requests(
                        load_request("low", model_root, allow_download=False),
                        load_request("low", empty_root, allow_download=False),
                        request(
                            "transcribe",
                            audioPath=str(audio_path),
                            allowedRoot=str(audio_root),
                            language="English",
                            context="",
                        ),
                        request("shutdown"),
                    ),
                    factory=lambda _path, _spec: warm,
                )

            self.assertEqual(exit_code, 0)
            self.assertEqual(messages[1]["type"], "model_ready")
            self.assertEqual(messages[2]["code"], "model_not_installed")
            # The rejected load must not have cost the warm model: a dictation
            # issued straight afterwards still runs on it.
            self.assertEqual(messages[3]["type"], "final")
            self.assertEqual(len(warm.calls), 1)

    def test_load_rejects_swap_after_hash_verification_before_loader_recheck(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary) / "models"
            spec = tier_spec("low")
            selection = (spec.model_id, spec.tier, spec.compute_type)
            manifest = tiny_manifest()
            model_directory = model_root / manifest.storage_directory
            write_tiny_model(model_directory, manifest)
            real_validation = worker_module._valid_model_directory
            swapped_after_verified_hash = False

            def verify_then_swap(
                local_model: Path,
                supplied_manifest: ModelManifest,
                **kwargs: Any,
            ) -> bool:
                nonlocal swapped_after_verified_hash
                valid = real_validation(local_model, supplied_manifest, **kwargs)
                if (
                    valid
                    and kwargs.get("verified_identity_out") is not None
                    and not swapped_after_verified_hash
                ):
                    weights = model_directory / "weights.npz"
                    replacement = model_directory / "replacement.bin"
                    replacement.write_bytes(b"x" * weights.stat().st_size)
                    replacement.replace(weights)
                    swapped_after_verified_hash = True
                return valid

            with (
                patch.dict(worker_module.MODEL_MANIFESTS, {selection: manifest}),
                patch.object(
                    worker_module,
                    "_valid_model_directory",
                    side_effect=verify_then_swap,
                ),
            ):
                messages, errors, exit_code = self.run_protocol(
                    encode_requests(
                        load_request("low", model_root, allow_download=False),
                        request("shutdown"),
                    ),
                    factory=lambda *_args: self.fail(
                        "a changed model identity must never reach the native loader"
                    ),
                )

            self.assertEqual(exit_code, 0)
            self.assertEqual(errors, "[mac-asr-worker] model_path_changed\n")
            self.assertEqual(messages[1]["code"], "model_path_changed")
            self.assertTrue(swapped_after_verified_hash)

    def test_install_model_transactionally_verifies_without_constructing_runtime(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary) / "models"
            spec = tier_spec("low")
            selection = (spec.model_id, spec.tier, spec.compute_type)
            manifest = tiny_manifest()
            install = install_request("low", model_root)
            downloaded: list[dict[str, Any]] = []
            runtime_factory_calls: list[tuple[Path, TierSpec]] = []

            def downloader(**kwargs: Any) -> None:
                downloaded.append(kwargs)
                write_tiny_model(Path(kwargs["local_dir"]), manifest)

            def transactional_ensure(
                path: Path,
                supplied_manifest: ModelManifest,
                allow_download: bool,
                *,
                progress: worker_module.ModelInstallProgress | None = None,
            ) -> Path:
                return ensure_model(
                    path,
                    supplied_manifest,
                    allow_download,
                    snapshot_downloader=downloader,
                    progress=progress,
                )

            def factory(path: Path, supplied_spec: TierSpec) -> FakeRuntime:
                runtime_factory_calls.append((path, supplied_spec))
                self.fail("install_model must not construct an inference runtime")

            with (
                patch.dict(worker_module.MODEL_MANIFESTS, {selection: manifest}),
                patch.object(
                    worker_module,
                    "ensure_model",
                    side_effect=transactional_ensure,
                ) as ensured,
            ):
                messages, errors, exit_code = self.run_protocol(
                    encode_requests(install, request("shutdown")),
                    factory=factory,
                    worker_role="installer",
                )

            self.assertEqual(exit_code, 0)
            self.assertEqual(errors, "")
            ensured.assert_called_once()
            self.assertEqual(ensured.call_args.args, (model_root.resolve(), manifest, True))
            self.assertIsInstance(
                ensured.call_args.kwargs["progress"],
                worker_module.ModelInstallProgress,
            )
            self.assertEqual(len(downloaded), 1)
            installed_message = next(
                message for message in messages if message["type"] == "model_installed"
            )
            self.assertEqual(
                installed_message,
                {
                    "type": "model_installed",
                    "id": install["id"],
                    "tier": spec.tier,
                    "modelId": spec.model_id,
                    "computeType": spec.compute_type,
                    "installMs": installed_message["installMs"],
                },
            )
            self.assertIsInstance(installed_message["installMs"], int)
            self.assertGreaterEqual(installed_message["installMs"], 0)
            self.assertEqual(runtime_factory_calls, [])
            self.assertTrue(
                worker_module._valid_model_directory(
                    model_root / manifest.storage_directory,
                    manifest,
                )
            )

    def test_install_model_emits_byte_accurate_progress_before_its_terminal_result(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary) / "models"
            spec = tier_spec("low")
            selection = (spec.model_id, spec.tier, spec.compute_type)
            manifest = tiny_manifest()
            total_bytes = sum(model_file.bytes for model_file in manifest.files.values())

            def installing(
                root: Path,
                supplied_manifest: ModelManifest,
                allow_download: bool,
                *,
                progress: worker_module.ModelInstallProgress | None = None,
            ) -> Path:
                self.assertTrue(allow_download)
                self.assertIs(supplied_manifest, manifest)
                self.assertIsNotNone(progress)
                assert progress is not None
                progress.begin("downloading")
                progress.advance(manifest.files["config.json"].bytes)
                write_tiny_model(root / manifest.storage_directory, manifest)
                progress.begin("verifying")
                progress.advance(total_bytes)
                return root / manifest.storage_directory

            with (
                patch.dict(worker_module.MODEL_MANIFESTS, {selection: manifest}),
                patch.object(worker_module, "ensure_model", side_effect=installing),
            ):
                messages, errors, exit_code = self.run_protocol(
                    encode_requests(
                        install_request("low", model_root),
                        request("shutdown"),
                    ),
                    worker_role="installer",
                )

        self.assertEqual(exit_code, 0)
        self.assertEqual(errors, "")
        self.assertEqual(
            [message["type"] for message in messages],
            [
                "hello",
                "model_install_progress",
                "model_install_progress",
                "model_install_progress",
                "model_install_progress",
                "model_installed",
                "shutdown",
            ],
        )
        self.assertEqual(
            messages[1:5],
            [
                {
                    "type": "model_install_progress",
                    "id": messages[1]["id"],
                    "phase": "downloading",
                    "completedBytes": 0,
                    "totalBytes": total_bytes,
                },
                {
                    "type": "model_install_progress",
                    "id": messages[1]["id"],
                    "phase": "downloading",
                    "completedBytes": manifest.files["config.json"].bytes,
                    "totalBytes": total_bytes,
                },
                {
                    "type": "model_install_progress",
                    "id": messages[1]["id"],
                    "phase": "verifying",
                    "completedBytes": 0,
                    "totalBytes": total_bytes,
                },
                {
                    "type": "model_install_progress",
                    "id": messages[1]["id"],
                    "phase": "verifying",
                    "completedBytes": total_bytes,
                    "totalBytes": total_bytes,
                },
            ],
        )
        self.assertEqual(messages[5]["type"], "model_installed")

    def test_install_model_rejects_missing_extra_disallowed_and_mismatched_fields(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary)
            missing_policy = install_request("low", model_root)
            del missing_policy["allowDownload"]
            extra_field = install_request("low", model_root, unexpected=True)
            disallowed_download = install_request(
                "low",
                model_root,
                allow_download=False,
            )
            mismatched_selection = install_request(
                "low",
                model_root,
                modelId=tier_spec("high").model_id,
            )
            messages, _errors, exit_code = self.run_protocol(
                encode_requests(
                    missing_policy,
                    extra_field,
                    disallowed_download,
                    mismatched_selection,
                    request("shutdown"),
                ),
                installer=lambda *_args: self.fail("invalid installs must not run"),
                factory=lambda *_args: self.fail("invalid installs must not load"),
                worker_role="installer",
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(
                [message["code"] for message in messages[1:5]],
                [
                    "invalid_request",
                    "invalid_request",
                    "allow_download_required",
                    "model_not_allowed",
                ],
            )

    def test_inference_role_rejects_install_without_disturbing_the_active_runtime(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model_root = root / "models"
            audio_root = root / "audio"
            audio_root.mkdir()
            audio_path = audio_root / "utterance.wav"
            write_wav(audio_path)
            active_spec = tier_spec("low")
            active_runtime = FakeRuntime("active")
            factory_calls: list[TierSpec] = []
            installer_calls: list[bool] = []

            def installer(
                path: Path,
                manifest: ModelManifest,
                allow_download: bool,
            ) -> Path:
                installer_calls.append(allow_download)
                installed = path / manifest.storage_directory
                installed.mkdir(parents=True, exist_ok=True)
                return installed

            def factory(_path: Path, spec: TierSpec) -> FakeRuntime:
                factory_calls.append(spec)
                self.assertEqual(spec, active_spec)
                return active_runtime

            load = load_request("low", model_root)
            install = install_request("medium", model_root)
            health = request("health")
            transcribe = request(
                "transcribe",
                audioPath=str(audio_path),
                allowedRoot=str(audio_root),
                language="auto",
                context="",
            )
            messages, errors, exit_code = self.run_protocol(
                encode_requests(load, install, health, transcribe, request("shutdown")),
                installer=installer,
                factory=factory,
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(errors, "[mac-asr-worker] operation_not_allowed\n")
            self.assertEqual(factory_calls, [active_spec])
            self.assertEqual(installer_calls, [False])
            self.assertEqual(messages[2]["code"], "operation_not_allowed")
            self.assertEqual(messages[3], {"type": "health", "id": health["id"], "ready": True})
            self.assertEqual(messages[4]["text"], "Hello from active.")
            self.assertTrue(active_runtime.closed)

    def test_installer_role_rejects_every_inference_capability(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary) / "models"
            requests = (
                load_request("low", model_root),
                request("health"),
                request("device_info"),
                request(
                    "transcribe",
                    audioPath=str(Path(temporary) / "private.wav"),
                    allowedRoot=temporary,
                    language="auto",
                    context="private transcript",
                ),
            )
            messages, errors, exit_code = self.run_protocol(
                encode_requests(*requests, request("shutdown")),
                installer=lambda *_args: self.fail("inference requests must not install"),
                factory=lambda *_args: self.fail("installer worker must not load a runtime"),
                hardware_probe=lambda: self.fail("installer worker must not inspect hardware"),
                worker_role="installer",
            )

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            errors,
            "[mac-asr-worker] operation_not_allowed\n" * len(requests),
        )
        self.assertEqual(
            [message["code"] for message in messages[1:-1]],
            ["operation_not_allowed"] * len(requests),
        )
        self.assertEqual(messages[-1]["type"], "shutdown")

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
            self.assertEqual(
                messages[1]["message"],
                "LocalScribe speech worker requires Apple silicon",
            )


class ModelInstallationTests(unittest.TestCase):
    def test_digest_identity_is_bound_to_the_exact_open_file_descriptor(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "weights.bin"
            replacement = root / "replacement.bin"
            contents = b"verified model bytes"
            target.write_bytes(contents)
            replacement.write_bytes(b"x" * len(contents))
            swapped = False

            def swap_path(_size: int) -> None:
                nonlocal swapped
                if not swapped:
                    replacement.replace(target)
                    swapped = True

            with self.assertRaisesRegex(RuntimeError, "model_file_identity_changed"):
                worker_module._sha256_with_identity(target, swap_path)
            self.assertTrue(swapped)

    def test_explicit_install_adopts_exact_legacy_huggingface_local_dir(self) -> None:
        manifest = tiny_manifest()
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary)
            model = model_root / manifest.storage_directory
            write_tiny_model(model, manifest)
            metadata = model / ".cache" / "huggingface"
            metadata.mkdir(parents=True)
            (metadata / "download.json").write_text("{}", encoding="utf-8")

            installed = ensure_model(
                model_root,
                manifest,
                True,
                snapshot_downloader=lambda **_kwargs: self.fail(
                    "an exact legacy local_dir must not be downloaded again"
                ),
            )

            self.assertEqual(installed, model.resolve())
            self.assertTrue(worker_module._valid_model_directory(installed, manifest))
            self.assertFalse((installed / ".cache").exists())

    def test_legacy_huggingface_adoption_rejects_other_extra_entries(self) -> None:
        manifest = tiny_manifest()
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary)
            model = model_root / manifest.storage_directory
            write_tiny_model(model, manifest)
            metadata = model / ".cache"
            metadata.mkdir()
            (model / "user-notes.txt").write_text("keep", encoding="utf-8")

            with self.assertRaisesRegex(WorkerError, "model download failed"):
                ensure_model(
                    model_root,
                    manifest,
                    True,
                    snapshot_downloader=lambda **_kwargs: (_ for _ in ()).throw(
                        RuntimeError("network must be attempted instead of deleting extras")
                    ),
                )

            self.assertTrue(metadata.is_dir())
            self.assertTrue((model / "user-notes.txt").is_file())

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
            staging = Path(observed["local_dir"])
            self.assertEqual(staging.name, "staging")
            self.assertEqual(staging.parent.parent, model_root.resolve())
            self.assertTrue(
                staging.parent.name.startswith(
                    worker_module.MODEL_TRANSACTION_PREFIX
                )
            )
            self.assertEqual(
                {entry.name for entry in installed.iterdir()},
                {"config.json", "weights.npz"},
            )
            self.assertFalse(any("staging" in entry.name for entry in model_root.iterdir()))

    def test_install_progress_uses_actual_reconstruction_and_verification_bytes(self) -> None:
        manifest = tiny_manifest()
        total_bytes = sum(model_file.bytes for model_file in manifest.files.values())
        events: list[tuple[str, int, int]] = []

        def downloader(**kwargs: Any) -> None:
            progress_class = kwargs["tqdm_class"]
            # Hugging Face passes this class to `tqdm.thread_map` as well as
            # its byte bars. Exercise the iterator and lock hooks that allow
            # the parallel downloader to use our silent protocol adapter.
            self.assertEqual(
                thread_map(
                    lambda filename: filename,
                    ["config.json"],
                    tqdm_class=progress_class,
                    max_workers=1,
                ),
                ["config.json"],
            )
            reconstruction = progress_class(
                total=0,
                initial=0,
                unit="B",
                desc="Reconstructing (incomplete total...)",
            )
            reconstruction.update(manifest.files["config.json"].bytes)
            reconstruction.update(manifest.files["weights.npz"].bytes)
            write_tiny_model(Path(kwargs["local_dir"]), manifest)

        with tempfile.TemporaryDirectory() as temporary:
            installed = ensure_model(
                Path(temporary),
                manifest,
                True,
                snapshot_downloader=downloader,
                progress=worker_module.ModelInstallProgress(
                    manifest,
                    lambda phase, completed, total: events.append((phase, completed, total)),
                ),
            )
            self.assertTrue(worker_module._valid_model_directory(installed, manifest))
            self.assertEqual(
                events,
                [
                    ("verifying", 0, total_bytes),
                    ("downloading", 0, total_bytes),
                    ("downloading", manifest.files["config.json"].bytes, total_bytes),
                    ("downloading", total_bytes, total_bytes),
                    ("verifying", 0, total_bytes),
                    ("verifying", manifest.files["config.json"].bytes, total_bytes),
                    ("verifying", total_bytes, total_bytes),
                ],
            )

    def test_interrupted_download_cleans_only_marker_owned_transaction(self) -> None:
        manifest = tiny_manifest()
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary)
            malformed = (
                model_root
                / f"{worker_module.MODEL_TRANSACTION_PREFIX}{'f' * 32}"
            )
            malformed.mkdir()
            (malformed / worker_module.MODEL_TRANSACTION_MARKER).write_text(
                "{}",
                encoding="utf-8",
            )
            unowned = model_root / ".whisper-low-staging-user-data"
            unowned.mkdir()
            (unowned / "keep.txt").write_text("keep", encoding="utf-8")

            def interrupted_download(**kwargs: Any) -> None:
                staging = Path(kwargs["local_dir"])
                (staging / "config.json").write_bytes(b"partial")
                raise RuntimeError("simulated interruption")

            with self.assertRaisesRegex(WorkerError, "model download failed"):
                ensure_model(
                    model_root,
                    manifest,
                    True,
                    snapshot_downloader=interrupted_download,
                )

            self.assertTrue(malformed.is_dir())
            self.assertTrue((unowned / "keep.txt").is_file())
            self.assertEqual(
                {entry.name for entry in model_root.iterdir()},
                {malformed.name, unowned.name},
            )

    def test_recovery_after_final_was_renamed_restores_verified_backup(self) -> None:
        manifest = tiny_manifest()
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary).resolve()
            transaction, staging, backup = worker_module._create_model_transaction(
                model_root,
                manifest,
            )
            write_tiny_model(staging, manifest)
            final_directory = model_root / manifest.storage_directory
            write_tiny_model(final_directory, manifest)
            final_directory.replace(backup)

            installed = ensure_model(
                model_root,
                manifest,
                True,
                snapshot_downloader=lambda **_kwargs: self.fail(
                    "recovery must not use the network"
                ),
            )

            self.assertEqual(installed, model_root / manifest.storage_directory)
            self.assertTrue(worker_module._valid_model_directory(installed, manifest))
            self.assertFalse(transaction.exists())

    def test_recovery_after_staging_was_promoted_cleans_verified_backup(self) -> None:
        manifest = tiny_manifest()
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary).resolve()
            transaction, staging, backup = worker_module._create_model_transaction(
                model_root,
                manifest,
            )
            write_tiny_model(staging, manifest)
            final_directory = model_root / manifest.storage_directory
            write_tiny_model(final_directory, manifest)
            final_directory.replace(backup)
            staging.replace(final_directory)

            installed = ensure_model(
                model_root,
                manifest,
                True,
                snapshot_downloader=lambda **_kwargs: self.fail(
                    "recovery must not use the network"
                ),
            )

            self.assertEqual(installed, final_directory)
            self.assertTrue(worker_module._valid_model_directory(installed, manifest))
            self.assertFalse(transaction.exists())
            self.assertFalse(backup.exists())

    def test_recovery_restores_verified_backup_over_corrupt_promoted_model(self) -> None:
        manifest = tiny_manifest()
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary).resolve()
            transaction, staging, backup = worker_module._create_model_transaction(
                model_root,
                manifest,
            )
            write_tiny_model(staging, manifest)
            final_directory = model_root / manifest.storage_directory
            write_tiny_model(final_directory, manifest)
            final_directory.replace(backup)
            staging.replace(final_directory)
            (final_directory / "weights.npz").write_bytes(b"corrupt")

            installed = ensure_model(
                model_root,
                manifest,
                True,
                snapshot_downloader=lambda **_kwargs: self.fail(
                    "recovery must not use the network"
                ),
            )

            self.assertEqual(installed, final_directory)
            self.assertTrue(worker_module._valid_model_directory(installed, manifest))
            self.assertFalse(transaction.exists())
            self.assertFalse(backup.exists())

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

    def test_nested_coreml_bundle_requires_exact_regular_file_tree(self) -> None:
        manifest = nested_manifest()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model = root / manifest.storage_directory
            write_nested_model(model, manifest)
            self.assertTrue(worker_module._valid_model_directory(model, manifest))

            # An undeclared nested file is not inert Finder metadata and must
            # prevent CoreML from loading the otherwise verified artifact.
            extra = model / "encoder.mlmodelc" / "weights" / "payload.bin"
            extra.write_bytes(b"payload")
            self.assertFalse(worker_module._valid_model_directory(model, manifest))
            extra.unlink()

            # A symlinked bundle ancestor could redirect a later CoreML load
            # outside the digest-verified tree, so it is rejected before any
            # manifest file is read.
            target = root / "external-bundle"
            (target / "weights").mkdir(parents=True)
            (target / "model.mil").write_bytes(b"coreml-model")
            (target / "weights" / "weight.bin").write_bytes(b"coreml-weights")
            bundle = model / "encoder.mlmodelc"
            shutil.rmtree(bundle)
            bundle.symlink_to(target, target_is_directory=True)
            self.assertFalse(worker_module._valid_model_directory(model, manifest))

    def test_nested_coreml_install_downloads_only_manifested_bundle_files(self) -> None:
        manifest = nested_manifest()
        observed: dict[str, Any] = {}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            def downloader(**kwargs: Any) -> None:
                observed.update(kwargs)
                write_nested_model(Path(kwargs["local_dir"]), manifest)
                (Path(kwargs["local_dir"]) / ".cache" / "huggingface").mkdir(parents=True)

            installed = ensure_model(
                root,
                manifest,
                True,
                snapshot_downloader=downloader,
            )

            self.assertEqual(installed, root.resolve() / manifest.storage_directory)
            self.assertTrue(worker_module._valid_model_directory(installed, manifest))
            self.assertEqual(observed["allow_patterns"], sorted(manifest.files))
            self.assertEqual(observed["repo_id"], manifest.model_id)
            self.assertEqual(observed["revision"], manifest.revision)

    def test_finder_metadata_does_not_invalidate_a_byte_perfect_model(self) -> None:
        """A .DS_Store must not cost the user a multi-gigabyte re-download.

        Opening the models folder in the Finder writes one. The exact-entry-set
        rule used to treat that as a corrupt artifact, so the next dictation
        failed with model_not_installed and the only offered remedy was
        re-downloading every pinned file that was already digest-identical.
        """
        manifest = tiny_manifest()
        with tempfile.TemporaryDirectory() as temporary:
            model = Path(temporary) / manifest.storage_directory
            write_tiny_model(model, manifest)

            for name in (".DS_Store", ".localized", "._weights.npz"):
                with self.subTest(name=name):
                    noise = model / name
                    noise.write_bytes(b"\x00\x01\x02")
                    # Both modes: the structural pre-check used by load_model
                    # and the digest-verifying check used by install.
                    self.assertTrue(
                        worker_module._valid_model_directory(model, manifest)
                    )
                    self.assertTrue(
                        worker_module._valid_model_directory(
                            model, manifest, verify_digests=False
                        )
                    )
                    # ensure_model must not reach for the downloader.
                    ensure_model(Path(temporary), manifest, False)
                    noise.unlink()

    def test_finder_metadata_exemption_does_not_admit_a_payload(self) -> None:
        manifest = tiny_manifest()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model = root / manifest.storage_directory
            write_tiny_model(model, manifest)

            # An AppleDouble sidecar is tolerated only for a file the manifest
            # declares, so a plausible-looking name is not a way in.
            payload = model / "._payload.bin"
            payload.write_bytes(b"x")
            self.assertFalse(worker_module._valid_model_directory(model, manifest))
            payload.unlink()

            # A directory wearing the name is not something the OS writes.
            (model / ".DS_Store").mkdir()
            self.assertFalse(worker_module._valid_model_directory(model, manifest))
            (model / ".DS_Store").rmdir()

            # Neither is a symlink, which could point anywhere.
            external = root / "elsewhere"
            external.write_bytes(b"x")
            (model / ".DS_Store").symlink_to(external)
            self.assertFalse(worker_module._valid_model_directory(model, manifest))
            (model / ".DS_Store").unlink()

            # And the exemption never covers a missing manifest file.
            (model / "weights.npz").unlink()
            (model / ".DS_Store").write_bytes(b"x")
            self.assertFalse(worker_module._valid_model_directory(model, manifest))

    def test_catalog_manifest_rejects_a_url_as_manifest_model_identity(self) -> None:
        spec = tier_spec("low", family="v2")
        packaged_path = worker_module._manifest_path(spec.manifest_filename)
        raw = json.loads(packaged_path.read_text(encoding="utf-8"))
        raw["modelId"] = "https://untrusted.invalid/model"
        with tempfile.TemporaryDirectory() as temporary:
            tampered = Path(temporary) / spec.manifest_filename
            tampered.write_text(json.dumps(raw), encoding="utf-8")
            with self.assertRaisesRegex(
                RuntimeError,
                "packaged_model_manifest_invalid",
            ):
                worker_module._parse_manifest(tampered, spec.tier, "MLX Whisper")

    def test_catalog_manifest_file_entry_ceiling_is_strictly_bounded(self) -> None:
        spec = tier_spec("low", family="v2")
        packaged_path = worker_module._manifest_path(spec.manifest_filename)
        raw = json.loads(packaged_path.read_text(encoding="utf-8"))
        raw["files"] = {
            f"artifact-{index}.bin": {"bytes": 1, "sha256": "a" * 64}
            for index in range(worker_module.MAX_MANIFEST_FILE_ENTRIES + 1)
        }
        with tempfile.TemporaryDirectory() as temporary:
            tampered = Path(temporary) / spec.manifest_filename
            tampered.write_text(json.dumps(raw), encoding="utf-8")
            with self.assertRaisesRegex(
                RuntimeError,
                "packaged_model_manifest_invalid",
            ):
                worker_module._parse_manifest(tampered, spec.tier, "MLX Whisper")

    def test_catalog_identity_is_derived_from_the_curated_manifest(self) -> None:
        spec = tier_spec("low", family="v2")
        packaged_path = worker_module._manifest_path(spec.manifest_filename)
        raw = json.loads(packaged_path.read_text(encoding="utf-8"))
        raw.update(
            {
                "modelId": "curated-owner/custom-whisper",
                "artifactId": "custom-whisper-int4",
                "storageDirectory": "custom-whisper-int4",
                "revision": "c" * 40,
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            curated = Path(temporary) / spec.manifest_filename
            curated.write_text(json.dumps(raw), encoding="utf-8")
            manifest = worker_module._parse_manifest(
                curated,
                spec.tier,
                "MLX Whisper",
            )

        self.assertEqual(manifest.model_id, "curated-owner/custom-whisper")
        self.assertEqual(manifest.artifact_id, "custom-whisper-int4")
        self.assertEqual(manifest.storage_directory, "custom-whisper-int4")
        self.assertEqual(manifest.revision, "c" * 40)

    def test_packaged_catalog_has_exact_curated_manifests_and_files(self) -> None:
        self.assertEqual(len(TIER_SPECS), 14)
        self.assertEqual(
            {spec.manifest_filename for spec in TIER_SPECS.values()},
            {
                "whisper-large-v3-mlx.json",
                "whisper-large-v3-mlx-8bit.json",
                "whisper-large-v3-mlx-4bit.json",
                "whisper-large-v2-mlx.json",
                "whisper-large-v2-mlx-8bit.json",
                "whisper-large-v2-mlx-4bit.json",
                "qwen3-asr-1-7b-mlx-bf16.json",
                "qwen3-asr-1-7b-mlx-8bit.json",
                "qwen3-asr-1-7b-mlx-4bit.json",
                "qwen3-asr-0-6b-mlx-bf16.json",
                "qwen3-asr-0-6b-mlx-8bit.json",
                "qwen3-asr-0-6b-mlx-4bit.json",
                "parakeet-unified-en-0-6b-coreml-fp16.json",
                "parakeet-unified-en-0-6b-coreml-int8.json",
            },
        )
        for family in ("v3", "v2"):
            self.assertEqual(
                [
                    tier_spec(tier, family=family).compute_type
                    for tier in ("high", "medium", "low")
                ],
                ["float16", "int8", "int4"],
            )
        for family in ("qwen", "qwen06"):
            self.assertEqual(
                [
                    tier_spec(tier, family=family).compute_type
                    for tier in ("high", "medium", "low")
                ],
                ["bfloat16", "int8", "int4"],
            )
        self.assertEqual(
            [
                tier_spec(tier, family="parakeet").compute_type
                for tier in ("high", "medium")
            ],
            ["coreml-fp16", "coreml-int8"],
        )
        for selection, manifest in worker_module.MODEL_MANIFESTS.items():
            spec = TIER_SPECS[selection]
            self.assertEqual(selection, (spec.model_id, spec.tier, spec.compute_type))
            self.assertEqual(manifest.model_id, spec.model_id)
            self.assertEqual(manifest.family_id, spec.family_id)
            self.assertEqual(manifest.artifact_id, spec.artifact_id)
            self.assertEqual(manifest.revision, spec.revision)
            if manifest.family_id in {"qwen3-asr-1-7b", "qwen3-asr-0-6b"}:
                self.assertIn("model.safetensors", manifest.files)
                self.assertIn("config.json", manifest.files)
            elif manifest.family_id == "parakeet-unified-en-0-6b":
                self.assertIn("metadata.json", manifest.files)
                self.assertIn("vocab.json", manifest.files)
                self.assertTrue(
                    any(name.endswith("/weights/weight.bin") for name in manifest.files)
                )
                self.assertTrue(any("streaming_70_7_7" in name for name in manifest.files))
                self.assertFalse(any("streaming_70_13_13" in name for name in manifest.files))
            else:
                self.assertEqual(set(manifest.files), {"config.json", "weights.npz"})
            for model_file in manifest.files.values():
                self.assertGreater(model_file.bytes, 0)
                self.assertRegex(model_file.sha256, r"^[a-f0-9]{64}$")


class RuntimeAndHardwareTests(unittest.TestCase):
    def test_fluid_audio_helper_ignores_unsupported_context_in_its_strict_local_protocol(
        self,
    ) -> None:
        def frame(payload: dict[str, Any]) -> bytes:
            encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            return worker_module.struct.pack(">I", len(encoded)) + encoded

        class FakeProcess:
            def __init__(self) -> None:
                self.stdin = io.BytesIO()
                self.stdout = io.BytesIO(
                    frame(
                        {
                            "type": "hello",
                            "protocol": 1,
                            "runtime": "FluidAudio CoreML / ANE",
                            "runtimeVersion": "0.15.5",
                            "modes": ["after-stop", "live"],
                            "precisions": ["coreml-fp16", "coreml-int8"],
                        }
                    )
                    + frame({"type": "loaded"})
                    + frame({"type": "transcription", "text": "Local Parakeet."})
                )
                self.terminated = False

            def poll(self) -> None:
                return None

            def wait(self, timeout: float | None = None) -> int:
                return 0

            def terminate(self) -> None:
                self.terminated = True

            def kill(self) -> None:
                self.terminated = True

        process = FakeProcess()
        spec = TierSpec(
            tier="medium",
            manifest_filename="parakeet-unified-en-0-6b-coreml-int8.json",
            model_id="FluidInference/parakeet-unified-en-0.6b-coreml",
            family_id="parakeet-unified-en-0-6b",
            artifact_id="parakeet-unified-en-0-6b-coreml-int8",
            revision="a" * 40,
            storage_directory="parakeet-unified-en-0-6b-coreml-int8",
            compute_type="coreml-int8",
        )
        with (
            patch.object(worker_module, "_fluid_audio_helper_path", return_value=Path("/signed/helper")),
            patch.object(worker_module.subprocess, "Popen", return_value=process),
        ):
            runtime = FluidAudioParakeetRuntime.load(
                Path("/models/parakeet-unified-en-0-6b-coreml-int8"), spec
            )
            self.assertEqual(
                runtime.transcribe(
                    b"\x00\x00",
                    language="en",
                    context="LocalScribe=LocalScribe",
                ),
                TranscriptionResult("Local Parakeet.", "en"),
            )

        wire = process.stdin.getvalue()
        first_length = worker_module.struct.unpack(">I", wire[:4])[0]
        first = json.loads(wire[4 : 4 + first_length])
        self.assertEqual(
            first,
            {
                "type": "load",
                "modelPath": "/models/parakeet-unified-en-0-6b-coreml-int8",
                "precision": "coreml-int8",
                "mode": "after-stop",
            },
        )
        offset = 4 + first_length
        second_length = worker_module.struct.unpack(">I", wire[offset : offset + 4])[0]
        second = json.loads(wire[offset + 4 : offset + 4 + second_length])
        self.assertEqual(second, {"type": "transcribe", "pcmBytes": 2})
        self.assertEqual(wire[offset + 4 + second_length :], b"\x00\x00")
        runtime.close()

    def test_qwen06_runtime_dispatches_only_to_mlx_audio(self) -> None:
        spec = tier_spec("low", family="qwen06")
        with (
            patch.object(MLXAudioRuntime, "load", return_value="qwen06") as qwen_load,
            patch.object(MLXWhisperRuntime, "load", return_value="whisper") as whisper_load,
        ):
            self.assertEqual(
                worker_module._load_runtime(Path("/qwen06"), spec),
                "qwen06",
            )
        qwen_load.assert_called_once_with(Path("/qwen06"), spec)
        whisper_load.assert_not_called()

    def test_parakeet_dispatches_only_to_the_fluid_audio_helper(self) -> None:
        spec = tier_spec("medium", family="parakeet")
        with (
            patch.object(
                FluidAudioParakeetRuntime,
                "load",
                return_value="parakeet",
            ) as parakeet_load,
            patch.object(MLXAudioRuntime, "load", return_value="qwen") as qwen_load,
            patch.object(MLXWhisperRuntime, "load", return_value="whisper") as whisper_load,
        ):
            self.assertEqual(worker_module._load_runtime(Path("/parakeet"), spec), "parakeet")
        parakeet_load.assert_called_once_with(Path("/parakeet"), spec)
        qwen_load.assert_not_called()
        whisper_load.assert_not_called()

    def test_runtime_passes_pcm_array_and_prompt_to_mlx_audio(self) -> None:
        class FakeMetal:
            def clear_cache(self) -> None:
                pass

        class FakeMlx:
            metal = FakeMetal()

            @staticmethod
            def synchronize() -> None:
                pass

        class Result:
            text = "Local Qwen audio."
            language = "English"

        class Model:
            def __init__(self) -> None:
                self.waveform: Any = None
                self.kwargs: dict[str, Any] = {}

            def generate(self, waveform: Any, **kwargs: Any) -> Result:
                self.waveform = waveform
                self.kwargs = kwargs
                return Result()

        model = Model()
        runtime = MLXAudioRuntime(
            mlx_module=FakeMlx(),
            numpy_module=np,
            model=model,
        )
        result = runtime.transcribe(
            b"\x00\x00\xff\x7f",
            language="en",
            context="LocalScribe vocabulary",
        )
        self.assertEqual(result, TranscriptionResult("Local Qwen audio.", "English"))
        self.assertIsInstance(model.waveform, np.ndarray)
        self.assertEqual(
            model.kwargs,
            {
                "language": "English",
                "system_prompt": "LocalScribe vocabulary",
                "temperature": 0.0,
                "verbose": False,
            },
        )
        runtime.close()
        self.assertIsNone(runtime._model)

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
            context="Test User LocalScribe",
        )
        self.assertEqual(result, TranscriptionResult("Local audio.", "en"))
        self.assertIsInstance(captured["waveform"], np.ndarray)
        self.assertEqual(
            captured["kwargs"],
            {
                "path_or_hf_repo": "/verified/local/model",
                "verbose": None,
                "language": "en",
                "initial_prompt": "Test User LocalScribe",
                "fp16": True,
            },
        )
        runtime.close()
        self.assertIsNone(Holder.model)
        self.assertIsNone(Holder.model_path)

    def test_release_transient_memory_clears_the_mlx_buffer_cache(self) -> None:
        """The doubles used above expose ``metal.clear_cache``, which the runtime
        no longer calls, and both call sites swallow every exception — so an
        AttributeError there was invisible and a deleted ``clear_cache`` stayed
        green. Record the calls on the module the runtime actually uses.
        """

        class RecordingMlx:
            def __init__(self) -> None:
                self.calls: list[str] = []

            def synchronize(self) -> None:
                self.calls.append("synchronize")

            def clear_cache(self) -> None:
                self.calls.append("clear_cache")

        class Holder:
            model = None
            model_path = None

        whisper_mlx = RecordingMlx()
        whisper = MLXWhisperRuntime(
            mlx_module=whisper_mlx,
            numpy_module=np,
            model_holder=Holder,
            transcribe_function=lambda waveform, **kwargs: {"text": "", "language": "en"},
            model=object(),
            model_path="/verified/local/model",
        )
        whisper.release_transient_memory()
        self.assertEqual(whisper_mlx.calls, ["synchronize", "clear_cache"])

        class Model:
            def generate(self, waveform: Any, **kwargs: Any) -> Any:
                raise AssertionError("generate must not run here")

        audio_mlx = RecordingMlx()
        audio = MLXAudioRuntime(
            mlx_module=audio_mlx,
            numpy_module=np,
            model=Model(),
        )
        audio.release_transient_memory()
        self.assertEqual(audio_mlx.calls, ["synchronize", "clear_cache"])

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
