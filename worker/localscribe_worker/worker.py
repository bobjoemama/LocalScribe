from __future__ import annotations

import base64
import contextlib
import gc
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import struct
import subprocess
import sys
import threading
import time
import uuid
import wave
from collections.abc import Callable
from dataclasses import dataclass, replace
from importlib.metadata import version as package_version
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Protocol, TextIO

from .model_metadata import is_inert_model_metadata as _is_inert_model_metadata

PROTOCOL_VERSION = 1
BACKEND_NAME = "localscribe-mlx-asr"
# Handshake both installed inference engines. The supervisor retains the exact
# release allowlist, so either dependency drifting fails closed.
BACKEND_VERSION = (
    f"mlx-whisper/{package_version('mlx-whisper')};"
    f"mlx-audio/{package_version('mlx-audio')}"
)

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
MAX_MANIFEST_FILE_ENTRIES = 64
MAX_HELPER_FRAME_BYTES = 256 * 1024
# Live audio travels over the existing line-delimited worker protocol. Keeping
# chunks at 8 KiB means strict base64 remains comfortably below the 16 KiB
# request ceiling while still representing 256 ms of 16 kHz PCM16.
MAX_LIVE_AUDIO_BYTES = 8 * 1024
FLUID_AUDIO_HELPER_PROTOCOL_VERSION = 1
FLUID_AUDIO_HELPER_RUNTIME = "FluidAudio CoreML / ANE"
FLUID_AUDIO_HELPER_VERSION = "0.15.5"
FLUID_AUDIO_HELPER_FILENAME = "localscribe-fluidaudio-parakeet"
MODEL_TRANSACTION_PREFIX = ".localscribe-model-install-"
MODEL_TRANSACTION_MARKER = "transaction.json"
MODEL_TRANSACTION_OWNER = "com.localscribe.model-install"
MODEL_TRANSACTION_SCHEMA_VERSION = 1
MODEL_TRANSACTION_FIELDS = frozenset(
    {
        "schemaVersion",
        "owner",
        "transactionId",
        "backend",
        "modelId",
        "artifactId",
        "storageDirectory",
        "revision",
        "manifestDigest",
    }
)
MODEL_TRANSACTION_NAME = re.compile(
    rf"^{re.escape(MODEL_TRANSACTION_PREFIX)}([0-9a-f]{{32}})$"
)

EXPECTED_MANIFEST_FIELDS = frozenset(
    {
        "schemaVersion",
        "platform",
        "backend",
        "displayName",
        "modelId",
        "familyId",
        "artifactId",
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

# A manifest file name is a portable, canonical POSIX relative path. CoreML
# models are directory bundles (``Encoder.mlmodelc/weights/weight.bin``), so
# flat-name-only manifests are insufficient. Keep the grammar deliberately
# narrower than a generic filesystem path: no empty segments, dot segments,
# backslashes, or platform-specific absolute paths can reach the installer.
MANIFEST_RELATIVE_PATH = re.compile(
    r"(?:[A-Za-z0-9][A-Za-z0-9._-]*/)*(?:\.gitattributes|[A-Za-z0-9][A-Za-z0-9._-]*)$"
)


@dataclass(frozen=True)
class TierSpec:
    tier: str
    manifest_filename: str
    model_id: str
    family_id: str
    artifact_id: str
    revision: str
    storage_directory: str
    compute_type: str
    asr_mode: str = "after-stop"


CatalogSelection = tuple[str, str, str]


@dataclass(frozen=True)
class ModelTreeIdentity:
    """No-follow identity of the exact manifest-owned tree about to be loaded."""

    root: tuple[int, int, int, int, int]
    directory: tuple[int, int, int, int, int]
    files: tuple[tuple[str, int, int, int, int, int], ...]


@dataclass(frozen=True)
class VerifiedModelArtifact:
    path: Path
    identity: ModelTreeIdentity


def _catalog_selection(spec: TierSpec) -> CatalogSelection:
    """Return the protocol's complete, fixed model-selection identity."""
    return (spec.model_id, spec.tier, spec.compute_type)


# Immutable repository/revision/artifact identity comes from these packaged,
# resource-integrity-covered manifests. Only the manifest filename and the
# runtime compute profile remain an executable allowlist: a renderer cannot
# supply either, and adding a curated model still requires a signed app build.
CURATED_PROFILE_POLICIES = (
    ("canary-qwen-2-5b-gguf-bf16.json", "high", "bfloat16", "transcribe.cpp / Metal"),
    ("canary-qwen-2-5b-gguf-q8.json", "medium", "int8", "transcribe.cpp / Metal"),
    ("canary-qwen-2-5b-gguf-q4.json", "low", "int4", "transcribe.cpp / Metal"),
    ("whisper-large-v3-mlx.json", "high", "float16", "MLX Whisper"),
    ("qwen3-asr-1-7b-mlx-bf16.json", "high", "bfloat16", "MLX Audio"),
    ("qwen3-asr-1-7b-mlx-8bit.json", "medium", "int8", "MLX Audio"),
    ("qwen3-asr-1-7b-mlx-4bit.json", "low", "int4", "MLX Audio"),
    ("qwen3-asr-0-6b-mlx-bf16.json", "high", "bfloat16", "MLX Audio"),
    ("qwen3-asr-0-6b-mlx-8bit.json", "medium", "int8", "MLX Audio"),
    ("qwen3-asr-0-6b-mlx-4bit.json", "low", "int4", "MLX Audio"),
    (
        "parakeet-unified-en-0-6b-coreml-fp16.json",
        "high",
        "coreml-fp16",
        "FluidAudio CoreML / ANE",
    ),
    (
        "parakeet-unified-en-0-6b-coreml-int8.json",
        "medium",
        "coreml-int8",
        "FluidAudio CoreML / ANE",
    ),
)
MANIFEST_FILENAMES = frozenset(
    filename for filename, _tier, _compute_type, _backend in CURATED_PROFILE_POLICIES
)
MODEL_REQUEST_FIELDS = frozenset(
    {
        "type",
        "id",
        "tier",
        "modelId",
        "computeType",
        "modelRoot",
        "allowDownload",
    }
)
LOAD_MODEL_REQUEST_FIELDS = MODEL_REQUEST_FIELDS | frozenset({"asrMode"})


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
    family_id: str
    artifact_id: str
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

    def release_transient_memory(self) -> None: ...

    def close(self) -> None: ...


ModelInstaller = Callable[[Path, ModelManifest, bool], Path]
RuntimeFactory = Callable[[Path, TierSpec], InferenceRuntime]
HardwareProbe = Callable[[], HardwareInfo]
SnapshotDownloader = Callable[..., Any]
ModelInstallProgressCallback = Callable[[str, int, int], None]


class ModelInstallProgress:
    """Emit bounded, byte-accurate progress for one install transaction.

    The UI receives only bytes actually reconstructed by Hugging Face or read
    while digest-verifying a manifest file. The denominator is the pinned
    artifact byte total, never an estimate from the network response.
    """

    def __init__(
        self,
        manifest: ModelManifest,
        emit: ModelInstallProgressCallback,
    ) -> None:
        total = sum(file.bytes for file in manifest.files.values())
        if total <= 0 or total > 2**53 - 1:
            raise WorkerError("invalid_model_manifest", "model artifact size is invalid")
        self._emit = emit
        self._total = total
        self._phase = ""
        self._completed = 0

    def begin(self, phase: str) -> None:
        if phase not in {"downloading", "verifying"}:
            raise ValueError("invalid install progress phase")
        self._phase = phase
        self._completed = 0
        self._emit(phase, 0, self._total)

    def advance(self, count: int | float | None) -> None:
        if self._phase == "" or count is None:
            return
        # Hugging Face's progress interface accepts numeric values. Its own
        # file/reconstruction callbacks are whole bytes; reject an unexpected
        # value rather than inventing a rounded byte count for the UI.
        if isinstance(count, bool) or not isinstance(count, int) or count <= 0:
            return
        self._completed = min(self._total, self._completed + count)
        self._emit(self._phase, self._completed, self._total)


def _snapshot_download_progress_class(
    progress: ModelInstallProgress,
) -> type[Any]:
    """Adapt Hugging Face's snapshot reconstruction bar to our JSON protocol.

    `snapshot_download` owns several bars: file count, network transfer, and
    reconstruction. Only reconstruction is the final artifact written to the
    staging directory, so only its byte updates are safe to represent as model
    installation progress. This minimal adapter deliberately has no terminal
    output: stdout is reserved for the worker line protocol.
    """

    class SnapshotDownloadProgress:
        _lock = threading.RLock()

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self._iterable = args[0] if args else None
            self.total = kwargs.get("total")
            self.n = kwargs.get("initial", 0)
            self._reconstructing = (
                kwargs.get("unit") == "B"
                and str(kwargs.get("desc", "")).startswith("Reconstructing")
            )

        def __enter__(self) -> SnapshotDownloadProgress:
            return self

        def __exit__(self, *args: Any) -> None:
            self.close()

        @classmethod
        def get_lock(cls) -> Any:
            return cls._lock

        @classmethod
        def set_lock(cls, lock: Any) -> None:
            cls._lock = lock

        def __iter__(self):
            if self._iterable is None:
                return
            for item in self._iterable:
                self.update(1)
                yield item

        def close(self) -> None:
            return

        def refresh(self, *args: Any, **kwargs: Any) -> None:
            del args, kwargs
            return

        def update(self, count: int | float | None = 1) -> None:
            if isinstance(count, int) and not isinstance(count, bool):
                self.n += count
            if self._reconstructing:
                progress.advance(count)

        def update_transfer(self, count: int | float | None = 1) -> None:
            # Transfer bytes may exceed the pinned artifact total on a retry.
            # Reconstruction is the exact on-disk artifact measure instead.
            del count
            return

        def set_description(self, *args: Any, **kwargs: Any) -> None:
            del args, kwargs
            return

        def set_postfix_str(self, *args: Any, **kwargs: Any) -> None:
            del args, kwargs
            return

        def set_transfer_postfix_str(self, *args: Any, **kwargs: Any) -> None:
            del args, kwargs
            return

    return SnapshotDownloadProgress


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise WorkerError("invalid_json", "JSON contains duplicate fields")
        result[key] = value
    return result


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


def _parse_manifest(path: Path, tier: str, expected_backend: str) -> ModelManifest:
    try:
        metadata = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
            raise RuntimeError("packaged_model_manifest_invalid")
        raw = json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
        )
    except WorkerError as error:
        raise RuntimeError("packaged_model_manifest_invalid") from error
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("packaged_model_manifest_invalid") from error
    if not isinstance(raw, dict) or frozenset(raw) != EXPECTED_MANIFEST_FIELDS:
        raise RuntimeError("packaged_model_manifest_invalid")
    if raw.get("schemaVersion") != 1 or raw.get("platform") != "darwin-arm64":
        raise RuntimeError("packaged_model_manifest_invalid")
    if raw.get("backend") != expected_backend:
        raise RuntimeError("packaged_model_manifest_backend_mismatch")
    for field in ("displayName", "license"):
        value = raw.get(field)
        if not isinstance(value, str) or not value or len(value) > 200:
            raise RuntimeError("packaged_model_manifest_invalid")
    model_id = raw.get("modelId")
    family_id = raw.get("familyId")
    artifact_id = raw.get("artifactId")
    storage_directory = raw.get("storageDirectory")
    revision = raw.get("revision")
    if (
        not isinstance(model_id, str)
        or re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}",
            model_id,
        )
        is None
        or not isinstance(family_id, str)
        or re.fullmatch(r"[a-z0-9][a-z0-9-]*", family_id) is None
        or not isinstance(artifact_id, str)
        or re.fullmatch(r"[a-z0-9][a-z0-9-]*", artifact_id) is None
        or not isinstance(storage_directory, str)
        or re.fullmatch(r"[a-z0-9][a-z0-9._-]*", storage_directory) is None
        or not isinstance(revision, str)
        or re.fullmatch(r"[a-f0-9]{40}", revision) is None
    ):
        raise RuntimeError("packaged_model_manifest_invalid")
    files = raw.get("files")
    if (
        not isinstance(files, dict)
        or not files
        or len(files) > MAX_MANIFEST_FILE_ENTRIES
    ):
        raise RuntimeError("packaged_model_manifest_invalid")
    parsed_files: dict[str, ModelFile] = {}
    for filename, file_raw in files.items():
        if (
            not isinstance(filename, str)
            or MANIFEST_RELATIVE_PATH.fullmatch(filename) is None
            or not isinstance(file_raw, dict)
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
        tier=tier,
        backend=raw["backend"],
        display_name=raw["displayName"],
        model_id=model_id,
        family_id=family_id,
        artifact_id=artifact_id,
        storage_directory=storage_directory,
        revision=revision,
        license=raw["license"],
        files=parsed_files,
    )


