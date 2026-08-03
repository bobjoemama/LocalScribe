from __future__ import annotations

import ctypes
import gc
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import stat
import sys
import time
import uuid
import wave
from collections.abc import Callable
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as package_version
from pathlib import Path
from typing import Any, BinaryIO, Protocol, TextIO

PROTOCOL_VERSION = 1
BACKEND_NAME = "localscribe-windows-asr"
# Handshake the installed runtime version, not a second handwritten literal.
# Supervisor retains the release allowlist, so dependency drift fails closed.
try:
    BACKEND_VERSION = package_version("faster-whisper")
except PackageNotFoundError:
    # Source tests run on macOS where the Windows-only dependency marker keeps
    # faster-whisper out of the venv. Derive the same exact pin from this
    # worker project's pyproject instead of introducing another version literal.
    import tomllib

    _pyproject = tomllib.loads(
        (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(
            encoding="utf-8"
        )
    )
    _dependency = next(
        dependency
        for dependency in _pyproject["project"]["dependencies"]
        if dependency.startswith("faster-whisper==")
    )
    BACKEND_VERSION = _dependency.removeprefix("faster-whisper==").split(";", 1)[0]
BACKEND_VERSION = f"faster-whisper/{BACKEND_VERSION};crispasr/0.8.24"

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
MIN_FREE_DISK_BYTES = 6 * 1024 * 1024 * 1024
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

WHISPER_TIER_COMPUTE_TYPES = {
    "high": "float16",
    "medium": "int8_float16",
    "low": "int8",
}
QWEN_TIER_COMPUTE_TYPES = {
    "high": "float16",
    "medium": "q8_0",
    "low": "q4_k",
}
QWEN_MODEL_IDS = frozenset(
    {
        "cstr/qwen3-asr-1.7b-GGUF",
        "cstr/qwen3-asr-0.6b-GGUF",
    }
)

EXPECTED_MANIFEST_FIELDS = frozenset(
    {
        "schemaVersion",
        "platform",
        "backend",
        "displayName",
        "familyId",
        "artifactId",
        "modelId",
        "storageDirectory",
        "revision",
        "license",
        "files",
    }
)
MODEL_OPERATION_FIELDS = frozenset(
    {
        "type",
        "id",
        "modelId",
        "tier",
        "computeType",
        "modelRoot",
        "allowDownload",
    }
)

# faster-whisper accepts Whisper ISO 639-1 language codes. The name aliases
# preserve LocalScribe's existing human-readable settings while keeping the
# inference boundary explicit.
LANGUAGE_CODE_TO_NAME = {
    "af": "Afrikaans",
    "am": "Amharic",
    "ar": "Arabic",
    "as": "Assamese",
    "az": "Azerbaijani",
    "ba": "Bashkir",
    "be": "Belarusian",
    "bg": "Bulgarian",
    "bn": "Bengali",
    "bo": "Tibetan",
    "br": "Breton",
    "bs": "Bosnian",
    "ca": "Catalan",
    "cs": "Czech",
    "cy": "Welsh",
    "da": "Danish",
    "de": "German",
    "el": "Greek",
    "en": "English",
    "es": "Spanish",
    "et": "Estonian",
    "eu": "Basque",
    "fa": "Persian",
    "fi": "Finnish",
    "fo": "Faroese",
    "fr": "French",
    "gl": "Galician",
    "gu": "Gujarati",
    "ha": "Hausa",
    "haw": "Hawaiian",
    "he": "Hebrew",
    "hi": "Hindi",
    "hr": "Croatian",
    "ht": "Haitian Creole",
    "hu": "Hungarian",
    "hy": "Armenian",
    "id": "Indonesian",
    "is": "Icelandic",
    "it": "Italian",
    "ja": "Japanese",
    "jw": "Javanese",
    "ka": "Georgian",
    "kk": "Kazakh",
    "km": "Khmer",
    "kn": "Kannada",
    "ko": "Korean",
    "la": "Latin",
    "lb": "Luxembourgish",
    "ln": "Lingala",
    "lo": "Lao",
    "lt": "Lithuanian",
    "lv": "Latvian",
    "mg": "Malagasy",
    "mi": "Maori",
    "mk": "Macedonian",
    "ml": "Malayalam",
    "mn": "Mongolian",
    "mr": "Marathi",
    "ms": "Malay",
    "mt": "Maltese",
    "my": "Myanmar",
    "ne": "Nepali",
    "nl": "Dutch",
    "nn": "Nynorsk",
    "no": "Norwegian",
    "oc": "Occitan",
    "pa": "Punjabi",
    "pl": "Polish",
    "ps": "Pashto",
    "pt": "Portuguese",
    "ro": "Romanian",
    "ru": "Russian",
    "sa": "Sanskrit",
    "sd": "Sindhi",
    "si": "Sinhala",
    "sk": "Slovak",
    "sl": "Slovenian",
    "sn": "Shona",
    "so": "Somali",
    "sq": "Albanian",
    "sr": "Serbian",
    "su": "Sundanese",
    "sv": "Swedish",
    "sw": "Swahili",
    "ta": "Tamil",
    "te": "Telugu",
    "tg": "Tajik",
    "th": "Thai",
    "tk": "Turkmen",
    "tl": "Tagalog",
    "tr": "Turkish",
    "tt": "Tatar",
    "uk": "Ukrainian",
    "ur": "Urdu",
    "uz": "Uzbek",
    "vi": "Vietnamese",
    "yi": "Yiddish",
    "yo": "Yoruba",
    "yue": "Cantonese",
    "zh": "Chinese",
}
LANGUAGE_NAME_TO_CODE = {
    name.casefold(): code for code, name in LANGUAGE_CODE_TO_NAME.items()
}
LANGUAGE_NAME_TO_CODE.update(
    {
        "burmese": "my",
        "castilian": "es",
        "filipino": "tl",
        "flemish": "nl",
        "haitian": "ht",
        "mandarin": "zh",
        "moldavian": "ro",
        "moldovan": "ro",
        "valencian": "ca",
    }
)

# large-v2's tokenizer has 99 language tokens. large-v3 adds Cantonese
# (``yue``), so language selection must remain bound to the fixed model family
# that is actually loaded rather than only to the shared worker vocabulary.
UNSUPPORTED_LANGUAGE_CODES_BY_FAMILY = {
    "whisper-large-v2": frozenset({"yue"}),
}

_DLL_DIRECTORY_HANDLES: list[Any] = []
_CUDA_DLLS_CONFIGURED = False
_SELECTED_CUDA_DEVICE_INDEX: int | None = None
_BOUND_CUDA_PHYSICAL_INDEX: int | None = None


class WorkerError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.public_message = message


@dataclass(frozen=True)
class ModelFile:
    bytes: int
    sha256: str


@dataclass(frozen=True)
class ModelManifest:
    backend: str
    display_name: str
    family_id: str
    artifact_id: str
    model_id: str
    storage_directory: str
    revision: str
    license: str
    files: dict[str, ModelFile]


# Model repository/revision/artifact identities live only in these packaged,
# resource-integrity-covered manifests. The exact filenames remain the
# deliberate executable allowlist, so renderers cannot introduce repositories
# or URLs and a curated addition still requires a signed LocalScribe release.
CURATED_PROFILE_POLICIES = (
    ("faster-whisper-large-v3.json", "high", "float16", "faster-whisper/CTranslate2"),
    ("faster-whisper-large-v3.json", "medium", "int8_float16", "faster-whisper/CTranslate2"),
    ("faster-whisper-large-v3.json", "low", "int8", "faster-whisper/CTranslate2"),
    ("faster-whisper-large-v2.json", "high", "float16", "faster-whisper/CTranslate2"),
    ("faster-whisper-large-v2.json", "medium", "int8_float16", "faster-whisper/CTranslate2"),
    ("faster-whisper-large-v2.json", "low", "int8", "faster-whisper/CTranslate2"),
    ("qwen3-asr-1-7b-crisp-f16.json", "high", "float16", "CrispASR CUDA"),
    ("qwen3-asr-1-7b-crisp-q8-0.json", "medium", "q8_0", "CrispASR CUDA"),
    ("qwen3-asr-1-7b-crisp-q4-k.json", "low", "q4_k", "CrispASR CUDA"),
    ("qwen3-asr-0-6b-crisp-f16.json", "high", "float16", "CrispASR CUDA"),
    ("qwen3-asr-0-6b-crisp-q8-0.json", "medium", "q8_0", "CrispASR CUDA"),
    ("qwen3-asr-0-6b-crisp-q4-k.json", "low", "q4_k", "CrispASR CUDA"),
)
MANIFEST_FILENAMES = frozenset(policy[0] for policy in CURATED_PROFILE_POLICIES)
DEFAULT_MANIFEST_FILENAME = "faster-whisper-large-v3.json"
REQUIRED_CTRANSLATE2_FILES = frozenset(
    {"config.json", "model.bin", "tokenizer.json"}
)


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise WorkerError("invalid_json", "request contains duplicate fields")
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


def _load_model_manifest(
    path: Path,
    expected_backend: str = "faster-whisper/CTranslate2",
) -> ModelManifest:
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
    if raw.get("platform") != "win32-x64-cuda":
        raise RuntimeError("packaged_model_manifest_platform_mismatch")
    if raw.get("schemaVersion") != 1:
        raise RuntimeError("packaged_model_manifest_invalid")
    if raw.get("backend") != expected_backend:
        raise RuntimeError("packaged_model_manifest_backend_mismatch")
    for field in ("displayName", "license"):
        if not isinstance(raw.get(field), str) or not raw[field] or len(raw[field]) > 200:
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
        or (
            expected_backend == "faster-whisper/CTranslate2"
            and not REQUIRED_CTRANSLATE2_FILES.issubset(files)
        )
        or (
            expected_backend == "CrispASR CUDA"
            and (
                len(files) != 1
                or not all(filename.casefold().endswith(".gguf") for filename in files)
            )
        )
        or any(
            not isinstance(filename, str)
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", filename) is None
            for filename in files
        )
    ):
        raise RuntimeError("packaged_model_manifest_invalid")
    parsed_files: dict[str, ModelFile] = {}
    for filename, metadata in files.items():
        if (
            not isinstance(metadata, dict)
            or frozenset(metadata) != frozenset({"bytes", "sha256"})
            or not isinstance(metadata.get("bytes"), int)
            or isinstance(metadata["bytes"], bool)
            or metadata["bytes"] <= 0
            or not isinstance(metadata.get("sha256"), str)
            or re.fullmatch(r"[a-f0-9]{64}", metadata["sha256"]) is None
        ):
            raise RuntimeError("packaged_model_manifest_invalid")
        parsed_files[filename] = ModelFile(
            bytes=metadata["bytes"],
            sha256=metadata["sha256"],
        )
    return ModelManifest(
        backend=raw["backend"],
        display_name=raw["displayName"],
        family_id=family_id,
        artifact_id=artifact_id,
        model_id=model_id,
        storage_directory=storage_directory,
        revision=revision,
        license=raw["license"],
        files=parsed_files,
    )


