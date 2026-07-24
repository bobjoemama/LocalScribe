from __future__ import annotations

import gc
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import time
import uuid
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Callable, Protocol, TextIO

PROTOCOL_VERSION = 1
BACKEND_NAME = "faster-whisper-ctranslate2"
BACKEND_VERSION = "1.2.1"

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

TIER_COMPUTE_TYPES = {
    "high": "float16",
    "medium": "int8_float16",
    "low": "int8",
}

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


class WorkerError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.public_message = message


@dataclass(frozen=True)
class ModelSpec:
    manifest_filename: str
    family_id: str
    artifact_id: str
    model_id: str
    revision: str
    storage_directory: str
    expected_files: frozenset[str]


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


MODEL_SPECS = {
    "Systran/faster-whisper-large-v3": ModelSpec(
        manifest_filename="faster-whisper-large-v3.json",
        family_id="whisper-large-v3",
        artifact_id="whisper-large-v3-ctranslate2",
        model_id="Systran/faster-whisper-large-v3",
        revision="edaa852ec7e145841d8ffdb056a99866b5f0a478",
        storage_directory="faster-whisper-large-v3-edaa852",
        expected_files=frozenset(
            {
                "config.json",
                "model.bin",
                "preprocessor_config.json",
                "tokenizer.json",
                "vocabulary.json",
            }
        ),
    ),
    "Systran/faster-whisper-large-v2": ModelSpec(
        manifest_filename="faster-whisper-large-v2.json",
        family_id="whisper-large-v2",
        artifact_id="whisper-large-v2-ctranslate2",
        model_id="Systran/faster-whisper-large-v2",
        revision="f0fe81560cb8b68660e564f55dd99207059c092e",
        storage_directory="faster-whisper-large-v2-f0fe815",
        expected_files=frozenset(
            {
                "config.json",
                "model.bin",
                "tokenizer.json",
                "vocabulary.txt",
            }
        ),
    ),
}
MANIFEST_FILENAMES = frozenset(spec.manifest_filename for spec in MODEL_SPECS.values())


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


def _load_model_manifest(path: Path, spec: ModelSpec) -> ModelManifest:
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
    if (
        raw.get("familyId") != spec.family_id
        or raw.get("artifactId") != spec.artifact_id
        or raw.get("modelId") != spec.model_id
        or raw.get("revision") != spec.revision
        or raw.get("storageDirectory") != spec.storage_directory
    ):
        raise RuntimeError("packaged_model_manifest_identity_mismatch")
    for field in ("backend", "displayName", "license"):
        if not isinstance(raw.get(field), str) or not raw[field] or len(raw[field]) > 200:
            raise RuntimeError("packaged_model_manifest_invalid")
    files = raw.get("files")
    if not isinstance(files, dict) or frozenset(files) != spec.expected_files:
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
        family_id=raw["familyId"],
        artifact_id=raw["artifactId"],
        model_id=raw["modelId"],
        storage_directory=raw["storageDirectory"],
        revision=raw["revision"],
        license=raw["license"],
        files=parsed_files,
    )


MODEL_MANIFESTS = {
    model_id: _load_model_manifest(_manifest_path(spec.manifest_filename), spec)
    for model_id, spec in MODEL_SPECS.items()
}

# Retained as compatibility aliases for callers that only use the original
# large-v3 default. The request path always selects from MODEL_MANIFESTS.
MODEL_ID = "Systran/faster-whisper-large-v3"
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