TIER_SPECS: dict[CatalogSelection, TierSpec] = {}
MODEL_MANIFESTS: dict[CatalogSelection, ModelManifest] = {}
for manifest_filename, tier, compute_type, expected_backend in CURATED_PROFILE_POLICIES:
    manifest = _parse_manifest(
        _manifest_path(manifest_filename),
        tier,
        expected_backend,
    )
    spec = TierSpec(
        tier=tier,
        manifest_filename=manifest_filename,
        model_id=manifest.model_id,
        family_id=manifest.family_id,
        artifact_id=manifest.artifact_id,
        revision=manifest.revision,
        storage_directory=manifest.storage_directory,
        compute_type=compute_type,
    )
    selection = _catalog_selection(spec)
    if selection in TIER_SPECS:
        raise RuntimeError("duplicate_model_catalog_selection")
    TIER_SPECS[selection] = spec
    MODEL_MANIFESTS[selection] = manifest


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


def _reject_request_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
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


def _sha256_with_progress(
    path: Path,
    on_chunk: Callable[[int], None] | None = None,
) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(16 * 1024 * 1024), b""):
            digest.update(chunk)
            if on_chunk is not None:
                on_chunk(len(chunk))
    return digest.hexdigest()


def _sha256(path: Path) -> str:
    """Hash a file without progress, preserving the testable primitive API."""
    return _sha256_with_progress(path)


def _sha256_with_identity(
    path: Path,
    on_chunk: Callable[[int], None] | None = None,
) -> tuple[str, tuple[str, int, int, int, int, int]]:
    """Hash bytes from one fd and bind the digest to that fd's identity."""
    before_path = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(before_path.st_mode):
        raise RuntimeError("model_file_identity_changed")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        before_fd = os.fstat(handle.fileno())
        if (
            not stat.S_ISREG(before_fd.st_mode)
            or before_fd.st_dev != before_path.st_dev
            or before_fd.st_ino != before_path.st_ino
        ):
            raise RuntimeError("model_file_identity_changed")
        for chunk in iter(lambda: handle.read(16 * 1024 * 1024), b""):
            digest.update(chunk)
            if on_chunk is not None:
                on_chunk(len(chunk))
        after_fd = os.fstat(handle.fileno())
    after_path = path.lstat()
    fd_identity = (
        before_fd.st_dev,
        before_fd.st_ino,
        before_fd.st_size,
        before_fd.st_mtime_ns,
        before_fd.st_ctime_ns,
    )
    if (
        fd_identity
        != (
            after_fd.st_dev,
            after_fd.st_ino,
            after_fd.st_size,
            after_fd.st_mtime_ns,
            after_fd.st_ctime_ns,
        )
        or fd_identity
        != (
            after_path.st_dev,
            after_path.st_ino,
            after_path.st_size,
            after_path.st_mtime_ns,
            after_path.st_ctime_ns,
        )
    ):
        raise RuntimeError("model_file_identity_changed")
    return digest.hexdigest(), (path.name, *fd_identity)