MODEL_MANIFESTS_BY_FILENAME: dict[str, ModelManifest] = {}
MODEL_PROFILES: dict[tuple[str, str, str], ModelManifest] = {}
for _filename, _tier, _compute_type, _expected_backend in CURATED_PROFILE_POLICIES:
    _manifest = MODEL_MANIFESTS_BY_FILENAME.get(_filename)
    if _manifest is None:
        _manifest = _load_model_manifest(
            _manifest_path(_filename),
            _expected_backend,
        )
        MODEL_MANIFESTS_BY_FILENAME[_filename] = _manifest
    _selection = (_manifest.model_id, _tier, _compute_type)
    if _selection in MODEL_PROFILES:
        raise RuntimeError("duplicate_model_catalog_selection")
    MODEL_PROFILES[_selection] = _manifest

MODEL_MANIFESTS: dict[str, ModelManifest] = {}
_manifest_repo_counts: dict[str, int] = {}
for _manifest in MODEL_MANIFESTS_BY_FILENAME.values():
    _manifest_repo_counts[_manifest.model_id] = (
        _manifest_repo_counts.get(_manifest.model_id, 0) + 1
    )
for _manifest in MODEL_MANIFESTS_BY_FILENAME.values():
    # The three Qwen quantizations intentionally share a Hugging Face repo.
    # This compatibility map is only authoritative for repositories that map
    # to one artifact; request routing always uses MODEL_PROFILES.
    if _manifest_repo_counts[_manifest.model_id] == 1:
        MODEL_MANIFESTS[_manifest.model_id] = _manifest

# Retained as compatibility aliases for callers that only use the original
# large-v3 default. The request path always selects from MODEL_MANIFESTS.
MODEL_ID = MODEL_MANIFESTS_BY_FILENAME[DEFAULT_MANIFEST_FILENAME].model_id
MODEL_MANIFEST = MODEL_MANIFESTS[MODEL_ID]
MODEL_REVISION = MODEL_MANIFEST.revision
MODEL_DIRECTORY_NAME = MODEL_MANIFEST.storage_directory
MODEL_FILES = MODEL_MANIFEST.files


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    language: str | None


@dataclass(frozen=True)
class DeviceInfo:
    device_name: str
    total_vram_bytes: int
    free_vram_bytes: int
    device_index: int = 0


@dataclass(frozen=True)
class ValidatedAudio:
    path: Path
    wav_bytes: bytes


