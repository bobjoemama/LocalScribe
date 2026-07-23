from __future__ import annotations

import contextlib
import gc
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Callable, Protocol, TextIO

PROTOCOL_VERSION = 1
BACKEND_NAME = "mlx-whisper"
BACKEND_VERSION = "0.4.3"

MAX_REQUEST_BYTES = 16 * 1024
# Keep these literals in sync with resources/audio-protocol.json. They are
# checked by tests/audioProtocol.test.ts; this standalone runtime deliberately
# does not import application TypeScript or package resources at runtime.
AUDIO_PROTOCOL_VERSION = 1
MAX_AUDIO_BYTES = 20_971_520
MAX_AUDIO_DURATION_MS = 600_000
REQUIRED_SAMPLE_RATE = 16_000
REQUIRED_CHANNELS = 1
REQUIRED_SAMPLE_WIDTH_BYTES = 2
MAX_AUDIO_FRAMES = (MAX_AUDIO_DURATION_MS * REQUIRED_SAMPLE_RATE) // 1_000
WAV_HEADER_BYTES = 44
MAX_CONTEXT_CHARS = 4_000
MAX_LANGUAGE_CHARS = 80
MAX_PATH_CHARS = 2_048
MAX_RESULT_CHARS = 100_000

EXPECTED_MODEL_FILES = frozenset({"config.json", "weights.npz"})
EXPECTED_MANIFEST_FIELDS = frozenset(
    {
        "schemaVersion",
        "platform",
        "backend",
        "displayName",
        "modelId",
        "storageDirectory",
        "revision",
        "license",
        "files",
    }
)

LANGUAGE_NAME_TO_CODE = {
    "english": "en",
    "spanish": "es",
    "french": "fr",
    "german": "de",
    "hindi": "hi",
}
SUPPORTED_LANGUAGE_CODES = frozenset(LANGUAGE_NAME_TO_CODE.values())


@dataclass(frozen=True)
class TierSpec:
    tier: str
    manifest_filename: str
    model_id: str
    revision: str
    storage_directory: str
    compute_type: str


TIER_SPECS = {
    "high": TierSpec(
        tier="high",
        manifest_filename="whisper-large-v3-mlx.json",
        model_id="mlx-community/whisper-large-v3-mlx",
        revision="49e6aa286ad60c14352c404340ded53710378a11",
        storage_directory="whisper-large-v3-mlx-49e6aa2",
        compute_type="float16",
    ),
    "medium": TierSpec(
        tier="medium",
        manifest_filename="whisper-large-v3-mlx-8bit.json",
        model_id="mlx-community/whisper-large-v3-mlx-8bit",
        revision="04ca5b03c22d72ddf4f4b2d808a28bf9902fb71a",
        storage_directory="whisper-large-v3-mlx-8bit-04ca5b0",
        compute_type="int8",
    ),
    "low": TierSpec(
        tier="low",
        manifest_filename="whisper-large-v3-mlx-4bit.json",
        model_id="mlx-community/whisper-large-v3-mlx-4bit",
        revision="d12b5d0043a6fe0c59af321617fba041d4e8e0c8",
        storage_directory="whisper-large-v3-mlx-4bit-d12b5d0",
        compute_type="int4",
    ),
}
MANIFEST_FILENAMES = frozenset(spec.manifest_filename for spec in TIER_SPECS.values())


@dataclass(frozen=True)
class ModelFile:
    bytes: int
    sha256: str


@dataclass(frozen=True)
class ModelManifest:
    tier: str
    backend: str
    display_name: str
    model_id: str
    storage_directory: str
    revision: str
    license: str
    files: dict[str, ModelFile]


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    language: str | None


@dataclass(frozen=True)
class HardwareInfo:
    chip: str | None
    total_bytes: int
    available_bytes: int

    def protocol_payload(self) -> dict[str, Any]:
        return {
            "platform": "darwin",
            "architecture": "arm64",
            "chip": self.chip,
            "unifiedMemory": {
                "totalBytes": self.total_bytes,
                "availableBytes": self.available_bytes,
                "availableIsEstimated": True,
                "memoryBasis": "vm_stat_free_inactive_speculative",
            },
        }