def _manifest_file_path(root: Path, filename: str) -> Path:
    """Materialize a previously validated canonical POSIX manifest path."""
    # Parsing does not accept ``.`` / ``..`` / empty segments / backslashes.
    # Keep this defensive check near every filesystem boundary nevertheless:
    # callers must never turn an unvalidated path into an on-disk location.
    if MANIFEST_RELATIVE_PATH.fullmatch(filename) is None:
        raise WorkerError("unsafe_model_path", "model manifest path is invalid")
    relative = PurePosixPath(filename)
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        raise WorkerError("unsafe_model_path", "model manifest path is invalid")
    return root.joinpath(*relative.parts)


def _exact_model_file_set(
    model_directory: Path,
    manifest: ModelManifest,
    *,
    ignored_root_directories: frozenset[str] = frozenset(),
) -> bool:
    """Require exactly the manifest's regular files, recursively and safely."""
    expected_names = frozenset(manifest.files)
    observed_names: set[str] = set()
    try:
        root_metadata = model_directory.lstat()
        if model_directory.is_symlink() or not stat.S_ISDIR(root_metadata.st_mode):
            return False
        for current_root, directory_names, file_names in os.walk(
            model_directory,
            topdown=True,
            followlinks=False,
        ):
            current = Path(current_root)
            relative_parent = current.relative_to(model_directory)
            for directory_name in tuple(directory_names):
                candidate = current / directory_name
                metadata = candidate.lstat()
                if candidate.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
                    return False
                relative = (relative_parent / directory_name).as_posix()
                if relative_parent == Path(".") and relative in ignored_root_directories:
                    directory_names.remove(directory_name)
                    continue
                # A directory must be an ancestor of one declared file. This
                # rejects `.DS_Store`/`.cache` directories and arbitrary empty
                # trees rather than merely ignoring them during os.walk.
                if not any(name.startswith(f"{relative}/") for name in expected_names):
                    return False
            for file_name in file_names:
                candidate = current / file_name
                metadata = candidate.lstat()
                if candidate.is_symlink() or not stat.S_ISREG(metadata.st_mode):
                    return False
                relative = (relative_parent / file_name).as_posix()
                if relative in expected_names:
                    observed_names.add(relative)
                    continue
                if not _is_inert_model_metadata(PurePosixPath(relative), expected_names):
                    return False
        return observed_names == expected_names
    except (OSError, ValueError):
        return False


def _valid_model_directory(
    model_directory: Path,
    manifest: ModelManifest,
    *,
    verify_digests: bool = True,
    on_verified_bytes: Callable[[int], None] | None = None,
    verified_identity_out: list[ModelTreeIdentity] | None = None,
) -> bool:
    """Check an installed artifact against its pinned manifest.

    ``verify_digests=False`` keeps every structural check — no symlinks, the
    exact file set, regular files only, exact byte counts — but skips the
    SHA-256 pass. It exists for the one caller that only needs to know whether
    an artifact is installed at all, and whose answer is immediately followed by
    an authoritative digest-verifying check. Never use it to decide whether an
    artifact may be loaded.
    """
    try:
        if verified_identity_out is not None:
            verified_identity_out.clear()
            if not verify_digests:
                return False
        root_metadata = model_directory.parent.lstat()
        directory_metadata = model_directory.lstat()
        if not _exact_model_file_set(model_directory, manifest):
            return False
        file_identities: list[tuple[str, int, int, int, int, int]] = []
        for filename, expected in sorted(manifest.files.items()):
            candidate = _manifest_file_path(model_directory, filename)
            metadata = candidate.lstat()
            if candidate.is_symlink() or not stat.S_ISREG(metadata.st_mode):
                return False
            if metadata.st_size != expected.bytes:
                return False
            if verify_digests:
                if verified_identity_out is not None:
                    digest, opened_identity = _sha256_with_identity(
                        candidate,
                        on_verified_bytes,
                    )
                    file_identities.append((filename, *opened_identity[1:]))
                else:
                    digest = (
                        _sha256_with_progress(candidate, on_verified_bytes)
                        if on_verified_bytes is not None
                        else _sha256(candidate)
                    )
                if digest != expected.sha256:
                    return False
        if verified_identity_out is not None:
            final_root_metadata = model_directory.parent.lstat()
            final_directory_metadata = model_directory.lstat()
            if (
                _path_identity(root_metadata) != _path_identity(final_root_metadata)
                or _path_identity(directory_metadata)
                != _path_identity(final_directory_metadata)
                or not _exact_model_file_set(model_directory, manifest)
            ):
                return False
            verified_identity_out.append(ModelTreeIdentity(
                root=_path_identity(final_root_metadata),
                directory=_path_identity(final_directory_metadata),
                files=tuple(file_identities),
            ))
        return True
    except (OSError, RuntimeError):
        return False


def _remove_verified_huggingface_metadata(
    model_directory: Path,
    manifest: ModelManifest,
    *,
    on_verified_bytes: Callable[[int], None] | None = None,
    verified_identity_out: list[ModelTreeIdentity] | None = None,
) -> bool:
    """Adopt an exact legacy local_dir download without re-downloading weights.

    Hugging Face adds only a .cache directory to local_dir downloads. An
    explicit install/repair may remove that metadata if every signed-manifest
    file is already exact; apart from the inert OS metadata that
    ``_valid_model_directory`` also tolerates, no other extra entry or symlink
    is accepted.
    """
    try:
        directory_metadata = model_directory.lstat()
        if model_directory.is_symlink() or not stat.S_ISDIR(directory_metadata.st_mode):
            return False
        metadata_directory = model_directory / ".cache"
        if not metadata_directory.exists():
            return False
        metadata = metadata_directory.lstat()
        if metadata_directory.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
            return False
        if not _exact_model_file_set(
            model_directory,
            manifest,
            ignored_root_directories=frozenset({".cache"}),
        ):
            return False
        for filename, expected in manifest.files.items():
            candidate = _manifest_file_path(model_directory, filename)
            candidate_metadata = candidate.lstat()
            if (
                candidate.is_symlink()
                or not stat.S_ISREG(candidate_metadata.st_mode)
                or candidate_metadata.st_size != expected.bytes
                or (
                    _sha256_with_progress(candidate, on_verified_bytes)
                    if on_verified_bytes is not None
                    else _sha256(candidate)
                )
                != expected.sha256
            ):
                return False
        _safe_rmtree(metadata_directory, model_directory)
        _sync_directory(model_directory)
        return _valid_model_directory(
            model_directory,
            manifest,
            on_verified_bytes=on_verified_bytes,
            verified_identity_out=verified_identity_out,
        )
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