class InferenceRuntime(Protocol):
    def transcribe(
        self,
        audio: ValidatedAudio,
        *,
        language: str | None,
        context: str,
    ) -> TranscriptionResult: ...

    def close(self) -> None: ...


RuntimeFactory = Callable[[Path, str, ModelManifest], InferenceRuntime]
ModelInstaller = Callable[[Path, ModelManifest], Path]
DeviceInfoProvider = Callable[[], DeviceInfo]


def _send(output_stream: TextIO, payload: dict[str, Any]) -> None:
    output_stream.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
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


def _normalize_language(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > MAX_LANGUAGE_CHARS:
        raise WorkerError("invalid_language", "language is invalid")
    normalized = value.strip().casefold()
    if normalized in ("", "auto", "automatic"):
        return None
    if normalized in LANGUAGE_CODE_TO_NAME:
        return normalized
    code = LANGUAGE_NAME_TO_CODE.get(normalized)
    if code is not None:
        return code
    raise WorkerError("invalid_language", "language is not supported by Whisper")


def _validated_tier_compute_type(
    message: dict[str, Any],
    model_id: str,
) -> tuple[str, str]:
    tier = message.get("tier")
    compute_type = message.get("computeType")
    if not isinstance(tier, str) or tier not in {"high", "medium", "low"}:
        raise WorkerError("invalid_tier", "tier must be high, medium, or low")
    if not isinstance(compute_type, str) or len(compute_type) > 32:
        raise WorkerError(
            "invalid_compute_type",
            "computeType is invalid",
        )
    expected_compute_type = (
        QWEN_TIER_COMPUTE_TYPES[tier]
        if model_id in QWEN_MODEL_IDS
        else WHISPER_TIER_COMPUTE_TYPES[tier]
    )
    if compute_type != expected_compute_type:
        raise WorkerError(
            "invalid_compute_type",
            "computeType does not match the requested model and tier",
        )
    return tier, compute_type


def _strict_fields(message: dict[str, Any], expected: frozenset[str]) -> None:
    if frozenset(message) != expected:
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


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return path != root


def _is_reparse_point(metadata: os.stat_result) -> bool:
    file_attributes = getattr(metadata, "st_file_attributes", 0)
    reparse_attribute = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return stat.S_ISLNK(metadata.st_mode) or bool(file_attributes & reparse_attribute)


def _bounded_absolute_directory(raw_path: str, *, create: bool) -> Path:
    if not raw_path or len(raw_path) > MAX_PATH_CHARS:
        raise WorkerError("invalid_model_root", "modelRoot is invalid")
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        raise WorkerError("invalid_model_root", "modelRoot must be absolute")
    try:
        if create:
            candidate.mkdir(parents=True, exist_ok=True, mode=0o700)
        metadata = candidate.lstat()
        if _is_reparse_point(metadata) or not stat.S_ISDIR(metadata.st_mode):
            raise WorkerError(
                "invalid_model_root",
                "modelRoot must be a regular directory",
            )
        resolved = candidate.resolve(strict=True)
    except WorkerError:
        raise
    except OSError as error:
        raise WorkerError("invalid_model_root", "modelRoot is unavailable") from error
    if not resolved.is_dir() or resolved == Path(resolved.anchor):
        raise WorkerError("invalid_model_root", "modelRoot must be a non-root directory")
    return resolved


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(16 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _valid_model_directory(model_directory: Path, manifest: ModelManifest) -> bool:
    try:
        directory_metadata = model_directory.lstat()
        if _is_reparse_point(directory_metadata) or not stat.S_ISDIR(
            directory_metadata.st_mode
        ):
            return False
        entries = {entry.name: entry for entry in model_directory.iterdir()}
        if set(entries) != set(manifest.files):
            return False
        for filename, expected in manifest.files.items():
            candidate = entries[filename]
            metadata = candidate.lstat()
            if (
                _is_reparse_point(metadata)
                or not stat.S_ISREG(metadata.st_mode)
                or metadata.st_size != expected.bytes
            ):
                return False
            if _sha256(candidate) != expected.sha256:
                return False
        return True
    except OSError:
        return False


def _safe_remove_entry(path: Path, root: Path) -> None:
    root = root.resolve(strict=True)
    lexical_path = path.absolute()
    if not _is_within(lexical_path, root):
        raise WorkerError("unsafe_model_path", "refusing to remove an unbounded path")
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    if _is_reparse_point(metadata) or not stat.S_ISDIR(metadata.st_mode):
        raise WorkerError(
            "unsafe_model_path",
            "refusing to remove a non-directory model path",
        )
    shutil.rmtree(path)


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
    # Windows does not support opening ordinary directory handles through
    # os.open. Model/marker file handles are flushed by their writers; renames
    # remain atomic within the model root.
    if os.name == "nt":
        return
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
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
    descriptor = os.open(
        marker,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(
                _transaction_marker_payload(transaction_id, manifest),
                handle,
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            )
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
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
        if _is_reparse_point(transaction_metadata) or not stat.S_ISDIR(
            transaction_metadata.st_mode
        ):
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
            _is_reparse_point(marker_metadata)
            or not stat.S_ISREG(marker_metadata.st_mode)
            or marker_metadata.st_size > 4_096
        ):
            return False
        for directory_name in ("staging", "backup"):
            directory = entries.get(directory_name)
            if directory is None:
                continue
            metadata = directory.lstat()
            if _is_reparse_point(metadata) or not stat.S_ISDIR(metadata.st_mode):
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
    _safe_remove_entry(transaction, model_root)
    _sync_directory(model_root)


def _regular_directory_present(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    except OSError as error:
        raise WorkerError("unsafe_model_path", "model path is unavailable") from error
    if _is_reparse_point(metadata) or not stat.S_ISDIR(metadata.st_mode):
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
            _safe_remove_entry(final_directory, model_root)
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
        _remove_owned_model_transaction(transaction, model_root, manifest)


def ensure_model(model_root: Path, manifest: ModelManifest) -> Path:
    model_root = _bounded_absolute_directory(str(model_root), create=True)
    final_directory = model_root / manifest.storage_directory
    _recover_model_transactions(model_root, manifest)
    if _valid_model_directory(final_directory, manifest):
        return final_directory

    if shutil.disk_usage(model_root).free < MIN_FREE_DISK_BYTES:
        raise WorkerError("insufficient_disk_space", "at least 6 GiB of free disk is required")

    transaction, staging, backup = _create_model_transaction(model_root, manifest)
    try:
        try:
            from huggingface_hub import snapshot_download

            snapshot_download(
                repo_id=manifest.model_id,
                revision=manifest.revision,
                local_dir=staging,
                allow_patterns=sorted(manifest.files),
                max_workers=4,
                token=False,
            )
        except Exception as error:
            raise WorkerError("model_download_failed", "model download failed") from error

        # huggingface_hub may create local transfer metadata even when the
        # remote allowlist is exact. It is never part of the activated model.
        _safe_remove_entry(staging / ".cache", model_root)
        if not _valid_model_directory(staging, manifest):
            raise WorkerError("model_checksum_failed", "downloaded model verification failed")
        if _regular_directory_present(final_directory):
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
        if not _valid_model_directory(final_directory, manifest):
            raise WorkerError("model_activation_failed", "activated model verification failed")
        _remove_owned_model_transaction(transaction, model_root, manifest)
        return final_directory
    finally:
        if transaction.exists():
            _recover_model_transactions(model_root, manifest)


def _assert_unambiguous_audio_path(audio_path: Path, allowed_root: Path) -> None:
    try:
        relative_audio = audio_path.relative_to(allowed_root)
    except ValueError as error:
        raise WorkerError(
            "audio_path_not_allowed",
            "audio file is outside the allowed root",
        ) from error
    if not relative_audio.parts:
        raise WorkerError("invalid_audio_file", "audio must be a WAV file")

    current = allowed_root
    paths = [current]
    for part in relative_audio.parts:
        current /= part
        paths.append(current)
    try:
        for path in paths:
            if _is_reparse_point(path.lstat()):
                raise WorkerError(
                    "invalid_audio_path",
                    "audio path must not contain filesystem links",
                )
    except WorkerError:
        raise
    except OSError as error:
        raise WorkerError("invalid_audio_path", "audio file is unavailable") from error


def _same_file_identity(first: os.stat_result, second: os.stat_result) -> bool:
    return first.st_dev == second.st_dev and first.st_ino == second.st_ino


def _verify_open_audio_file(
    handle: BinaryIO,
    audio_path: Path,
    *,
    expected_identity: os.stat_result,
    expected_size: int,
) -> None:
    try:
        handle_metadata = os.fstat(handle.fileno())
        path_metadata = audio_path.lstat()
    except OSError as error:
        raise WorkerError("invalid_audio_file", "audio file is unavailable") from error
    if (
        _is_reparse_point(path_metadata)
        or not stat.S_ISREG(handle_metadata.st_mode)
        or not stat.S_ISREG(path_metadata.st_mode)
        or not _same_file_identity(handle_metadata, path_metadata)
        or not _same_file_identity(handle_metadata, expected_identity)
        or handle_metadata.st_size != expected_size
        or path_metadata.st_size != expected_size
    ):
        raise WorkerError(
            "invalid_audio_file",
            "audio file changed during validation",
        )


def validate_audio_path(audio_path_raw: str, allowed_root_raw: str) -> ValidatedAudio:
    if (
        not audio_path_raw
        or not allowed_root_raw
        or len(audio_path_raw) > MAX_PATH_CHARS
        or len(allowed_root_raw) > MAX_PATH_CHARS
    ):
        raise WorkerError("invalid_audio_path", "audio path is invalid")
    lexical_allowed_root = Path(os.path.abspath(allowed_root_raw))
    lexical_audio_path = Path(os.path.abspath(audio_path_raw))
    _assert_unambiguous_audio_path(lexical_audio_path, lexical_allowed_root)
    try:
        allowed_root = lexical_allowed_root.resolve(strict=True)
        audio_path = lexical_audio_path.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise WorkerError("invalid_audio_path", "audio file is unavailable") from error
    if not allowed_root.is_dir() or not _is_within(audio_path, allowed_root):
        raise WorkerError("audio_path_not_allowed", "audio file is outside the allowed root")
    if audio_path.suffix.lower() != ".wav":
        raise WorkerError("invalid_audio_file", "audio must be a WAV file")
    try:
        path_metadata = lexical_audio_path.lstat()
    except OSError as error:
        raise WorkerError("invalid_audio_path", "audio file is unavailable") from error
    if _is_reparse_point(path_metadata) or not stat.S_ISREG(path_metadata.st_mode):
        raise WorkerError("invalid_audio_file", "audio must be a WAV file")
    size = path_metadata.st_size
    if size <= WAV_HEADER_BYTES or size > MAX_AUDIO_BYTES:
        raise WorkerError("invalid_audio_file", "audio file size is invalid")

    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOINHERIT", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(lexical_audio_path, flags)
        with os.fdopen(descriptor, "rb") as handle:
            _verify_open_audio_file(
                handle,
                lexical_audio_path,
                expected_identity=path_metadata,
                expected_size=size,
            )
            wav_bytes = handle.read(MAX_AUDIO_BYTES + 1)
            _assert_unambiguous_audio_path(lexical_audio_path, lexical_allowed_root)
            if (
                lexical_allowed_root.resolve(strict=True) != allowed_root
                or lexical_audio_path.resolve(strict=True) != audio_path
            ):
                raise WorkerError(
                    "invalid_audio_file",
                    "audio file changed during validation",
                )
            _verify_open_audio_file(
                handle,
                lexical_audio_path,
                expected_identity=path_metadata,
                expected_size=size,
            )
    except WorkerError:
        raise
    except (OSError, RuntimeError) as error:
        raise WorkerError("invalid_audio_file", "audio file is unavailable") from error
    if len(wav_bytes) != size:
        raise WorkerError("invalid_audio_file", "audio file changed during validation")

    try:
        with wave.open(io.BytesIO(wav_bytes), "rb") as wav:
            if (
                wav.getnchannels() != REQUIRED_CHANNELS
                or wav.getsampwidth() != REQUIRED_SAMPLE_WIDTH_BYTES
                or wav.getframerate() != REQUIRED_SAMPLE_RATE
                or wav.getcomptype() != "NONE"
                or wav.getnframes() <= 0
                or wav.getnframes() > MAX_AUDIO_FRAMES
            ):
                raise WorkerError(
                    "invalid_audio_format",
                    "audio must be mono 16 kHz PCM16 WAV",
                )
            if wav.getnframes() * wav.getnchannels() * wav.getsampwidth() > MAX_AUDIO_BYTES:
                raise WorkerError("invalid_audio_file", "audio payload is too large")
    except WorkerError:
        raise
    except (EOFError, OSError, wave.Error) as error:
        raise WorkerError("invalid_audio_file", "audio WAV is malformed") from error
    return ValidatedAudio(path=audio_path, wav_bytes=wav_bytes)


def _configure_windows_cuda_dlls() -> None:
    global _CUDA_DLLS_CONFIGURED
    if _CUDA_DLLS_CONFIGURED or sys.platform != "win32":
        return

    prefix = Path(sys.prefix).resolve()
    dll_directories: list[Path] = []
    for module_name in ("nvidia.cublas", "nvidia.cuda_nvrtc", "nvidia.cudnn"):
        try:
            spec = importlib.util.find_spec(module_name)
        except (ImportError, ModuleNotFoundError, ValueError):
            spec = None
        if spec is None:
            continue
        roots = list(spec.submodule_search_locations or ())
        if spec.origin:
            roots.append(str(Path(spec.origin).parent))
        for root in roots:
            candidate = (Path(root) / "bin").resolve()
            if candidate.is_dir() and _is_within(candidate, prefix):
                dll_directories.append(candidate)

    existing_path = os.environ.get("PATH", "")
    path_entries = existing_path.split(os.pathsep) if existing_path else []
    for directory in dict.fromkeys(dll_directories):
        directory_text = str(directory)
        if directory_text not in path_entries:
            path_entries.insert(0, directory_text)
        add_dll_directory = getattr(os, "add_dll_directory", None)
        if add_dll_directory is not None:
            _DLL_DIRECTORY_HANDLES.append(add_dll_directory(directory_text))
    os.environ["PATH"] = os.pathsep.join(path_entries)
    _CUDA_DLLS_CONFIGURED = True


def _bind_cuda_device(physical_index: int) -> None:
    """Expose exactly one dynamically selected NVIDIA device to both engines."""
    global _BOUND_CUDA_PHYSICAL_INDEX
    if _BOUND_CUDA_PHYSICAL_INDEX is None:
        os.environ["CUDA_VISIBLE_DEVICES"] = str(physical_index)
        _BOUND_CUDA_PHYSICAL_INDEX = physical_index
        return
    if _BOUND_CUDA_PHYSICAL_INDEX != physical_index:
        raise WorkerError(
            "cuda_device_changed",
            "the selected NVIDIA GPU changed; restart LocalScribe before loading a model",
        )


def query_device_info() -> DeviceInfo:
    global _SELECTED_CUDA_DEVICE_INDEX
    try:
        import pynvml
    except Exception as error:
        raise WorkerError("cuda_unavailable", "NVIDIA device telemetry is unavailable") from error

    initialized = False
    try:
        pynvml.nvmlInit()
        initialized = True
        device_count = int(pynvml.nvmlDeviceGetCount())
        if device_count < 1:
            raise WorkerError("cuda_unavailable", "an NVIDIA CUDA GPU is required")
        candidates: list[DeviceInfo] = []
        invalid_telemetry = False
        for device_index in range(device_count):
            try:
                handle = pynvml.nvmlDeviceGetHandleByIndex(device_index)
                raw_name = pynvml.nvmlDeviceGetName(handle)
                name = (
                    raw_name.decode("utf-8", errors="replace")
                    if isinstance(raw_name, bytes)
                    else raw_name
                )
                memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
                total_bytes = int(memory.total)
                free_bytes = int(memory.free)
            except Exception:
                invalid_telemetry = True
                continue
            if (
                not isinstance(name, str)
                or not name.strip()
                or len(name) > 200
                or total_bytes <= 0
                or free_bytes < 0
                or free_bytes > total_bytes
            ):
                invalid_telemetry = True
                continue
            candidates.append(
                DeviceInfo(
                    name.strip(),
                    total_bytes,
                    free_bytes,
                    device_index,
                )
            )
        if not candidates:
            if invalid_telemetry:
                raise WorkerError(
                    "device_info_invalid",
                    "NVIDIA device telemetry is invalid",
                )
            raise WorkerError("device_info_invalid", "NVIDIA device telemetry is invalid")
        # Main's Auto decision and CTranslate2 must refer to one physical GPU.
        # Prefer currently free capacity, then total capacity, then the lower
        # stable CUDA/NVML ordinal for deterministic ties.
        selected = max(
            candidates,
            key=lambda device: (
                device.free_vram_bytes,
                device.total_vram_bytes,
                -device.device_index,
            ),
        )
        _bind_cuda_device(selected.device_index)
        _SELECTED_CUDA_DEVICE_INDEX = selected.device_index
        return selected
    except WorkerError:
        raise
    except Exception as error:
        raise WorkerError("cuda_unavailable", "an NVIDIA CUDA GPU is required") from error
    finally:
        if initialized:
            try:
                pynvml.nvmlShutdown()
            except Exception:
                pass


class FasterWhisperRuntime:
    def __init__(self, model: Any, numpy_module: Any, compute_type: str) -> None:
        self._model = model
        self._numpy = numpy_module
        self.compute_type = compute_type
        self._closed = False

    @classmethod
    def load(
        cls,
        model_directory: Path,
        compute_type: str,
        manifest: ModelManifest,
    ) -> FasterWhisperRuntime:
        if compute_type not in WHISPER_TIER_COMPUTE_TYPES.values():
            raise WorkerError("invalid_compute_type", "compute type is not allowed")
        if not _valid_model_directory(model_directory, manifest):
            raise WorkerError("model_checksum_failed", "local model verification failed")

        try:
            _configure_windows_cuda_dlls()
            import ctranslate2
            import numpy as np
            from faster_whisper import WhisperModel
        except Exception as error:
            raise WorkerError(
                "runtime_import_failed",
                "faster-whisper CUDA runtime dependencies are unavailable",
            ) from error

        try:
            if ctranslate2.get_cuda_device_count() < 1:
                raise WorkerError("cuda_unavailable", "an NVIDIA CUDA GPU is required")
            physical_device_index = _SELECTED_CUDA_DEVICE_INDEX
            if physical_device_index is None:
                # Install/switch/shutdown boundaries create fresh workers.
                # Never silently fall back to GPU 0 after such a restart:
                # re-run the same NVML selector used by device_info.
                physical_device_index = query_device_info().device_index
            _bind_cuda_device(physical_device_index)
            # CUDA_VISIBLE_DEVICES maps the selected physical adapter to the
            # only logical adapter exposed inside this isolated worker.
            device_index = 0
            if device_index >= ctranslate2.get_cuda_device_count():
                raise WorkerError(
                    "cuda_unavailable",
                    "the selected NVIDIA GPU is unavailable to CTranslate2",
                )
            supported_types = set(
                ctranslate2.get_supported_compute_types("cuda", device_index)
            )
        except WorkerError:
            raise
        except Exception as error:
            raise WorkerError("cuda_unavailable", "an NVIDIA CUDA GPU is required") from error
        if compute_type not in supported_types:
            raise WorkerError(
                "compute_type_unsupported",
                f"the NVIDIA GPU does not support {compute_type}",
            )

        try:
            model = WhisperModel(
                str(model_directory),
                device="cuda",
                device_index=device_index,
                compute_type=compute_type,
                local_files_only=True,
            )
        except Exception as error:
            raise WorkerError(
                "model_load_failed",
                "faster-whisper could not load the model with CUDA 12 and cuDNN 9",
            ) from error
        return cls(model, np, compute_type)

    def _read_pcm16(self, audio: ValidatedAudio) -> Any:
        try:
            with wave.open(io.BytesIO(audio.wav_bytes), "rb") as wav:
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
                raw = wav.readframes(frame_count)
        except (EOFError, OSError, wave.Error) as error:
            raise WorkerError("invalid_audio_file", "audio WAV is malformed") from error
        expected_bytes = frame_count * REQUIRED_CHANNELS * REQUIRED_SAMPLE_WIDTH_BYTES
        if len(raw) != expected_bytes or len(raw) > MAX_AUDIO_BYTES:
            raise WorkerError("invalid_audio_file", "audio payload is invalid")
        return self._numpy.frombuffer(raw, dtype="<i2").astype(self._numpy.float32) / 32768.0

    def transcribe(
        self,
        audio: ValidatedAudio,
        *,
        language: str | None,
        context: str,
    ) -> TranscriptionResult:
        if self._closed or self._model is None:
            raise WorkerError("model_not_loaded", "ASR model is not loaded")
        pcm = self._read_pcm16(audio)
        try:
            segment_iterator, info = self._model.transcribe(
                pcm,
                language=language,
                initial_prompt=context or None,
                beam_size=5,
                word_timestamps=False,
            )
            text_parts: list[str] = []
            text_characters = 0
            for segment in segment_iterator:
                segment_text = getattr(segment, "text", None)
                if not isinstance(segment_text, str):
                    raise WorkerError(
                        "invalid_model_output",
                        "model returned an invalid transcription",
                    )
                text_characters += len(segment_text)
                if text_characters > MAX_RESULT_CHARS:
                    raise WorkerError(
                        "invalid_model_output",
                        "model returned an oversized transcription",
                    )
                text_parts.append(segment_text)
        except WorkerError:
            raise
        except Exception as error:
            raise WorkerError("transcription_failed", "speech transcription failed") from error

        detected_language = getattr(info, "language", None)
        if not isinstance(detected_language, str) or detected_language not in LANGUAGE_CODE_TO_NAME:
            detected_language = language
        text = "".join(text_parts).strip()
        return TranscriptionResult(
            text=text,
            language=detected_language,
        )

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        model = self._model
        self._model = None
        if model is not None:
            unload_model = getattr(getattr(model, "model", None), "unload_model", None)
            if callable(unload_model):
                try:
                    unload_model()
                except Exception:
                    pass
        gc.collect()


class _CrispASROpenParams(ctypes.Structure):
    _fields_ = [
        ("abi_version", ctypes.c_int),
        ("n_threads", ctypes.c_int),
        ("use_gpu", ctypes.c_int),
        ("verbosity", ctypes.c_int),
        ("flash_attn", ctypes.c_int),
        ("n_gpu_layers", ctypes.c_int),
        ("reserved", ctypes.c_int * 6),
    ]


def _crispasr_library_path() -> Path:
    for parent in Path(__file__).resolve().parents:
        for relative in (
            Path("resources") / "native" / "windows" / "crispasr" / "crispasr.dll",
            Path("native") / "windows" / "crispasr" / "crispasr.dll",
        ):
            candidate = parent / relative
            try:
                metadata = candidate.lstat()
            except OSError:
                continue
            if stat.S_ISREG(metadata.st_mode) and not _is_reparse_point(metadata):
                return candidate.resolve(strict=True)
    raise WorkerError(
        "runtime_import_failed",
        "the packaged CrispASR CUDA runtime is unavailable",
    )


class CrispASRRuntime:
    def __init__(self, library: Any, session: int, numpy_module: Any) -> None:
        self._library = library
        self._session = session
        self._numpy = numpy_module
        self._closed = False

    @staticmethod
    def _configure_signatures(library: Any) -> None:
        required_symbols = (
            "crispasr_set_gpu_backend",
            "crispasr_session_open_with_params",
            "crispasr_session_backend",
            "crispasr_session_transcribe",
            "crispasr_session_result_n_segments",
            "crispasr_session_result_segment_text",
            "crispasr_session_result_free",
            "crispasr_session_close",
        )
        if any(not hasattr(library, symbol) for symbol in required_symbols):
            raise WorkerError(
                "runtime_import_failed",
                "the packaged CrispASR runtime has an incompatible ABI",
            )
        library.crispasr_set_gpu_backend.argtypes = [ctypes.c_char_p]
        library.crispasr_set_gpu_backend.restype = None
        library.crispasr_session_open_with_params.argtypes = [
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.POINTER(_CrispASROpenParams),
        ]
        library.crispasr_session_open_with_params.restype = ctypes.c_void_p
        library.crispasr_session_backend.argtypes = [ctypes.c_void_p]
        library.crispasr_session_backend.restype = ctypes.c_char_p
        library.crispasr_session_transcribe.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_float),
            ctypes.c_int,
        ]
        library.crispasr_session_transcribe.restype = ctypes.c_void_p
        if hasattr(library, "crispasr_session_transcribe_lang"):
            library.crispasr_session_transcribe_lang.argtypes = [
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.c_float),
                ctypes.c_int,
                ctypes.c_char_p,
            ]
            library.crispasr_session_transcribe_lang.restype = ctypes.c_void_p
        if hasattr(library, "crispasr_session_set_hotwords"):
            library.crispasr_session_set_hotwords.argtypes = [
                ctypes.c_void_p,
                ctypes.c_char_p,
                ctypes.c_float,
            ]
            library.crispasr_session_set_hotwords.restype = ctypes.c_int
        library.crispasr_session_result_n_segments.argtypes = [ctypes.c_void_p]
        library.crispasr_session_result_n_segments.restype = ctypes.c_int
        library.crispasr_session_result_segment_text.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
        ]
        library.crispasr_session_result_segment_text.restype = ctypes.c_char_p
        library.crispasr_session_result_free.argtypes = [ctypes.c_void_p]
        library.crispasr_session_result_free.restype = None
        library.crispasr_session_close.argtypes = [ctypes.c_void_p]
        library.crispasr_session_close.restype = None

    @classmethod
    def load(
        cls,
        model_directory: Path,
        compute_type: str,
        manifest: ModelManifest,
    ) -> CrispASRRuntime:
        if (
            manifest.family_id not in {"qwen3-asr-1-7b", "qwen3-asr-0-6b"}
            or manifest.backend != "CrispASR CUDA"
            or compute_type not in QWEN_TIER_COMPUTE_TYPES.values()
            or not _valid_model_directory(model_directory, manifest)
        ):
            raise WorkerError("model_checksum_failed", "local Qwen model verification failed")
        device_index = _SELECTED_CUDA_DEVICE_INDEX
        if device_index is None:
            device_index = query_device_info().device_index
        _bind_cuda_device(device_index)
        _configure_windows_cuda_dlls()
        library_path = _crispasr_library_path()
        native_directory = library_path.parent
        add_dll_directory = getattr(os, "add_dll_directory", None)
        if add_dll_directory is not None:
            _DLL_DIRECTORY_HANDLES.append(add_dll_directory(str(native_directory)))
        try:
            import numpy as np

            library = ctypes.CDLL(str(library_path))
            cls._configure_signatures(library)
            library.crispasr_set_gpu_backend(b"cuda")
            model_filename = next(iter(manifest.files))
            model_path = (model_directory / model_filename).resolve(strict=True)
            params = _CrispASROpenParams(
                abi_version=2,
                n_threads=min(8, max(1, os.cpu_count() or 4)),
                use_gpu=1,
                verbosity=0,
                flash_attn=1,
                n_gpu_layers=-1,
                reserved=(ctypes.c_int * 6)(*([0] * 6)),
            )
            session = library.crispasr_session_open_with_params(
                os.fsencode(model_path),
                b"qwen3",
                ctypes.byref(params),
            )
        except WorkerError:
            raise
        except Exception as error:
            raise WorkerError(
                "runtime_import_failed",
                "the CrispASR CUDA runtime could not be loaded",
            ) from error
        if not session:
            raise WorkerError(
                "model_load_failed",
                "CrispASR could not load the selected Qwen3-ASR model with CUDA",
            )
        backend = library.crispasr_session_backend(session)
        backend_name = backend.decode("utf-8", errors="replace") if backend else ""
        if backend_name not in {"qwen3", "qwen3-1.7b"}:
            library.crispasr_session_close(session)
            raise WorkerError(
                "model_load_failed",
                "CrispASR loaded an unexpected model backend",
            )
        return cls(library, session, np)

    def _read_pcm16(self, audio: ValidatedAudio) -> Any:
        try:
            with wave.open(io.BytesIO(audio.wav_bytes), "rb") as wav:
                frame_count = wav.getnframes()
                raw = wav.readframes(frame_count)
        except (EOFError, OSError, wave.Error) as error:
            raise WorkerError("invalid_audio_file", "audio WAV is malformed") from error
        expected_bytes = frame_count * REQUIRED_CHANNELS * REQUIRED_SAMPLE_WIDTH_BYTES
        if len(raw) != expected_bytes or len(raw) > MAX_AUDIO_BYTES:
            raise WorkerError("invalid_audio_file", "audio payload is invalid")
        return (
            self._numpy.frombuffer(raw, dtype="<i2").astype(self._numpy.float32)
            / 32768.0
        )

    def transcribe(
        self,
        audio: ValidatedAudio,
        *,
        language: str | None,
        context: str,
    ) -> TranscriptionResult:
        if self._closed or not self._session:
            raise WorkerError("model_not_loaded", "ASR model is not loaded")
        pcm = self._read_pcm16(audio)
        if hasattr(self._library, "crispasr_session_set_hotwords"):
            hotwords = context.encode("utf-8") if context else None
            if self._library.crispasr_session_set_hotwords(
                self._session,
                hotwords,
                ctypes.c_float(2.0),
            ) != 0:
                raise WorkerError(
                    "transcription_failed",
                    "Qwen contextual vocabulary could not be applied",
                )
        samples = pcm.ctypes.data_as(ctypes.POINTER(ctypes.c_float))
        try:
            if language and hasattr(
                self._library,
                "crispasr_session_transcribe_lang",
            ):
                result = self._library.crispasr_session_transcribe_lang(
                    self._session,
                    samples,
                    len(pcm),
                    language.encode("utf-8"),
                )
            else:
                result = self._library.crispasr_session_transcribe(
                    self._session,
                    samples,
                    len(pcm),
                )
        except Exception as error:
            raise WorkerError("transcription_failed", "speech transcription failed") from error
        if not result:
            raise WorkerError("transcription_failed", "speech transcription failed")
        try:
            segment_count = self._library.crispasr_session_result_n_segments(result)
            if segment_count < 0 or segment_count > 100_000:
                raise WorkerError(
                    "invalid_model_output",
                    "model returned an invalid transcription",
                )
            text_parts: list[str] = []
            text_characters = 0
            for index in range(segment_count):
                raw_text = self._library.crispasr_session_result_segment_text(
                    result,
                    index,
                )
                segment_text = (
                    raw_text.decode("utf-8", errors="strict") if raw_text else ""
                )
                text_characters += len(segment_text)
                if text_characters > MAX_RESULT_CHARS:
                    raise WorkerError(
                        "invalid_model_output",
                        "model returned an oversized transcription",
                    )
                text_parts.append(segment_text)
            return TranscriptionResult(" ".join(text_parts).strip(), language)
        except UnicodeDecodeError as error:
            raise WorkerError(
                "invalid_model_output",
                "model returned an invalid transcription",
            ) from error
        finally:
            self._library.crispasr_session_result_free(result)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        session = self._session
        self._session = 0
        if session:
            try:
                self._library.crispasr_session_close(session)
            except Exception:
                pass
        gc.collect()