class WorkerError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.public_message = message


class InferenceRuntime(Protocol):
    def transcribe(
        self,
        pcm16: bytes,
        *,
        language: str | None,
        context: str,
    ) -> TranscriptionResult: ...

    def close(self) -> None: ...


ModelInstaller = Callable[[Path, ModelManifest, bool], Path]
RuntimeFactory = Callable[[Path, TierSpec], InferenceRuntime]
HardwareProbe = Callable[[], HardwareInfo]
SnapshotDownloader = Callable[..., Any]


def _manifest_path(filename: str) -> Path:
    if filename not in MANIFEST_FILENAMES:
        raise RuntimeError("packaged_model_manifest_not_allowed")
    for parent in Path(__file__).resolve().parents:
        for relative in (Path("resources") / "model-manifest", Path("model-manifest")):
            candidate = parent / relative / filename
            try:
                metadata = candidate.lstat()
            except OSError:
                continue
            if stat.S_ISREG(metadata.st_mode) and not candidate.is_symlink():
                return candidate
    raise RuntimeError("packaged_model_manifest_missing")


def _parse_manifest(path: Path, spec: TierSpec) -> ModelManifest:
    try:
        metadata = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
            raise RuntimeError("packaged_model_manifest_invalid")
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("packaged_model_manifest_invalid") from error
    if not isinstance(raw, dict) or frozenset(raw) != EXPECTED_MANIFEST_FIELDS:
        raise RuntimeError("packaged_model_manifest_invalid")
    if raw.get("schemaVersion") != 1 or raw.get("platform") != "darwin-arm64":
        raise RuntimeError("packaged_model_manifest_invalid")
    if raw.get("modelId") != spec.model_id or raw.get("revision") != spec.revision:
        raise RuntimeError("packaged_model_manifest_identity_mismatch")
    if raw.get("storageDirectory") != spec.storage_directory:
        raise RuntimeError("packaged_model_manifest_identity_mismatch")
    for field in ("backend", "displayName", "license"):
        value = raw.get(field)
        if not isinstance(value, str) or not value or len(value) > 200:
            raise RuntimeError("packaged_model_manifest_invalid")
    files = raw.get("files")
    if not isinstance(files, dict) or frozenset(files) != EXPECTED_MODEL_FILES:
        raise RuntimeError("packaged_model_manifest_invalid")
    parsed_files: dict[str, ModelFile] = {}
    for filename, file_raw in files.items():
        if (
            not isinstance(file_raw, dict)
            or frozenset(file_raw) != frozenset({"bytes", "sha256"})
            or not isinstance(file_raw.get("bytes"), int)
            or isinstance(file_raw.get("bytes"), bool)
            or file_raw["bytes"] <= 0
            or not isinstance(file_raw.get("sha256"), str)
            or re.fullmatch(r"[a-f0-9]{64}", file_raw["sha256"]) is None
        ):
            raise RuntimeError("packaged_model_manifest_invalid")
        parsed_files[filename] = ModelFile(
            bytes=file_raw["bytes"],
            sha256=file_raw["sha256"],
        )
    return ModelManifest(
        tier=spec.tier,
        backend=raw["backend"],
        display_name=raw["displayName"],
        model_id=raw["modelId"],
        storage_directory=raw["storageDirectory"],
        revision=raw["revision"],
        license=raw["license"],
        files=parsed_files,
    )


MODEL_MANIFESTS = {
    tier: _parse_manifest(_manifest_path(spec.manifest_filename), spec)
    for tier, spec in TIER_SPECS.items()
}


def _send(output_stream: TextIO, payload: dict[str, Any]) -> None:
    output_stream.write(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    )
    output_stream.flush()


def _send_error(
    output_stream: TextIO,
    request_id: str | None,
    code: str,
    message: str,
) -> None:
    _send(
        output_stream,
        {"type": "error", "id": request_id, "code": code, "message": message},
    )


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise WorkerError("invalid_json", "request contains duplicate fields")
        result[key] = value
    return result


