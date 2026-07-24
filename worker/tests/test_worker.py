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

import localscribe_worker.worker as worker_module
import numpy as np
from localscribe_worker.worker import (
    MAX_REQUEST_BYTES,
    TIER_SPECS,
    HardwareInfo,
    MLXWhisperRuntime,
    ModelFile,
    ModelManifest,
    TierSpec,
    TranscriptionResult,
    WorkerError,
    ensure_model,
    run_worker,
)


def request(message_type: str, **fields: Any) -> dict[str, Any]:
    return {"type": message_type, "id": str(uuid.uuid4()), **fields}


def tier_spec(tier: str, *, family: str = "v3") -> TierSpec:
    matches = [
        spec
        for spec in TIER_SPECS.values()
        if spec.tier == tier and f"whisper-large-{family}-mlx" in spec.model_id
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
        if installer is None:
            exit_code = run_worker(**kwargs)
        else:
            # Runtime-flow tests inject a lightweight installer rather than a
            # real model archive. Exact file/hash verification is separately
            # covered by ModelInstallationTests and install_model protocol tests.
            actual_validation = worker_module._valid_model_directory

            def model_is_available(path: Path, manifest: ModelManifest) -> bool:
                if manifest.model_id == "example/whisper":
                    return actual_validation(path, manifest)
                return True

            with patch.object(
                worker_module,
                "_valid_model_directory",
                side_effect=model_is_available,
            ):
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
            self.assertEqual(installer_calls, [("low", False), ("medium", False)])
            self.assertEqual(
                messages[1],
                {
                    "type": "model_ready",
                    "id": load_low["id"],
                    "tier": "low",
                    "modelId": tier_spec("low").model_id,
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
            ensured.assert_called_once_with(model_root.resolve(), manifest, False)
            self.assertEqual(messages[1]["type"], "model_ready")
            self.assertEqual(messages[1]["modelId"], spec.model_id)
            self.assertTrue(runtime.closed)

    def test_install_model_transactionally_verifies_without_constructing_runtime(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary) / "models"
            spec = tier_spec("low")
            selection = (spec.model_id, spec.tier, spec.compute_type)
            manifest = tiny_manifest()
            install = install_request("low", model_root)
            health = request("health")
            downloaded: list[dict[str, Any]] = []
            runtime_factory_calls: list[tuple[Path, TierSpec]] = []

            def downloader(**kwargs: Any) -> None:
                downloaded.append(kwargs)
                write_tiny_model(Path(kwargs["local_dir"]), manifest)

            def transactional_ensure(
                path: Path,
                supplied_manifest: ModelManifest,
                allow_download: bool,
            ) -> Path:
                return ensure_model(
                    path,
                    supplied_manifest,
                    allow_download,
                    snapshot_downloader=downloader,
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
                    encode_requests(install, health, request("shutdown")),
                    factory=factory,
                )

            self.assertEqual(exit_code, 0)
            self.assertEqual(errors, "")
            ensured.assert_called_once_with(model_root.resolve(), manifest, True)
            self.assertEqual(len(downloaded), 1)
            self.assertEqual(
                messages[1],
                {
                    "type": "model_installed",
                    "id": install["id"],
                    "tier": spec.tier,
                    "modelId": spec.model_id,
                    "computeType": spec.compute_type,
                    "installMs": messages[1]["installMs"],
                },
            )
            self.assertIsInstance(messages[1]["installMs"], int)
            self.assertGreaterEqual(messages[1]["installMs"], 0)
            self.assertEqual(messages[2], {"type": "health", "id": health["id"], "ready": False})
            self.assertEqual(runtime_factory_calls, [])
            self.assertTrue(
                worker_module._valid_model_directory(
                    model_root / manifest.storage_directory,
                    manifest,
                )
            )

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

    def test_install_model_preserves_the_active_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model_root = root / "models"
            audio_root = root / "audio"
            audio_root.mkdir()
            audio_path = audio_root / "utterance.wav"
            write_wav(audio_path)
            active_spec = tier_spec("low")
            install_spec = tier_spec("medium")
            install_selection = (
                install_spec.model_id,
                install_spec.tier,
                install_spec.compute_type,
            )
            install_manifest = tiny_manifest()
            active_runtime = FakeRuntime("active")
            factory_calls: list[TierSpec] = []
            active_during_install: list[bool] = []

            def downloader(**kwargs: Any) -> None:
                write_tiny_model(Path(kwargs["local_dir"]), install_manifest)

            def installer(
                path: Path,
                manifest: ModelManifest,
                allow_download: bool,
            ) -> Path:
                if manifest is install_manifest:
                    active_during_install.append(not active_runtime.closed)
                    return ensure_model(
                        path,
                        manifest,
                        allow_download,
                        snapshot_downloader=downloader,
                    )
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
            with patch.dict(
                worker_module.MODEL_MANIFESTS,
                {install_selection: install_manifest},
            ):
                messages, errors, exit_code = self.run_protocol(
                    encode_requests(load, install, health, transcribe, request("shutdown")),
                    installer=installer,
                    factory=factory,
                )

            self.assertEqual(exit_code, 0)
            self.assertEqual(errors, "")
            self.assertEqual(factory_calls, [active_spec])
            self.assertEqual(active_during_install, [True])
            self.assertEqual(messages[2]["type"], "model_installed")
            self.assertEqual(messages[2]["modelId"], install_spec.model_id)
            self.assertEqual(messages[3], {"type": "health", "id": health["id"], "ready": True})
            self.assertEqual(messages[4]["text"], "Hello from active.")
            self.assertTrue(active_runtime.closed)

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

    def test_catalog_manifest_rejects_tampered_v2_identity_metadata(self) -> None:
        spec = tier_spec("low", family="v2")
        packaged_path = worker_module._manifest_path(spec.manifest_filename)
        raw = json.loads(packaged_path.read_text(encoding="utf-8"))
        raw["artifactId"] = "whisper-large-v2-mlx-fp16"
        with tempfile.TemporaryDirectory() as temporary:
            tampered = Path(temporary) / spec.manifest_filename
            tampered.write_text(json.dumps(raw), encoding="utf-8")
            with self.assertRaisesRegex(
                RuntimeError,
                "packaged_model_manifest_identity_mismatch",
            ):
                worker_module._parse_manifest(tampered, spec)

    def test_packaged_catalog_has_exact_six_whisper_manifests_and_files(self) -> None:
        self.assertEqual(len(TIER_SPECS), 6)
        self.assertEqual(
            {spec.manifest_filename for spec in TIER_SPECS.values()},
            {
                "whisper-large-v3-mlx.json",
                "whisper-large-v3-mlx-8bit.json",
                "whisper-large-v3-mlx-4bit.json",
                "whisper-large-v2-mlx.json",
                "whisper-large-v2-mlx-8bit.json",
                "whisper-large-v2-mlx-4bit.json",
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
        for selection, manifest in worker_module.MODEL_MANIFESTS.items():
            spec = TIER_SPECS[selection]
            self.assertEqual(selection, (spec.model_id, spec.tier, spec.compute_type))
            self.assertEqual(manifest.model_id, spec.model_id)
            self.assertEqual(manifest.family_id, spec.family_id)
            self.assertEqual(manifest.artifact_id, spec.artifact_id)
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