def _load_runtime(
    model_directory: Path,
    compute_type: str,
    manifest: ModelManifest,
) -> InferenceRuntime:
    if manifest.family_id in {"qwen3-asr-1-7b", "qwen3-asr-0-6b"}:
        return CrispASRRuntime.load(model_directory, compute_type, manifest)
    if manifest.family_id in {"whisper-large-v3", "whisper-large-v2"}:
        return FasterWhisperRuntime.load(model_directory, compute_type, manifest)
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


def run_worker(
    *,
    input_stream: BinaryIO,
    output_stream: TextIO,
    error_stream: TextIO,
    model_installer: ModelInstaller = ensure_model,
    runtime_factory: RuntimeFactory = _load_runtime,
    device_info_provider: DeviceInfoProvider = query_device_info,
    platform_name: str | None = None,
) -> int:
    runtime: InferenceRuntime | None = None
    active_manifest: ModelManifest | None = None
    active_model_id: str | None = None
    active_model_root: Path | None = None
    active_tier: str | None = None
    active_compute_type: str | None = None
    platform_name = platform_name or sys.platform
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
                _send_error(output_stream, None, "request_too_large", "request exceeds 16 KiB")
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
                    raise WorkerError("invalid_json", "request must be one JSON object") from error
                if not isinstance(message, dict):
                    raise WorkerError("invalid_request", "request must be a JSON object")
                request_id = _request_id(message)
                message_type = _string_field(message, "type", max_chars=64)

                if message_type == "install_model":
                    _strict_fields(message, MODEL_OPERATION_FIELDS)
                    if platform_name != "win32":
                        raise WorkerError(
                            "windows_only",
                            "the LocalScribe CUDA worker requires Windows",
                        )
                    model_id = _string_field(message, "modelId", max_chars=200)
                    tier, compute_type = _validated_tier_compute_type(
                        message,
                        model_id,
                    )
                    manifest = MODEL_PROFILES.get((model_id, tier, compute_type))
                    if manifest is None:
                        raise WorkerError(
                            "model_not_allowed",
                            "modelId, tier, and computeType must match the model catalog",
                        )
                    if message.get("allowDownload") is not True:
                        raise WorkerError(
                            "allow_download_required",
                            "install_model requires allowDownload to be true",
                        )
                    model_root_raw = _string_field(
                        message,
                        "modelRoot",
                        max_chars=MAX_PATH_CHARS,
                    )
                    model_root = _bounded_absolute_directory(model_root_raw, create=True)

                    # Installation is a deliberately separate boundary from
                    # loading: it only stages, verifies, and activates the
                    # pinned catalog artifact. Do not touch CUDA capability
                    # checks or construct a CTranslate2 runtime here.
                    started = time.perf_counter()
                    local_model = model_installer(model_root, manifest)
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
                    if not _valid_model_directory(local_model, manifest):
                        raise WorkerError(
                            "model_checksum_failed",
                            "installed model verification failed",
                        )
                    _send(
                        output_stream,
                        {
                            "type": "model_installed",
                            "id": request_id,
                            "modelId": model_id,
                            "tier": tier,
                            "computeType": compute_type,
                            "installMs": round((time.perf_counter() - started) * 1000),
                        },
                    )
                elif message_type == "load_model":
                    _strict_fields(message, MODEL_OPERATION_FIELDS)
                    if platform_name != "win32":
                        raise WorkerError(
                            "windows_only",
                            "the LocalScribe CUDA worker requires Windows",
                        )
                    model_id = _string_field(message, "modelId", max_chars=200)
                    tier, compute_type = _validated_tier_compute_type(
                        message,
                        model_id,
                    )
                    manifest = MODEL_PROFILES.get((model_id, tier, compute_type))
                    if manifest is None:
                        raise WorkerError(
                            "model_not_allowed",
                            "modelId, tier, and computeType must match the model catalog",
                        )
                    allow_download = message.get("allowDownload")
                    if allow_download is not False:
                        raise WorkerError(
                            "allow_download_forbidden",
                            "load_model requires allowDownload to be false",
                        )
                    model_root_raw = _string_field(
                        message,
                        "modelRoot",
                        max_chars=MAX_PATH_CHARS,
                    )
                    model_root = _bounded_absolute_directory(model_root_raw, create=True)
                    # A killed repair can leave the verified prior artifact in
                    # a marker-owned backup between the two atomic renames.
                    # Recover that local data before declaring the model
                    # missing; this path never downloads.
                    _recover_model_transactions(model_root, manifest)
                    if (
                        runtime is not None
                        and active_model_id == model_id
                        and active_model_root == model_root
                        and active_tier == tier
                        and active_compute_type == compute_type
                    ):
                        _send(
                            output_stream,
                            {
                                "type": "model_ready",
                                "id": request_id,
                                "modelId": model_id,
                                "tier": tier,
                                "computeType": compute_type,
                                "loadMs": 0,
                            },
                        )
                        continue
                    if not _valid_model_directory(
                        model_root / manifest.storage_directory,
                        manifest,
                    ):
                        raise WorkerError(
                            "model_not_installed",
                            "install the local speech model from LocalScribe Settings before dictating",
                        )

                    started = time.perf_counter()
                    local_model = model_installer(model_root, manifest)
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
                    if not _valid_model_directory(local_model, manifest):
                        raise WorkerError(
                            "model_checksum_failed",
                            "local model verification failed",
                        )
                    if runtime is not None:
                        runtime.close()
                        runtime = None
                        active_manifest = None
                        active_model_id = None
                        active_model_root = None
                        active_tier = None
                        active_compute_type = None
                    runtime = runtime_factory(local_model, compute_type, manifest)
                    active_manifest = manifest
                    active_model_id = model_id
                    active_model_root = model_root
                    active_tier = tier
                    active_compute_type = compute_type
                    _send(
                        output_stream,
                        {
                            "type": "model_ready",
                            "id": request_id,
                            "modelId": model_id,
                            "tier": tier,
                            "computeType": compute_type,
                            "loadMs": round((time.perf_counter() - started) * 1000),
                        },
                    )
                elif message_type == "device_info":
                    _strict_fields(message, frozenset({"type", "id"}))
                    if platform_name != "win32":
                        raise WorkerError(
                            "windows_only",
                            "NVIDIA device telemetry requires Windows",
                        )
                    device_info = device_info_provider()
                    _send(
                        output_stream,
                        {
                            "type": "device_info",
                            "id": request_id,
                            "acceleratorKind": "nvidia-cuda",
                            "deviceName": device_info.device_name,
                            "deviceIndex": device_info.device_index,
                            "totalVramBytes": device_info.total_vram_bytes,
                            "freeVramBytes": device_info.free_vram_bytes,
                            "memoryBasis": "nvml-current",
                        },
                    )
                elif message_type == "health":
                    _strict_fields(message, frozenset({"type", "id"}))
                    _send(
                        output_stream,
                        {"type": "health", "id": request_id, "ready": runtime is not None},
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
                    validated_audio = validate_audio_path(audio_path_raw, allowed_root_raw)
                    try:
                        context = message.get("context")
                        if not isinstance(context, str) or len(context) > MAX_CONTEXT_CHARS:
                            raise WorkerError(
                                "invalid_context",
                                "context must be at most 4000 characters",
                            )
                        language = _normalize_language(message.get("language"))
                        if (
                            language is not None
                            and active_manifest is not None
                            and language
                            in UNSUPPORTED_LANGUAGE_CODES_BY_FAMILY.get(
                                active_manifest.family_id,
                                frozenset(),
                            )
                        ):
                            raise WorkerError(
                                "invalid_language",
                                "language is not supported by the selected Whisper model",
                            )
                        started = time.perf_counter()
                        result = runtime.transcribe(
                            validated_audio,
                            language=language,
                            context=context,
                        )
                    finally:
                        del validated_audio
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
                elif message_type == "shutdown":
                    _strict_fields(message, frozenset({"type", "id"}))
                    _send(output_stream, {"type": "shutdown", "id": request_id})
                    return 0
                else:
                    raise WorkerError("unsupported_message_type", "message type is not supported")
            except WorkerError as error:
                print(
                    f"[windows-asr-worker] {error.code}",
                    file=error_stream,
                    flush=True,
                )
                _send_error(output_stream, request_id, error.code, error.public_message)
            except Exception as error:
                print(
                    f"[windows-asr-worker] internal_error:{type(error).__name__}",
                    file=error_stream,
                    flush=True,
                )
                _send_error(output_stream, request_id, "internal_error", "request failed")
    finally:
        if runtime is not None:
            runtime.close()