def _request_id(message: dict[str, Any]) -> str:
    value = message.get("id")
    if not isinstance(value, str) or len(value) > 36:
        raise WorkerError("invalid_request_id", "request id must be a UUID")
    try:
        parsed = uuid.UUID(value)
    except ValueError as error:
        raise WorkerError("invalid_request_id", "request id must be a UUID") from error
    if str(parsed) != value:
        raise WorkerError("invalid_request_id", "request id must be a canonical UUID")
    return value


def _strict_fields(message: dict[str, Any], expected: frozenset[str]) -> None:
    received = frozenset(message)
    if received != expected:
        raise WorkerError("invalid_request", "request fields do not match the protocol")


def _string_field(
    message: dict[str, Any],
    field: str,
    *,
    max_chars: int,
    allow_empty: bool = False,
) -> str:
    value = message.get(field)
    if not isinstance(value, str):
        raise WorkerError("invalid_request", f"{field} must be a string")
    if not allow_empty and not value:
        raise WorkerError("invalid_request", f"{field} must not be empty")
    if len(value) > max_chars:
        raise WorkerError("invalid_request", f"{field} is too long")
    return value


def _normalize_language(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > MAX_LANGUAGE_CHARS:
        raise WorkerError("invalid_language", "language is invalid")
    normalized = value.strip().lower()
    if normalized in ("", "auto"):
        return None
    if normalized in SUPPORTED_LANGUAGE_CODES:
        return normalized
    code = LANGUAGE_NAME_TO_CODE.get(normalized)
    if code is not None:
        return code
    raise WorkerError("invalid_language", "language is not supported")


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return path != root


def _bounded_absolute_directory(raw_path: str, *, create: bool) -> Path:
    if not raw_path or len(raw_path) > MAX_PATH_CHARS:
        raise WorkerError("invalid_model_root", "modelRoot is invalid")
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        raise WorkerError("invalid_model_root", "modelRoot must be absolute")
    try:
        if create and not candidate.exists():
            candidate.mkdir(parents=True, exist_ok=True, mode=0o700)
        metadata = candidate.lstat()
        if candidate.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
            raise WorkerError(
                "invalid_model_root",
                "modelRoot must be a regular directory",
            )
        resolved = candidate.resolve(strict=True)
    except WorkerError:
        raise
    except OSError as error:
        raise WorkerError("invalid_model_root", "modelRoot is unavailable") from error
    if resolved == Path(resolved.anchor):
        raise WorkerError("invalid_model_root", "modelRoot must be a non-root directory")
    return resolved


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(16 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _valid_model_directory(
    model_directory: Path,
    manifest: ModelManifest,
) -> bool:
    try:
        directory_metadata = model_directory.lstat()
        if model_directory.is_symlink() or not stat.S_ISDIR(directory_metadata.st_mode):
            return False
        if frozenset(entry.name for entry in model_directory.iterdir()) != EXPECTED_MODEL_FILES:
            return False
        for filename, expected in manifest.files.items():
            candidate = model_directory / filename
            metadata = candidate.lstat()
            if candidate.is_symlink() or not stat.S_ISREG(metadata.st_mode):
                return False
            if metadata.st_size != expected.bytes or _sha256(candidate) != expected.sha256:
                return False
        return True
    except OSError:
        return False


def _safe_rmtree(path: Path, root: Path) -> None:
    if not path.exists():
        return
    try:
        metadata = path.lstat()
    except OSError as error:
        raise WorkerError("unsafe_model_path", "model path is unavailable") from error
    if path.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
        raise WorkerError("unsafe_model_path", "refusing to remove a non-directory model path")
    resolved = path.resolve(strict=True)
    if not _is_within(resolved, root):
        raise WorkerError("unsafe_model_path", "refusing to remove an unbounded path")
    shutil.rmtree(resolved)


def ensure_model(
    model_root: Path,
    manifest: ModelManifest,
    allow_download: bool,
    *,
    snapshot_downloader: SnapshotDownloader | None = None,
) -> Path:
    model_root = _bounded_absolute_directory(str(model_root), create=True)
    final_directory = model_root / manifest.storage_directory
    if _valid_model_directory(final_directory, manifest):
        return final_directory
    if not allow_download:
        raise WorkerError(
            "model_not_installed",
            "install the selected local speech model before dictating",
        )

    staging = Path(
        tempfile.mkdtemp(
            prefix=f".whisper-{manifest.tier}-staging-",
            dir=model_root,
        )
    )
    backup: Path | None = None
    try:
        if snapshot_downloader is None:
            with contextlib.redirect_stdout(sys.stderr):
                from huggingface_hub import snapshot_download

            snapshot_downloader = snapshot_download
        try:
            with contextlib.redirect_stdout(sys.stderr):
                snapshot_downloader(
                    repo_id=manifest.model_id,
                    revision=manifest.revision,
                    local_dir=staging,
                    allow_patterns=sorted(EXPECTED_MODEL_FILES),
                    max_workers=4,
                    token=False,
                )
        except WorkerError:
            raise
        except Exception as error:
            raise WorkerError("model_download_failed", "model download failed") from error

        hub_metadata = staging / ".cache"
        if hub_metadata.exists():
            _safe_rmtree(hub_metadata, staging)
        if not _valid_model_directory(staging, manifest):
            raise WorkerError(
                "model_checksum_failed",
                "downloaded model verification failed",
            )

        if final_directory.exists():
            try:
                metadata = final_directory.lstat()
            except OSError as error:
                raise WorkerError(
                    "unsafe_model_path",
                    "installed model path is unavailable",
                ) from error
            if final_directory.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
                raise WorkerError(
                    "unsafe_model_path",
                    "installed model path is not a regular directory",
                )
            backup = model_root / f".replaced-{manifest.tier}-{uuid.uuid4().hex}"
            final_directory.replace(backup)
        try:
            staging.replace(final_directory)
        except Exception:
            if backup is not None and backup.exists() and not final_directory.exists():
                backup.replace(final_directory)
            raise
        if backup is not None and backup.exists():
            _safe_rmtree(backup, model_root)
        return final_directory
    finally:
        if staging.exists():
            _safe_rmtree(staging, model_root)


def _read_validated_pcm16(audio_path_raw: str, allowed_root_raw: str) -> bytes:
    if (
        not audio_path_raw
        or not allowed_root_raw
        or len(audio_path_raw) > MAX_PATH_CHARS
        or len(allowed_root_raw) > MAX_PATH_CHARS
    ):
        raise WorkerError("invalid_audio_path", "audio path is invalid")
    audio_candidate = Path(audio_path_raw)
    root_candidate = Path(allowed_root_raw)
    if not audio_candidate.is_absolute() or not root_candidate.is_absolute():
        raise WorkerError("invalid_audio_path", "audio paths must be absolute")
    try:
        root_metadata = root_candidate.lstat()
        audio_metadata = audio_candidate.lstat()
        if root_candidate.is_symlink() or not stat.S_ISDIR(root_metadata.st_mode):
            raise WorkerError(
                "invalid_audio_path",
                "allowedRoot must be a regular directory",
            )
        if audio_candidate.is_symlink() or not stat.S_ISREG(audio_metadata.st_mode):
            raise WorkerError("invalid_audio_file", "audio must be a regular WAV file")
        allowed_root = root_candidate.resolve(strict=True)
        audio_path = audio_candidate.resolve(strict=True)
    except WorkerError:
        raise
    except OSError as error:
        raise WorkerError("invalid_audio_path", "audio file is unavailable") from error
    if not _is_within(audio_path, allowed_root):
        raise WorkerError("audio_path_not_allowed", "audio file is outside the allowed root")
    if audio_path.suffix.lower() != ".wav":
        raise WorkerError("invalid_audio_file", "audio must be a WAV file")
    if audio_metadata.st_size <= WAV_HEADER_BYTES or audio_metadata.st_size > MAX_AUDIO_BYTES:
        raise WorkerError("invalid_audio_file", "audio file size is invalid")
    try:
        with audio_path.open("rb") as source:
            opened_metadata = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(opened_metadata.st_mode)
                or opened_metadata.st_dev != audio_metadata.st_dev
                or opened_metadata.st_ino != audio_metadata.st_ino
            ):
                raise WorkerError("invalid_audio_file", "audio file changed during validation")
            with wave.open(source, "rb") as wav:
                frame_count = wav.getnframes()
                if (
                    wav.getnchannels() != REQUIRED_CHANNELS
                    or wav.getsampwidth() != REQUIRED_SAMPLE_WIDTH_BYTES
                    or wav.getframerate() != REQUIRED_SAMPLE_RATE
                    or wav.getcomptype() != "NONE"
                    or frame_count <= 0
                    or frame_count > MAX_AUDIO_FRAMES
                ):
                    raise WorkerError(
                        "invalid_audio_format",
                        "audio must be mono 16 kHz PCM16 WAV",
                    )
                expected_payload_bytes = (
                    frame_count * REQUIRED_CHANNELS * REQUIRED_SAMPLE_WIDTH_BYTES
                )
                if expected_payload_bytes > MAX_AUDIO_BYTES:
                    raise WorkerError("invalid_audio_file", "audio payload is too large")
                pcm16 = wav.readframes(frame_count)
                if len(pcm16) != expected_payload_bytes:
                    raise WorkerError("invalid_audio_file", "audio WAV is truncated")
                return pcm16
    except WorkerError:
        raise
    except (EOFError, OSError, wave.Error) as error:
        raise WorkerError("invalid_audio_file", "audio WAV is malformed") from error


def _run_read_only_command(command: list[str]) -> str:
    try:
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
            env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise WorkerError(
            "device_info_unavailable",
            "Apple unified memory information is unavailable",
        ) from error
    return completed.stdout.strip()


def read_apple_hardware_info() -> HardwareInfo:
    total_raw = _run_read_only_command(["/usr/sbin/sysctl", "-n", "hw.memsize"])
    vm_stat = _run_read_only_command(["/usr/bin/vm_stat"])
    try:
        total_bytes = int(total_raw)
        page_size_match = re.search(r"page size of (\d+) bytes", vm_stat)
        if page_size_match is None:
            raise ValueError("missing page size")
        page_size = int(page_size_match.group(1))
        page_counts: dict[str, int] = {}
        for line in vm_stat.splitlines():
            match = re.fullmatch(r"Pages ([A-Za-z ]+):\s+(\d+)\.", line.strip())
            if match is not None:
                page_counts[match.group(1).strip().lower()] = int(match.group(2))
        available_pages = sum(
            page_counts[name]
            for name in ("free", "inactive", "speculative")
            if name in page_counts
        )
        if (
            total_bytes <= 0
            or page_size <= 0
            or "free" not in page_counts
            or "inactive" not in page_counts
        ):
            raise ValueError("invalid memory statistics")
        available_bytes = min(total_bytes, max(0, available_pages * page_size))
    except (TypeError, ValueError) as error:
        raise WorkerError(
            "device_info_unavailable",
            "Apple unified memory information is unavailable",
        ) from error

    chip: str | None
    try:
        chip = _run_read_only_command(
            ["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"]
        )
        if not chip or len(chip) > 200:
            chip = None
    except WorkerError:
        chip = None
    return HardwareInfo(
        chip=chip,
        total_bytes=total_bytes,
        available_bytes=available_bytes,
    )


class MLXWhisperRuntime:
    def __init__(
        self,
        *,
        mlx_module: Any,
        numpy_module: Any,
        model_holder: Any,
        transcribe_function: Callable[..., Any],
        model: Any,
        model_path: str,
    ) -> None:
        self._mlx = mlx_module
        self._numpy = numpy_module
        self._model_holder = model_holder
        self._transcribe_function = transcribe_function
        self._model = model
        self._model_path = model_path

    @classmethod
    def load(cls, model_directory: Path, _spec: TierSpec) -> "MLXWhisperRuntime":
        if not model_directory.is_absolute():
            raise WorkerError("model_load_failed", "local model path is invalid")
        try:
            with contextlib.redirect_stdout(sys.stderr):
                import mlx.core as mx
                import numpy as np
                from mlx_whisper.load_models import load_model
                from mlx_whisper.transcribe import ModelHolder, transcribe
        except Exception as error:
            raise WorkerError(
                "runtime_import_failed",
                "MLX Whisper runtime dependencies are unavailable",
            ) from error
        model_path = str(model_directory)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                model = load_model(model_path, dtype=mx.float16)
        except Exception as error:
            raise WorkerError(
                "model_load_failed",
                "Whisper large-v3 could not be loaded with MLX",
            ) from error
        # mlx-whisper's public transcribe entrypoint owns this single-process
        # holder. Pre-populating it makes load_model an actual load boundary and
        # guarantees transcribe receives only the already-verified local path.
        ModelHolder.model = model
        ModelHolder.model_path = model_path
        return cls(
            mlx_module=mx,
            numpy_module=np,
            model_holder=ModelHolder,
            transcribe_function=transcribe,
            model=model,
            model_path=model_path,
        )

    def transcribe(
        self,
        pcm16: bytes,
        *,
        language: str | None,
        context: str,
    ) -> TranscriptionResult:
        if self._model is None:
            raise WorkerError("model_not_loaded", "ASR model is not loaded")
        waveform = (
            self._numpy.frombuffer(pcm16, dtype="<i2").astype(self._numpy.float32)
            / 32768.0
        )
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = self._transcribe_function(
                    waveform,
                    path_or_hf_repo=self._model_path,
                    verbose=None,
                    language=language,
                    initial_prompt=context or None,
                    fp16=True,
                )
        except WorkerError:
            raise
        except Exception as error:
            raise WorkerError("transcription_failed", "local transcription failed") from error
        if not isinstance(result, dict):
            raise WorkerError(
                "invalid_model_output",
                "model returned an invalid transcription",
            )
        text = result.get("text")
        detected_language = result.get("language")
        if not isinstance(text, str) or len(text) > MAX_RESULT_CHARS:
            raise WorkerError(
                "invalid_model_output",
                "model returned an invalid transcription",
            )
        if (
            detected_language is not None
            and (
                not isinstance(detected_language, str)
                or len(detected_language) > MAX_LANGUAGE_CHARS
            )
        ):
            detected_language = None
        return TranscriptionResult(
            text=text,
            language=detected_language or language,
        )

    def close(self) -> None:
        try:
            self._mlx.synchronize()
        except Exception:
            pass
        if self._model_holder.model is self._model:
            self._model_holder.model = None
            self._model_holder.model_path = None
        self._model = None
        gc.collect()
        try:
            self._mlx.metal.clear_cache()
        except Exception:
            pass


def _read_limited_line(input_stream: BinaryIO) -> tuple[bytes, bool]:
    line = input_stream.readline(MAX_REQUEST_BYTES + 1)
    if not line:
        return b"", False
    if len(line) <= MAX_REQUEST_BYTES:
        return line, False
    while line and not line.endswith(b"\n"):
        line = input_stream.readline(MAX_REQUEST_BYTES + 1)
    return b"", True


def _default_model_installer(
    model_root: Path,
    manifest: ModelManifest,
    allow_download: bool,
) -> Path:
    return ensure_model(model_root, manifest, allow_download)


def _close_runtime(runtime: InferenceRuntime | None) -> None:
    if runtime is None:
        return
    try:
        runtime.close()
    except Exception:
        pass


def run_worker(
    *,
    input_stream: BinaryIO,
    output_stream: TextIO,
    error_stream: TextIO,
    model_installer: ModelInstaller = _default_model_installer,
    runtime_factory: RuntimeFactory = MLXWhisperRuntime.load,
    hardware_probe: HardwareProbe = read_apple_hardware_info,
    platform_name: str | None = None,
    machine_name: str | None = None,
) -> int:
    runtime: InferenceRuntime | None = None
    active_spec: TierSpec | None = None
    active_model_root: Path | None = None
    platform_name = platform_name or sys.platform
    machine_name = machine_name or platform.machine()
    _send(
        output_stream,
        {
            "type": "hello",
            "protocol": PROTOCOL_VERSION,
            "backend": BACKEND_NAME,
            "version": BACKEND_VERSION,
        },
    )

    try:
        while True:
            raw_line, too_large = _read_limited_line(input_stream)
            if too_large:
                _send_error(
                    output_stream,
                    None,
                    "request_too_large",
                    "request exceeds 16 KiB",
                )
                continue
            if not raw_line:
                return 0

            request_id: str | None = None
            try:
                try:
                    message = json.loads(
                        raw_line.decode("utf-8"),
                        object_pairs_hook=_reject_duplicate_keys,
                    )
                except WorkerError:
                    raise
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise WorkerError(
                        "invalid_json",
                        "request must be one JSON object",
                    ) from error
                if not isinstance(message, dict):
                    raise WorkerError("invalid_request", "request must be a JSON object")
                request_id = _request_id(message)
                message_type = _string_field(message, "type", max_chars=64)

                if message_type == "load_model":
                    _strict_fields(
                        message,
                        frozenset(
                            {
                                "type",
                                "id",
                                "tier",
                                "modelId",
                                "computeType",
                                "modelRoot",
                                "allowDownload",
                            }
                        ),
                    )
                    if platform_name != "darwin" or machine_name != "arm64":
                        raise WorkerError(
                            "apple_silicon_only",
                            "MLX Whisper worker requires Apple silicon",
                        )
                    tier = _string_field(message, "tier", max_chars=16)
                    spec = TIER_SPECS.get(tier)
                    if spec is None:
                        raise WorkerError("model_not_allowed", "requested tier is not allowed")
                    model_id = _string_field(message, "modelId", max_chars=200)
                    compute_type = _string_field(
                        message,
                        "computeType",
                        max_chars=16,
                    )
                    if (
                        model_id != spec.model_id
                        or compute_type != spec.compute_type
                    ):
                        raise WorkerError(
                            "model_not_allowed",
                            "tier, modelId, and computeType must match the model catalog",
                        )
                    allow_download = message.get("allowDownload")
                    if not isinstance(allow_download, bool):
                        raise WorkerError(
                            "allow_download_required",
                            "load_model must explicitly allow or forbid model download",
                        )
                    model_root_raw = _string_field(
                        message,
                        "modelRoot",
                        max_chars=MAX_PATH_CHARS,
                    )
                    model_root = _bounded_absolute_directory(
                        model_root_raw,
                        create=True,
                    )
                    manifest = MODEL_MANIFESTS[tier]
                    if (
                        runtime is not None
                        and active_spec == spec
                        and active_model_root == model_root
                    ):
                        _send(
                            output_stream,
                            {
                                "type": "model_ready",
                                "id": request_id,
                                "tier": spec.tier,
                                "modelId": spec.model_id,
                                "computeType": spec.compute_type,
                                "loadMs": 0,
                            },
                        )
                        continue
                    if not allow_download and not _valid_model_directory(
                        model_root / manifest.storage_directory,
                        manifest,
                    ):
                        raise WorkerError(
                            "model_not_installed",
                            "install the selected local speech model before dictating",
                        )

                    _close_runtime(runtime)
                    runtime = None
                    active_spec = None
                    active_model_root = None
                    started = time.perf_counter()
                    local_model = model_installer(
                        model_root,
                        manifest,
                        allow_download,
                    )
                    expected_local_model = (
                        model_root / manifest.storage_directory
                    ).resolve(strict=False)
                    if (
                        not local_model.is_absolute()
                        or local_model.resolve(strict=False) != expected_local_model
                    ):
                        raise WorkerError(
                            "unsafe_model_path",
                            "model installer returned an unapproved path",
                        )
                    runtime = runtime_factory(local_model, spec)
                    active_spec = spec
                    active_model_root = model_root
                    _send(
                        output_stream,
                        {
                            "type": "model_ready",
                            "id": request_id,
                            "tier": spec.tier,
                            "modelId": spec.model_id,
                            "computeType": spec.compute_type,
                            "loadMs": round((time.perf_counter() - started) * 1000),
                        },
                    )
                elif message_type == "health":
                    _strict_fields(message, frozenset({"type", "id"}))
                    _send(
                        output_stream,
                        {"type": "health", "id": request_id, "ready": runtime is not None},
                    )
                elif message_type == "device_info":
                    _strict_fields(message, frozenset({"type", "id"}))
                    if platform_name != "darwin" or machine_name != "arm64":
                        raise WorkerError(
                            "apple_silicon_only",
                            "MLX Whisper worker requires Apple silicon",
                        )
                    hardware = hardware_probe()
                    if (
                        not isinstance(hardware.total_bytes, int)
                        or isinstance(hardware.total_bytes, bool)
                        or hardware.total_bytes <= 0
                        or not isinstance(hardware.available_bytes, int)
                        or isinstance(hardware.available_bytes, bool)
                        or hardware.available_bytes < 0
                        or hardware.available_bytes > hardware.total_bytes
                        or (
                            hardware.chip is not None
                            and (
                                not isinstance(hardware.chip, str)
                                or not hardware.chip
                                or len(hardware.chip) > 200
                            )
                        )
                    ):
                        raise WorkerError(
                            "device_info_unavailable",
                            "Apple unified memory information is unavailable",
                        )
                    _send(
                        output_stream,
                        {
                            "type": "device_info",
                            "id": request_id,
                            "hardware": hardware.protocol_payload(),
                        },
                    )
                elif message_type == "transcribe":
                    _strict_fields(
                        message,
                        frozenset(
                            {
                                "type",
                                "id",
                                "audioPath",
                                "allowedRoot",
                                "language",
                                "context",
                            }
                        ),
                    )
                    if runtime is None:
                        raise WorkerError("model_not_loaded", "ASR model is not loaded")
                    audio_path_raw = _string_field(
                        message,
                        "audioPath",
                        max_chars=MAX_PATH_CHARS,
                    )
                    allowed_root_raw = _string_field(
                        message,
                        "allowedRoot",
                        max_chars=MAX_PATH_CHARS,
                    )
                    pcm16 = _read_validated_pcm16(
                        audio_path_raw,
                        allowed_root_raw,
                    )
                    context = message.get("context")
                    if not isinstance(context, str) or len(context) > MAX_CONTEXT_CHARS:
                        raise WorkerError(
                            "invalid_context",
                            "context must be at most 4000 characters",
                        )
                    language = _normalize_language(message.get("language"))
                    started = time.perf_counter()
                    result = runtime.transcribe(
                        pcm16,
                        language=language,
                        context=context,
                    )
                    if (
                        not isinstance(result.text, str)
                        or len(result.text) > MAX_RESULT_CHARS
                        or (
                            result.language is not None
                            and (
                                not isinstance(result.language, str)
                                or len(result.language) > MAX_LANGUAGE_CHARS
                            )
                        )
                    ):
                        raise WorkerError(
                            "invalid_model_output",
                            "model returned an invalid transcription",
                        )
                    _send(
                        output_stream,
                        {
                            "type": "final",
                            "id": request_id,
                            "text": result.text,
                            "language": result.language,
                            "inferenceMs": round(
                                (time.perf_counter() - started) * 1000
                            ),
                        },
                    )
                elif message_type == "shutdown":
                    _strict_fields(message, frozenset({"type", "id"}))
                    _send(output_stream, {"type": "shutdown", "id": request_id})
                    return 0
                else:
                    raise WorkerError(
                        "unsupported_message_type",
                        "message type is not supported",
                    )
            except WorkerError as error:
                print(
                    f"[mac-asr-worker] {error.code}",
                    file=error_stream,
                    flush=True,
                )
                _send_error(
                    output_stream,
                    request_id,
                    error.code,
                    error.public_message,
                )
            except Exception as error:
                print(
                    f"[mac-asr-worker] internal_error:{type(error).__name__}",
                    file=error_stream,
                    flush=True,
                )
                _send_error(
                    output_stream,
                    request_id,
                    "internal_error",
                    "request failed",
                )
    finally:
        _close_runtime(runtime)