class InferenceRuntime(Protocol):
    def transcribe(
        self,
        audio_path: Path,
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


def _validated_tier_compute_type(message: dict[str, Any]) -> tuple[str, str]:
    tier = message.get("tier")
    compute_type = message.get("computeType")
    if not isinstance(tier, str) or tier not in TIER_COMPUTE_TYPES:
        raise WorkerError("invalid_tier", "tier must be high, medium, or low")
    if not isinstance(compute_type, str) or compute_type != TIER_COMPUTE_TYPES[tier]:
        raise WorkerError(
            "invalid_compute_type",
            "computeType does not match the requested tier",
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


def _bounded_absolute_directory(raw_path: str, *, create: bool) -> Path:
    if not raw_path or len(raw_path) > MAX_PATH_CHARS:
        raise WorkerError("invalid_model_root", "modelRoot is invalid")
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        raise WorkerError("invalid_model_root", "modelRoot must be absolute")
    try:
        if create:
            candidate.mkdir(parents=True, exist_ok=True, mode=0o700)
        resolved = candidate.resolve(strict=True)
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
        if not stat.S_ISDIR(directory_metadata.st_mode):
            return False
        entries = {entry.name: entry for entry in model_directory.iterdir()}
        if set(entries) != set(manifest.files):
            return False
        for filename, expected in manifest.files.items():
            candidate = entries[filename]
            metadata = candidate.lstat()
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != expected.bytes:
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
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        path.unlink()
        return
    shutil.rmtree(path)


def _activate_staged_model(staging: Path, final_directory: Path, model_root: Path) -> None:
    if not final_directory.exists() and not final_directory.is_symlink():
        staging.replace(final_directory)
        return

    backup = model_root / f".faster-whisper-replaced-{uuid.uuid4().hex}"
    try:
        final_directory.replace(backup)
        try:
            staging.replace(final_directory)
        except Exception:
            backup.replace(final_directory)
            raise
        _safe_remove_entry(backup, model_root)
    except WorkerError:
        raise
    except OSError as error:
        raise WorkerError("model_activation_failed", "model activation failed") from error


def ensure_model(model_root: Path, manifest: ModelManifest) -> Path:
    model_root = _bounded_absolute_directory(str(model_root), create=True)
    final_directory = model_root / manifest.storage_directory
    if _valid_model_directory(final_directory, manifest):
        return final_directory

    if shutil.disk_usage(model_root).free < MIN_FREE_DISK_BYTES:
        raise WorkerError("insufficient_disk_space", "at least 6 GiB of free disk is required")

    staging = Path(tempfile.mkdtemp(prefix=".faster-whisper-staging-", dir=model_root))
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
        _activate_staged_model(staging, final_directory, model_root)
        if not _valid_model_directory(final_directory, manifest):
            raise WorkerError("model_activation_failed", "activated model verification failed")
        return final_directory
    finally:
        if staging.exists() or staging.is_symlink():
            _safe_remove_entry(staging, model_root)


def validate_audio_path(audio_path_raw: str, allowed_root_raw: str) -> Path:
    if (
        not audio_path_raw
        or not allowed_root_raw
        or len(audio_path_raw) > MAX_PATH_CHARS
        or len(allowed_root_raw) > MAX_PATH_CHARS
    ):
        raise WorkerError("invalid_audio_path", "audio path is invalid")
    try:
        allowed_root = Path(allowed_root_raw).resolve(strict=True)
        audio_path = Path(audio_path_raw).resolve(strict=True)
    except OSError as error:
        raise WorkerError("invalid_audio_path", "audio file is unavailable") from error
    if not allowed_root.is_dir() or not _is_within(audio_path, allowed_root):
        raise WorkerError("audio_path_not_allowed", "audio file is outside the allowed root")
    if not audio_path.is_file() or audio_path.suffix.lower() != ".wav":
        raise WorkerError("invalid_audio_file", "audio must be a WAV file")
    size = audio_path.stat().st_size
    if size <= WAV_HEADER_BYTES or size > MAX_AUDIO_BYTES:
        raise WorkerError("invalid_audio_file", "audio file size is invalid")
    try:
        with wave.open(str(audio_path), "rb") as wav:
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
    return audio_path


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


def query_device_info() -> DeviceInfo:
    try:
        import pynvml
    except Exception as error:
        raise WorkerError("cuda_unavailable", "NVIDIA device telemetry is unavailable") from error

    initialized = False
    try:
        pynvml.nvmlInit()
        initialized = True
        if pynvml.nvmlDeviceGetCount() < 1:
            raise WorkerError("cuda_unavailable", "an NVIDIA CUDA GPU is required")
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        raw_name = pynvml.nvmlDeviceGetName(handle)
        name = raw_name.decode("utf-8", errors="replace") if isinstance(raw_name, bytes) else raw_name
        memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
        total_bytes = int(memory.total)
        free_bytes = int(memory.free)
        if (
            not isinstance(name, str)
            or not name.strip()
            or len(name) > 256
            or total_bytes <= 0
            or free_bytes < 0
            or free_bytes > total_bytes
        ):
            raise WorkerError("device_info_invalid", "NVIDIA device telemetry is invalid")
        return DeviceInfo(name.strip(), total_bytes, free_bytes)
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
    ) -> "FasterWhisperRuntime":
        if compute_type not in TIER_COMPUTE_TYPES.values():
            raise WorkerError("invalid_compute_type", "compute type is not allowed")
        if not _valid_model_directory(model_directory, manifest):
            raise WorkerError("model_checksum_failed", "local model verification failed")

        _configure_windows_cuda_dlls()
        try:
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
            supported_types = set(ctranslate2.get_supported_compute_types("cuda", 0))
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
                device_index=0,
                compute_type=compute_type,
                local_files_only=True,
            )
        except Exception as error:
            raise WorkerError(
                "model_load_failed",
                "faster-whisper could not load the model with CUDA 12 and cuDNN 9",
            ) from error
        return cls(model, np, compute_type)

    def _read_pcm16(self, audio_path: Path) -> Any:
        try:
            with wave.open(str(audio_path), "rb") as wav:
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
        audio_path: Path,
        *,
        language: str | None,
        context: str,
    ) -> TranscriptionResult:
        if self._closed or self._model is None:
            raise WorkerError("model_not_loaded", "ASR model is not loaded")
        pcm = self._read_pcm16(audio_path)
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
    runtime_factory: RuntimeFactory = FasterWhisperRuntime.load,
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

                if message_type == "load_model":
                    _strict_fields(
                        message,
                        frozenset(
                            {
                                "type",
                                "id",
                                "modelId",
                                "tier",
                                "computeType",
                                "modelRoot",
                                "allowDownload",
                            }
                        ),
                    )
                    if platform_name != "win32":
                        raise WorkerError(
                            "windows_only",
                            "faster-whisper CUDA worker requires Windows",
                        )
                    model_id = _string_field(message, "modelId", max_chars=200)
                    manifest = MODEL_MANIFESTS.get(model_id)
                    if manifest is None:
                        raise WorkerError("model_not_allowed", "requested model is not allowed")
                    tier, compute_type = _validated_tier_compute_type(message)
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
                    model_root = _bounded_absolute_directory(model_root_raw, create=True)
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
                    if not allow_download and not _valid_model_directory(
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
                    audio_path = validate_audio_path(audio_path_raw, allowed_root_raw)
                    context = message.get("context")
                    if not isinstance(context, str) or len(context) > MAX_CONTEXT_CHARS:
                        raise WorkerError("invalid_context", "context must be at most 4000 characters")
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
                        audio_path,
                        language=language,
                        context=context,
                    )
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