def _model_manifest_digest(manifest: ModelManifest) -> str:
    payload = {
        "backend": manifest.backend,
        "modelId": manifest.model_id,
        "artifactId": manifest.artifact_id,
        "storageDirectory": manifest.storage_directory,
        "revision": manifest.revision,
        "files": {
            filename: {
                "bytes": model_file.bytes,
                "sha256": model_file.sha256,
            }
            for filename, model_file in sorted(manifest.files.items())
        },
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _transaction_marker_payload(
    transaction_id: str,
    manifest: ModelManifest,
) -> dict[str, Any]:
    return {
        "schemaVersion": MODEL_TRANSACTION_SCHEMA_VERSION,
        "owner": MODEL_TRANSACTION_OWNER,
        "transactionId": transaction_id,
        "backend": manifest.backend,
        "modelId": manifest.model_id,
        "artifactId": manifest.artifact_id,
        "storageDirectory": manifest.storage_directory,
        "revision": manifest.revision,
        "manifestDigest": _model_manifest_digest(manifest),
    }


def _sync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        # Some packaged filesystems do not support directory fsync. The
        # transaction marker and model files are still individually durable.
        pass
    finally:
        os.close(descriptor)


def _create_model_transaction(
    model_root: Path,
    manifest: ModelManifest,
) -> tuple[Path, Path, Path]:
    transaction_id = uuid.uuid4().hex
    transaction = model_root / f"{MODEL_TRANSACTION_PREFIX}{transaction_id}"
    transaction.mkdir(mode=0o700)
    marker = transaction / MODEL_TRANSACTION_MARKER
    marker_payload = _transaction_marker_payload(transaction_id, manifest)
    descriptor = os.open(
        marker,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(
                marker_payload,
                handle,
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            )
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        # fdopen owns the descriptor after it succeeds.
        if marker.exists():
            marker.unlink()
        transaction.rmdir()
        raise
    staging = transaction / "staging"
    staging.mkdir(mode=0o700)
    _sync_directory(transaction)
    _sync_directory(model_root)
    return transaction, staging, transaction / "backup"


def _owned_model_transaction(
    transaction: Path,
    model_root: Path,
    manifest: ModelManifest,
) -> bool:
    match = MODEL_TRANSACTION_NAME.fullmatch(transaction.name)
    if match is None or transaction.parent != model_root:
        return False
    try:
        transaction_metadata = transaction.lstat()
        if transaction.is_symlink() or not stat.S_ISDIR(transaction_metadata.st_mode):
            return False
        entries = {entry.name: entry for entry in transaction.iterdir()}
        if not set(entries).issubset(
            {MODEL_TRANSACTION_MARKER, "staging", "backup"}
        ):
            return False
        marker = entries.get(MODEL_TRANSACTION_MARKER)
        if marker is None:
            return False
        marker_metadata = marker.lstat()
        if (
            marker.is_symlink()
            or not stat.S_ISREG(marker_metadata.st_mode)
            or marker_metadata.st_size > 4_096
        ):
            return False
        for directory_name in ("staging", "backup"):
            directory = entries.get(directory_name)
            if directory is None:
                continue
            metadata = directory.lstat()
            if directory.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
                return False
        raw = json.loads(
            marker.read_text(encoding="utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
        )
    except (OSError, UnicodeError, json.JSONDecodeError, WorkerError):
        return False
    if not isinstance(raw, dict) or frozenset(raw) != MODEL_TRANSACTION_FIELDS:
        return False
    transaction_id = match.group(1)
    return raw == _transaction_marker_payload(transaction_id, manifest)


def _remove_owned_model_transaction(
    transaction: Path,
    model_root: Path,
    manifest: ModelManifest,
) -> None:
    if not _owned_model_transaction(transaction, model_root, manifest):
        raise WorkerError(
            "unsafe_model_path",
            "refusing to remove an unowned model transaction",
        )
    _safe_rmtree(transaction, model_root)
    _sync_directory(model_root)


def _regular_directory_present(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    except OSError as error:
        raise WorkerError("unsafe_model_path", "model path is unavailable") from error
    if path.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
        raise WorkerError(
            "unsafe_model_path",
            "model path must be a regular directory",
        )
    return True


def _recover_model_transactions(
    model_root: Path,
    manifest: ModelManifest,
) -> None:
    final_directory = model_root / manifest.storage_directory
    try:
        candidates = tuple(model_root.iterdir())
    except OSError as error:
        raise WorkerError("invalid_model_root", "modelRoot is unavailable") from error
    for transaction in candidates:
        if not _owned_model_transaction(transaction, model_root, manifest):
            continue
        staging = transaction / "staging"
        backup = transaction / "backup"
        final_valid = _valid_model_directory(final_directory, manifest)
        final_present = _regular_directory_present(final_directory)
        backup_present = _regular_directory_present(backup)
        staging_present = _regular_directory_present(staging)
        backup_valid = backup_present and _valid_model_directory(backup, manifest)
        staging_valid = staging_present and _valid_model_directory(staging, manifest)

        if final_valid:
            _remove_owned_model_transaction(transaction, model_root, manifest)
            continue
        if final_present and backup_valid:
            # The replacement was promoted but did not survive verification
            # (for example, a crash or disk fault after the atomic rename).
            # This transaction is marker-owned and its backup is verified, so
            # restore the last known-good artifact instead of discarding it.
            _safe_rmtree(final_directory, model_root)
            backup.replace(final_directory)
            _sync_directory(model_root)
            if not _valid_model_directory(final_directory, manifest):
                raise WorkerError(
                    "model_recovery_failed",
                    "restored model verification failed",
                )
            _remove_owned_model_transaction(transaction, model_root, manifest)
            continue
        if not final_present and backup_valid:
            backup.replace(final_directory)
            _sync_directory(model_root)
            if not _valid_model_directory(final_directory, manifest):
                raise WorkerError(
                    "model_recovery_failed",
                    "restored model verification failed",
                )
            _remove_owned_model_transaction(transaction, model_root, manifest)
            continue
        if not final_present and staging_valid:
            staging.replace(final_directory)
            _sync_directory(model_root)
            if not _valid_model_directory(final_directory, manifest):
                raise WorkerError(
                    "model_recovery_failed",
                    "recovered model verification failed",
                )
            _remove_owned_model_transaction(transaction, model_root, manifest)
            continue
        # A marker-owned partial download, or an invalid model that had already
        # been selected for replacement, is safe to discard. Unmarked or
        # malformed lookalike directories never reach this branch.
        _remove_owned_model_transaction(transaction, model_root, manifest)


def ensure_model(
    model_root: Path,
    manifest: ModelManifest,
    allow_download: bool,
    *,
    snapshot_downloader: SnapshotDownloader | None = None,
    progress: ModelInstallProgress | None = None,
    verified_identity_out: list[ModelTreeIdentity] | None = None,
) -> Path:
    model_root = _bounded_absolute_directory(str(model_root), create=True)
    final_directory = model_root / manifest.storage_directory
    if progress is not None:
        progress.begin("verifying")
    _recover_model_transactions(model_root, manifest)
    if _valid_model_directory(
        final_directory,
        manifest,
        on_verified_bytes=progress.advance if progress is not None else None,
        verified_identity_out=verified_identity_out,
    ):
        return final_directory
    if not allow_download:
        raise WorkerError(
            "model_not_installed",
            "install the selected local speech model before dictating",
        )
    if _remove_verified_huggingface_metadata(
        final_directory,
        manifest,
        on_verified_bytes=progress.advance if progress is not None else None,
        verified_identity_out=verified_identity_out,
    ):
        return final_directory

    transaction, staging, backup = _create_model_transaction(model_root, manifest)
    try:
        if progress is not None:
            progress.begin("downloading")
        if snapshot_downloader is None:
            with contextlib.redirect_stdout(sys.stderr):
                from huggingface_hub import snapshot_download

            snapshot_downloader = snapshot_download
        try:
            with contextlib.redirect_stdout(sys.stderr):
                download_options: dict[str, Any] = {
                    "repo_id": manifest.model_id,
                    "revision": manifest.revision,
                    "local_dir": staging,
                    "allow_patterns": sorted(manifest.files),
                    "max_workers": 4,
                    "token": False,
                    # The curated catalog is hosted on the canonical Hub, never
                    # an ambient HF_ENDPOINT mirror (including direct CLI use).
                    "endpoint": "https://huggingface.co",
                }
                if progress is not None:
                    download_options["tqdm_class"] = _snapshot_download_progress_class(progress)
                snapshot_downloader(
                    **download_options,
                )
        except WorkerError:
            raise
        except Exception as error:
            raise WorkerError("model_download_failed", "model download failed") from error

        hub_metadata = staging / ".cache"
        if hub_metadata.exists():
            _safe_rmtree(hub_metadata, staging)
        if progress is not None:
            progress.begin("verifying")
        if not _valid_model_directory(
            staging,
            manifest,
            on_verified_bytes=progress.advance if progress is not None else None,
        ):
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
            final_directory.replace(backup)
            _sync_directory(transaction)
            _sync_directory(model_root)
        try:
            staging.replace(final_directory)
            _sync_directory(transaction)
            _sync_directory(model_root)
        except Exception:
            if _valid_model_directory(backup, manifest) and not final_directory.exists():
                backup.replace(final_directory)
                _sync_directory(model_root)
            raise
        if not _valid_model_directory(
            final_directory,
            manifest,
            verified_identity_out=verified_identity_out,
        ):
            raise WorkerError(
                "model_activation_failed",
                "activated model verification failed",
            )
        _remove_owned_model_transaction(transaction, model_root, manifest)
        return final_directory
    finally:
        if transaction.exists():
            _recover_model_transactions(model_root, manifest)


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
    def load(cls, model_directory: Path, _spec: TierSpec) -> MLXWhisperRuntime:
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
                "The selected Whisper model could not be loaded with MLX",
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

    def release_transient_memory(self) -> None:
        """Frees MLX's scratch buffers while keeping the model weights resident.

        MLX's buffer cache defaults to the device's recommended working set —
        48.96 GB was reported on the machine this was measured on — and nothing
        trimmed it between dictations. A 600 s dictation on whisper-large-v3
        fp16 left 8,976 MB cached, and a 60 s dictation left 5,884 MB, held for
        the whole life of the resident worker. LocalScribe deliberately keeps
        that worker warm, so the user's "idle" dictation service sat on several
        gigabytes of dead Metal buffers.

        Measured cost: none. Alternating clear/keep across nine 60 s runs in one
        process gave 9.73-10.10 s regardless of policy — the cache refills
        during the next dictation, so only the idle footprint changes. Weights
        stay put: active memory held at 2,945 MB across every run.
        """
        try:
            self._mlx.synchronize()
            self._mlx.clear_cache()
        except Exception:
            pass

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
            self._mlx.clear_cache()
        except Exception:
            pass


class MLXAudioRuntime:
    def __init__(
        self,
        *,
        mlx_module: Any,
        numpy_module: Any,
        model: Any,
    ) -> None:
        self._mlx = mlx_module
        self._numpy = numpy_module
        self._model = model

    @classmethod
    def load(cls, model_directory: Path, spec: TierSpec) -> MLXAudioRuntime:
        if (
            not model_directory.is_absolute()
            or spec.family_id not in {"qwen3-asr-1-7b", "qwen3-asr-0-6b"}
        ):
            raise WorkerError("model_load_failed", "local Qwen model path is invalid")
        try:
            with contextlib.redirect_stdout(sys.stderr):
                import mlx.core as mx
                import numpy as np
                from mlx_audio.stt import load
        except Exception as error:
            raise WorkerError(
                "runtime_import_failed",
                "MLX Audio runtime dependencies are unavailable",
            ) from error
        try:
            with contextlib.redirect_stdout(sys.stderr):
                model = load(str(model_directory))
        except Exception as error:
            raise WorkerError(
                "model_load_failed",
                "The selected Qwen3-ASR model could not be loaded with MLX Audio",
            ) from error
        return cls(mlx_module=mx, numpy_module=np, model=model)

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
        language_name = None
        if language is not None:
            language_name = next(
                (
                    name.title()
                    for name, code in LANGUAGE_NAME_TO_CODE.items()
                    if code == language
                ),
                language,
            )
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = self._model.generate(
                    waveform,
                    language=language_name,
                    system_prompt=context or None,
                    temperature=0.0,
                    verbose=False,
                )
        except WorkerError:
            raise
        except Exception as error:
            raise WorkerError("transcription_failed", "local transcription failed") from error
        text = getattr(result, "text", None)
        detected_language = getattr(result, "language", None)
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

    def release_transient_memory(self) -> None:
        """Frees MLX scratch buffers between dictations; see MLXWhisperRuntime."""
        try:
            self._mlx.synchronize()
            self._mlx.clear_cache()
        except Exception:
            pass

    def close(self) -> None:
        self._model = None
        gc.collect()
        try:
            self._mlx.synchronize()
            self._mlx.clear_cache()
        except Exception:
            pass


def _fluid_audio_helper_path() -> Path:
    """Resolve only the signed helper bundled with this app/source tree.

    The renderer never supplies this path. In a packaged app the worker lives
    under ``Contents/Resources/worker``; in development, it lives below the
    checkout root. Both candidates are fixed relative to this module and must
    be regular executable files, never symlinks.
    """
    for parent in Path(__file__).resolve().parents:
        for relative in (
            Path("native") / "macos" / FLUID_AUDIO_HELPER_FILENAME,
            Path("resources") / "native" / "macos" / FLUID_AUDIO_HELPER_FILENAME,
        ):
            candidate = parent / relative
            try:
                metadata = candidate.lstat()
            except OSError:
                continue
            if (
                not candidate.is_symlink()
                and stat.S_ISREG(metadata.st_mode)
                and bool(metadata.st_mode & stat.S_IXUSR)
            ):
                return candidate
    raise WorkerError(
        "runtime_unavailable",
        "The bundled Parakeet CoreML runtime is unavailable",
    )


class FluidAudioParakeetRuntime:
    """A strict local adapter around the signed FluidAudio Swift helper.

    FluidAudio itself is intentionally never allowed to download: Python owns
    the revision-pinned, digest-verified atomic install. This class sends only
    a verified local directory to the helper and keeps exactly one helper/model
    pair warm until a model switch or worker shutdown.
    """

    def __init__(
        self,
        *,
        process: subprocess.Popen[bytes],
        mode: str,
    ) -> None:
        self._process: subprocess.Popen[bytes] | None = process
        self._mode = mode
        self._live_active = False

    @staticmethod
    def _frame_payload(payload: dict[str, Any]) -> bytes:
        try:
            encoded = json.dumps(
                payload,
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        except (TypeError, ValueError) as error:
            raise WorkerError("runtime_protocol_error", "Parakeet request is invalid") from error
        if not encoded or len(encoded) > MAX_HELPER_FRAME_BYTES:
            raise WorkerError("runtime_protocol_error", "Parakeet request is too large")
        return struct.pack(">I", len(encoded)) + encoded

    @staticmethod
    def _read_exact(stream: BinaryIO, count: int) -> bytes:
        result = bytearray()
        while len(result) < count:
            chunk = stream.read(count - len(result))
            if not chunk:
                raise WorkerError("runtime_protocol_error", "Parakeet runtime closed unexpectedly")
            result.extend(chunk)
        return bytes(result)

    @classmethod
    def _read_frame(cls, stream: BinaryIO) -> dict[str, Any]:
        header = cls._read_exact(stream, 4)
        (size,) = struct.unpack(">I", header)
        if size == 0 or size > MAX_HELPER_FRAME_BYTES:
            raise WorkerError("runtime_protocol_error", "Parakeet runtime sent an invalid frame")
        try:
            decoded = json.loads(
                cls._read_exact(stream, size).decode("utf-8"),
                object_pairs_hook=_reject_duplicate_keys,
            )
        except (UnicodeDecodeError, json.JSONDecodeError, WorkerError) as error:
            raise WorkerError("runtime_protocol_error", "Parakeet runtime sent invalid JSON") from error
        if not isinstance(decoded, dict):
            raise WorkerError("runtime_protocol_error", "Parakeet runtime sent an invalid response")
        return decoded

    def _send(self, request: dict[str, Any], pcm16: bytes | None = None) -> dict[str, Any]:
        process = self._process
        if process is None or process.poll() is not None or process.stdin is None or process.stdout is None:
            raise WorkerError("runtime_protocol_error", "Parakeet runtime is not running")
        if pcm16 is not None and (
            not pcm16 or len(pcm16) > MAX_AUDIO_BYTES or len(pcm16) % 2 != 0
        ):
            raise WorkerError("invalid_audio_file", "audio payload is invalid")
        try:
            process.stdin.write(self._frame_payload(request))
            if pcm16 is not None:
                process.stdin.write(pcm16)
            process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise WorkerError("runtime_protocol_error", "Parakeet runtime stopped") from error
        response = self._read_frame(process.stdout)
        if response.get("type") == "error":
            # Helper errors are deliberately code-only. Do not reflect native
            # paths or dependency messages through Electron's IPC boundary.
            code = response.get("code")
            if not isinstance(code, str) or code not in {
                "invalid_request",
                "request_too_large",
                "invalid_model_path",
                "model_not_loaded",
                "runtime_failure",
            }:
                raise WorkerError("runtime_protocol_error", "Parakeet runtime rejected a request")
            raise WorkerError("parakeet_runtime_failed", "Parakeet CoreML inference failed")
        return response

    @staticmethod
    def _require_exact_response(response: dict[str, Any], expected: str) -> None:
        if frozenset(response) != frozenset({"type"}) or response.get("type") != expected:
            raise WorkerError("runtime_protocol_error", "Parakeet runtime sent an invalid response")

    @classmethod
    def load(cls, model_directory: Path, spec: TierSpec) -> FluidAudioParakeetRuntime:
        if (
            not model_directory.is_absolute()
            or spec.family_id != "parakeet-unified-en-0-6b"
            or spec.compute_type not in {"coreml-fp16", "coreml-int8"}
            or spec.asr_mode not in {"after-stop", "live"}
        ):
            raise WorkerError("model_load_failed", "local Parakeet model selection is invalid")
        expected_directory = {
            "coreml-fp16": "parakeet-unified-en-0-6b-coreml-fp16",
            "coreml-int8": "parakeet-unified-en-0-6b-coreml-int8",
        }[spec.compute_type]
        if model_directory.name != expected_directory:
            raise WorkerError("model_load_failed", "local Parakeet model path is invalid")

        helper = _fluid_audio_helper_path()
        try:
            process = subprocess.Popen(
                [str(helper)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
        except OSError as error:
            raise WorkerError("runtime_unavailable", "Parakeet CoreML runtime could not start") from error
        runtime = cls(process=process, mode=spec.asr_mode)
        try:
            hello = runtime._read_frame(process.stdout) if process.stdout is not None else {}
            if hello != {
                "type": "hello",
                "protocol": FLUID_AUDIO_HELPER_PROTOCOL_VERSION,
                "runtime": FLUID_AUDIO_HELPER_RUNTIME,
                "runtimeVersion": FLUID_AUDIO_HELPER_VERSION,
                "modes": ["after-stop", "live"],
                "precisions": ["coreml-fp16", "coreml-int8"],
            }:
                raise WorkerError("runtime_protocol_error", "Parakeet runtime handshake is invalid")
            runtime._require_exact_response(
                runtime._send(
                    {
                        "type": "load",
                        "modelPath": str(model_directory),
                        "precision": spec.compute_type,
                        "mode": spec.asr_mode,
                    }
                ),
                "loaded",
            )
            return runtime
        except Exception:
            runtime.close()
            raise

    @staticmethod
    def _text_response(response: dict[str, Any], expected: str) -> str:
        if frozenset(response) != frozenset({"type", "text"}) or response.get("type") != expected:
            raise WorkerError("runtime_protocol_error", "Parakeet runtime sent an invalid transcription")
        text = response.get("text")
        if not isinstance(text, str) or len(text) > MAX_RESULT_CHARS:
            raise WorkerError("invalid_model_output", "model returned an invalid transcription")
        return text

    def transcribe(
        self,
        pcm16: bytes,
        *,
        language: str | None,
        context: str,
    ) -> TranscriptionResult:
        if self._mode != "after-stop":
            raise WorkerError("invalid_mode", "Parakeet is loaded for live dictation")
        if language not in {None, "en"}:
            raise WorkerError("invalid_language", "Parakeet Unified currently supports English only")
        # The shared worker protocol includes context for prompt-capable MLX
        # engines. Parakeet has no recognizer-prompt API: do not turn a stale
        # client or a pre-capability-gate request into a failed dictation. The
        # context is intentionally not serialized to the helper, and main
        # still applies Dictionary's deterministic replacements to the final
        # transcription for every model family.
        del context
        return TranscriptionResult(
            text=self._text_response(
                self._send({"type": "transcribe", "pcmBytes": len(pcm16)}, pcm16),
                "transcription",
            ),
            language="en",
        )

    def begin_live(self, *, language: str | None, context: str) -> None:
        if self._mode != "live":
            raise WorkerError("invalid_mode", "The selected model does not support live dictation")
        if language not in {None, "en"}:
            raise WorkerError("invalid_language", "Parakeet Unified currently supports English only")
        # See `transcribe`: mode selection now suppresses unsupported prompts,
        # but the adapter remains safe for stale clients without forwarding it.
        del context
        self._require_exact_response(self._send({"type": "reset"}), "reset")
        self._live_active = True

    def append_live(self, pcm16: bytes) -> str:
        if not self._live_active:
            raise WorkerError("live_session_not_started", "start live dictation first")
        return self._text_response(
            self._send({"type": "append", "pcmBytes": len(pcm16)}, pcm16),
            "partial",
        )

    def finish_live(self) -> TranscriptionResult:
        if not self._live_active:
            raise WorkerError("live_session_not_started", "start live dictation first")
        try:
            text = self._text_response(self._send({"type": "finish"}), "transcription")
            return TranscriptionResult(text=text, language="en")
        finally:
            self._live_active = False
            self._require_exact_response(self._send({"type": "reset"}), "reset")

    def cancel_live(self) -> None:
        if not self._live_active:
            return
        try:
            self._require_exact_response(self._send({"type": "reset"}), "reset")
        finally:
            self._live_active = False

    def release_transient_memory(self) -> None:
        # FluidAudio keeps only its model graphs warm. Its streaming reset clears
        # rolling audio and RNNT state, and offline calls allocate no Python MLX
        # cache in this process.
        return

    def close(self) -> None:
        process, self._process = self._process, None
        self._live_active = False
        if process is None:
            return
        try:
            if process.poll() is None and process.stdin is not None:
                process.stdin.write(self._frame_payload({"type": "close"}))
                process.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            if process.stdin is not None:
                try:
                    process.stdin.close()
                except OSError:
                    pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        finally:
            if process.stdout is not None:
                try:
                    process.stdout.close()
                except OSError:
                    pass


def _load_runtime(model_directory: Path, spec: TierSpec) -> InferenceRuntime:
    if spec.family_id == "canary-qwen-2-5b":
        from .canary_runtime import CanaryRuntime

        return CanaryRuntime.load(model_directory, spec)
    if spec.family_id == "parakeet-unified-en-0-6b":
        return FluidAudioParakeetRuntime.load(model_directory, spec)
    if spec.family_id in {"qwen3-asr-1-7b", "qwen3-asr-0-6b"}:
        return MLXAudioRuntime.load(model_directory, spec)
    if spec.family_id in {"whisper-large-v3", "whisper-large-v2"}:
        return MLXWhisperRuntime.load(model_directory, spec)
    raise WorkerError("model_not_allowed", "model family is not supported by this worker")


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
    *,
    progress: ModelInstallProgress | None = None,
) -> Path:
    if progress is None:
        return ensure_model(model_root, manifest, allow_download)
    return ensure_model(model_root, manifest, allow_download, progress=progress)


def _verified_model_for_load(
    model_root: Path,
    manifest: ModelManifest,
    allow_download: bool,
) -> VerifiedModelArtifact:
    identities: list[ModelTreeIdentity] = []
    path = ensure_model(
        model_root,
        manifest,
        allow_download,
        verified_identity_out=identities,
    )
    if len(identities) != 1:
        raise WorkerError(
            "model_verification_failed",
            "verified model identity was unavailable",
        )
    return VerifiedModelArtifact(path=path, identity=identities[0])


def _install_model(
    installer: ModelInstaller,
    model_root: Path,
    manifest: ModelManifest,
    allow_download: bool,
    progress: ModelInstallProgress | None = None,
) -> Path:
    """Call injected test installers unchanged while production gets progress."""
    if progress is not None and installer is _default_model_installer:
        return _default_model_installer(
            model_root,
            manifest,
            allow_download,
            progress=progress,
        )
    return installer(model_root, manifest, allow_download)


def _close_runtime(runtime: InferenceRuntime | None) -> None:
    if runtime is None:
        return
    try:
        runtime.close()
    except Exception:
        pass


def _parse_model_request(
    message: dict[str, Any],
    *,
    operation: str,
    platform_name: str,
    machine_name: str,
) -> tuple[TierSpec, ModelManifest, bool, Path]:
    """Validate the fixed catalog selection shared by model operations."""
    _strict_fields(
        message,
        LOAD_MODEL_REQUEST_FIELDS if operation == "load_model" else MODEL_REQUEST_FIELDS,
    )
    if platform_name != "darwin" or machine_name != "arm64":
        raise WorkerError(
            "apple_silicon_only",
            "LocalScribe speech worker requires Apple silicon",
        )
    tier = _string_field(message, "tier", max_chars=16)
    model_id = _string_field(message, "modelId", max_chars=200)
    compute_type = _string_field(message, "computeType", max_chars=16)
    selection = (model_id, tier, compute_type)
    spec = TIER_SPECS.get(selection)
    if spec is None:
        raise WorkerError(
            "model_not_allowed",
            "modelId, tier, and computeType must match the model catalog",
        )
    if operation == "load_model":
        asr_mode = _string_field(message, "asrMode", max_chars=16)
        allowed_modes = {"after-stop", "live"} if spec.family_id == "parakeet-unified-en-0-6b" else {"after-stop"}
        if asr_mode not in allowed_modes:
            raise WorkerError(
                "invalid_asr_mode",
                "the selected model does not support that dictation mode",
            )
        spec = replace(spec, asr_mode=asr_mode)
    allow_download = message.get("allowDownload")
    if not isinstance(allow_download, bool):
        raise WorkerError(
            "allow_download_required",
            f"{operation} must explicitly allow or forbid model download",
        )
    model_root_raw = _string_field(message, "modelRoot", max_chars=MAX_PATH_CHARS)
    model_root = _bounded_absolute_directory(model_root_raw, create=True)
    return spec, MODEL_MANIFESTS[selection], allow_download, model_root


def _approved_installed_model_path(
    local_model: Path,
    model_root: Path,
    manifest: ModelManifest,
) -> Path:
    expected_local_model = (model_root / manifest.storage_directory).resolve(
        strict=False
    )
    if (
        not isinstance(local_model, Path)
        or not local_model.is_absolute()
        or local_model.resolve(strict=False) != expected_local_model
    ):
        raise WorkerError(
            "unsafe_model_path",
            "model installer returned an unapproved path",
        )
    return local_model


def _path_identity(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _capture_model_tree_identity(
    local_model: Path,
    model_root: Path,
    manifest: ModelManifest,
) -> ModelTreeIdentity:
    """Capture the bounded tree without following links or reading model data.

    The digest-verifying installer remains the content authority. This second,
    immediate boundary binds native runtime construction to the same root,
    directory, and regular-file identities that were present just before the
    loader call. A same-UID process can still race after this final check because
    third-party native loaders accept paths rather than already-open file
    descriptors; eliminating that residual requires loader APIs with fd/handle
    ownership. The narrow recheck closes deterministic swaps before load without
    adding a second multi-gigabyte digest pass to every cold start.
    """
    try:
        root_metadata = model_root.lstat()
        model_metadata = local_model.lstat()
        if (
            model_root.is_symlink()
            or not stat.S_ISDIR(root_metadata.st_mode)
            or local_model.is_symlink()
            or not stat.S_ISDIR(model_metadata.st_mode)
            or model_root.resolve(strict=True) != model_root
            or local_model.resolve(strict=True)
            != model_root / manifest.storage_directory
            or not _exact_model_file_set(local_model, manifest)
        ):
            raise WorkerError("unsafe_model_path", "model path changed before loading")
        file_identities: list[tuple[str, int, int, int, int, int]] = []
        for filename, expected in sorted(manifest.files.items()):
            candidate = _manifest_file_path(local_model, filename)
            metadata = candidate.lstat()
            if (
                candidate.is_symlink()
                or not stat.S_ISREG(metadata.st_mode)
                or metadata.st_size != expected.bytes
            ):
                raise WorkerError("unsafe_model_path", "model path changed before loading")
            file_identities.append(
                (
                    filename,
                    metadata.st_dev,
                    metadata.st_ino,
                    metadata.st_size,
                    metadata.st_mtime_ns,
                    metadata.st_ctime_ns,
                )
            )
        return ModelTreeIdentity(
            root=_path_identity(root_metadata),
            directory=_path_identity(model_metadata),
            files=tuple(file_identities),
        )
    except WorkerError:
        raise
    except (OSError, RuntimeError, ValueError) as error:
        raise WorkerError(
            "unsafe_model_path",
            "model path changed before loading",
        ) from error


def _assert_model_tree_identity(
    expected: ModelTreeIdentity,
    local_model: Path,
    model_root: Path,
    manifest: ModelManifest,
) -> None:
    if _capture_model_tree_identity(local_model, model_root, manifest) != expected:
        raise WorkerError("model_path_changed", "model path changed before loading")


def _live_runtime(runtime: InferenceRuntime | None) -> FluidAudioParakeetRuntime:
    if not isinstance(runtime, FluidAudioParakeetRuntime) or runtime._mode != "live":
        raise WorkerError("invalid_mode", "The selected model does not support live dictation")
    return runtime


def _live_pcm16(message: dict[str, Any]) -> bytes:
    encoded = _string_field(message, "audioBase64", max_chars=16_000)
    try:
        pcm16 = base64.b64decode(encoded, validate=True)
    except (ValueError, UnicodeEncodeError) as error:
        raise WorkerError("invalid_audio_file", "live audio payload is invalid") from error
    if not pcm16 or len(pcm16) > MAX_LIVE_AUDIO_BYTES or len(pcm16) % 2 != 0:
        raise WorkerError("invalid_audio_file", "live audio payload is invalid")
    return pcm16


def run_worker(
    *,
    input_stream: BinaryIO,
    output_stream: TextIO,
    error_stream: TextIO,
    model_installer: ModelInstaller = _default_model_installer,
    runtime_factory: RuntimeFactory = _load_runtime,
    hardware_probe: HardwareProbe = read_apple_hardware_info,
    platform_name: str | None = None,
    machine_name: str | None = None,
    worker_role: str = "inference",
) -> int:
    if worker_role not in {"inference", "installer"}:
        raise ValueError("worker_role must be inference or installer")
    runtime: InferenceRuntime | None = None
    active_spec: TierSpec | None = None
    active_model_root: Path | None = None
    live_started_at: float | None = None
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
                        object_pairs_hook=_reject_request_duplicate_keys,
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

                # Process roles are capabilities, not advisory request fields.
                # The long-lived inference child is born dependency-level
                # offline and cannot turn itself into an installer. Conversely,
                # the narrowly online child accepts only the one storage-only
                # operation it was created to perform (plus orderly shutdown).
                if worker_role == "inference" and message_type == "install_model":
                    raise WorkerError(
                        "operation_not_allowed",
                        "model installation requires the dedicated installer worker",
                    )
                if worker_role == "installer" and message_type not in {
                    "install_model",
                    "shutdown",
                }:
                    raise WorkerError(
                        "operation_not_allowed",
                        "installer worker accepts only model installation",
                    )

                if message_type == "load_model":
                    spec, manifest, allow_download, model_root = _parse_model_request(
                        message,
                        operation="load_model",
                        platform_name=platform_name,
                        machine_name=machine_name,
                    )
                    if allow_download:
                        raise WorkerError(
                            "allow_download_not_allowed",
                            "load_model must set allowDownload to false",
                        )
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
                                "asrMode": spec.asr_mode,
                                "loadMs": 0,
                            },
                        )
                        continue
                    # Refuse a load that cannot succeed *before* unloading the
                    # warm model, so a mistaken request costs nothing. This is
                    # only an is-it-installed question: model_installer below
                    # runs the authoritative digest verification, and no runtime
                    # is constructed until it passes. Hashing here as well meant
                    # every cold load read the whole multi-gigabyte artifact
                    # twice.
                    if not allow_download and not _valid_model_directory(
                        model_root / manifest.storage_directory,
                        manifest,
                        verify_digests=False,
                    ):
                        raise WorkerError(
                            "model_not_installed",
                            "install the selected local speech model before dictating",
                        )

                    _close_runtime(runtime)
                    runtime = None
                    active_spec = None
                    active_model_root = None
                    live_started_at = None
                    started = time.perf_counter()
                    if model_installer is _default_model_installer:
                        verified_model = _verified_model_for_load(
                            model_root,
                            manifest,
                            allow_download,
                        )
                        local_model = verified_model.path
                        verified_identity = verified_model.identity
                    else:
                        local_model = model_installer(
                            model_root,
                            manifest,
                            allow_download,
                        )
                        verified_identity = None
                    local_model = _approved_installed_model_path(
                        local_model,
                        model_root,
                        manifest,
                    )
                    if verified_identity is None:
                        # Test/runtime injection remains supported. Production
                        # always receives identity from the exact fds whose
                        # bytes matched the manifest in the branch above.
                        verified_identity = _capture_model_tree_identity(
                            local_model,
                            model_root,
                            manifest,
                        )
                    _assert_model_tree_identity(
                        verified_identity,
                        local_model,
                        model_root,
                        manifest,
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
                            "asrMode": spec.asr_mode,
                            "loadMs": round((time.perf_counter() - started) * 1000),
                        },
                    )
                elif message_type == "install_model":
                    spec, manifest, allow_download, model_root = _parse_model_request(
                        message,
                        operation="install_model",
                        platform_name=platform_name,
                        machine_name=machine_name,
                    )
                    if not allow_download:
                        raise WorkerError(
                            "allow_download_required",
                            "install_model must set allowDownload to true",
                        )
                    started = time.perf_counter()

                    def emit_install_progress(
                        phase: str,
                        completed_bytes: int,
                        total_bytes: int,
                        *,
                        progress_request_id: str | None = request_id,
                    ) -> None:
                        _send(
                            output_stream,
                            {
                                "type": "model_install_progress",
                                "id": progress_request_id,
                                "phase": phase,
                                "completedBytes": completed_bytes,
                                "totalBytes": total_bytes,
                            },
                        )

                    progress = ModelInstallProgress(
                        manifest,
                        emit_install_progress,
                    )
                    local_model = _install_model(
                        model_installer,
                        model_root,
                        manifest,
                        True,
                        progress,
                    )
                    local_model = _approved_installed_model_path(
                        local_model,
                        model_root,
                        manifest,
                    )
                    if not _valid_model_directory(local_model, manifest):
                        raise WorkerError(
                            "model_checksum_failed",
                            "installed model verification failed",
                        )
                    # Installation is storage-only.  In particular, it must not
                    # construct a runtime or replace a currently dictating model;
                    # only load_model changes the active runtime.
                    _send(
                        output_stream,
                        {
                            "type": "model_installed",
                            "id": request_id,
                            "tier": spec.tier,
                            "modelId": spec.model_id,
                            "computeType": spec.compute_type,
                            "installMs": round(
                                (time.perf_counter() - started) * 1000
                            ),
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
                            "LocalScribe speech worker requires Apple silicon",
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
                elif message_type == "begin_live":
                    _strict_fields(
                        message,
                        frozenset({"type", "id", "language", "context"}),
                    )
                    live_runtime = _live_runtime(runtime)
                    if live_started_at is not None:
                        raise WorkerError("live_session_active", "live dictation is already active")
                    context = message.get("context")
                    if not isinstance(context, str) or len(context) > MAX_CONTEXT_CHARS:
                        raise WorkerError("invalid_context", "context must be at most 4000 characters")
                    language = _normalize_language(message.get("language"))
                    live_runtime.begin_live(language=language, context=context)
                    live_started_at = time.perf_counter()
                    _send(output_stream, {"type": "live_started", "id": request_id})
                elif message_type == "append_live":
                    _strict_fields(message, frozenset({"type", "id", "audioBase64"}))
                    live_runtime = _live_runtime(runtime)
                    if live_started_at is None:
                        raise WorkerError("live_session_not_started", "start live dictation first")
                    try:
                        text = live_runtime.append_live(_live_pcm16(message))
                    except Exception:
                        # A native processing failure may leave the decoder
                        # state ambiguous. Reset it before reporting failure so
                        # the next session never inherits prior audio.
                        live_runtime.cancel_live()
                        live_started_at = None
                        raise
                    _send(output_stream, {"type": "partial", "id": request_id, "text": text})
                elif message_type == "finish_live":
                    _strict_fields(message, frozenset({"type", "id"}))
                    live_runtime = _live_runtime(runtime)
                    if live_started_at is None:
                        raise WorkerError("live_session_not_started", "start live dictation first")
                    started = live_started_at
                    live_started_at = None
                    result = live_runtime.finish_live()
                    _send(
                        output_stream,
                        {
                            "type": "final",
                            "id": request_id,
                            "text": result.text,
                            "language": result.language,
                            "inferenceMs": round((time.perf_counter() - started) * 1000),
                        },
                    )
                elif message_type == "cancel_live":
                    _strict_fields(message, frozenset({"type", "id"}))
                    live_runtime = _live_runtime(runtime)
                    live_runtime.cancel_live()
                    live_started_at = None
                    _send(output_stream, {"type": "live_cancelled", "id": request_id})
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
                    if isinstance(runtime, FluidAudioParakeetRuntime) and runtime._mode == "live":
                        raise WorkerError("invalid_mode", "Parakeet is loaded for live dictation")
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
                    try:
                        result = runtime.transcribe(
                            pcm16,
                            language=language,
                            context=context,
                        )
                    finally:
                        # The worker stays resident with the model warm. Return
                        # the dictation's scratch buffers now rather than let
                        # them accumulate for the life of the process, and do it
                        # on the failure path too so a rejected dictation cannot
                        # strand gigabytes.
                        runtime.release_transient_memory()
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
