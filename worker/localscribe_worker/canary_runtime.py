"""Offline Canary-Qwen adapter owned by the existing supervised worker.

Weights stay warm; each chunk's decoder/KV session is freed before the next.
Cancellation uses the worker supervisor's existing process termination path,
which also interrupts a native call. No network APIs or model fallback exist.
"""

from __future__ import annotations

import ctypes
import stat
from collections.abc import Iterator
from pathlib import Path

import numpy as np

from .worker import MODEL_MANIFESTS, TierSpec, TranscriptionResult, WorkerError

REVISION = b"e2f82cb6702315a1194f3bf1a6fee67cd2678447"
LIBRARY_FILENAME = "liblocalscribe-canary.dylib"
SAMPLE_RATE = 16000
CHUNK_SAMPLES = 30 * SAMPLE_RATE
MAX_SAMPLES = 600 * SAMPLE_RATE
MAX_TEXT_BYTES = 400001  # Matches the worker's 100,000-character output ceiling.


def _library_path() -> Path:
    # Fixed app/source-relative paths only. No environment override or loader
    # search path. Main's resource-integrity check covers this exact resource.
    # This module is <root>/worker/localscribe_worker/canary_runtime.py both
    # in the source checkout and in Contents/Resources. Never search ancestors
    # outside that root if a packaged library is missing.
    root = Path(__file__).resolve().parents[2]
    candidates = [root / "native/macos" / LIBRARY_FILENAME,
                  root / "resources/native/macos" / LIBRARY_FILENAME]
    if (root / "worker/pyproject.toml").is_file() and (root / "tools/canary-runtime/pin.json").is_file():
        candidates.append(root / "out/runtime-staging/native/macos" / LIBRARY_FILENAME)
    for candidate in candidates:
        try:
            metadata = candidate.lstat()
        except OSError:
            continue
        if stat.S_ISREG(metadata.st_mode) and candidate.resolve() == candidate:
            return candidate
    raise WorkerError("runtime_unavailable", "The bundled Canary Metal runtime is unavailable")


def _chunks(audio: np.ndarray) -> Iterator[np.ndarray]:
    """Partition without dropped/repeated samples, preferring a quiet boundary.

    Canary is trained on short clips. For long dictations, look for the quietest
    100ms window in the final five seconds of each <=30s chunk. This is offline
    chunking, not streaming; no partial text is published or persisted.
    """
    start = 0
    while start < audio.size:
        end = min(start + CHUNK_SAMPLES, audio.size)
        if end < audio.size:
            window = SAMPLE_RATE // 10
            search_start = end - 5 * SAMPLE_RATE
            windows = audio[search_start:end].reshape(-1, window)
            energies = np.mean(np.square(windows), axis=1)
            end = search_start + int(np.argmin(energies)) * window + window // 2
        yield audio[start:end]
        start = end


class CanaryRuntime:
    def __init__(self, library: ctypes.CDLL, model: ctypes.c_void_p):
        self._library = library
        self._model = model

    @classmethod
    def load(cls, model_directory: Path, spec: TierSpec) -> CanaryRuntime:
        if spec.family_id != "canary-qwen-2-5b" or spec.asr_mode != "after-stop":
            raise WorkerError("invalid_asr_mode", "Canary supports only After I stop")
        manifest = MODEL_MANIFESTS.get((spec.model_id, spec.tier, spec.compute_type))
        if manifest is None or len(manifest.files) != 1:
            raise WorkerError("invalid_model_manifest", "Canary model manifest is invalid")
        model_path = model_directory / next(iter(manifest.files))
        try:
            if model_path.is_symlink() or not stat.S_ISREG(model_path.lstat().st_mode):
                raise OSError("not an ordinary file")
            library = ctypes.CDLL(str(_library_path()))
            library.localscribe_canary_abi.argtypes = []
            library.localscribe_canary_abi.restype = ctypes.c_int
            library.localscribe_canary_revision.argtypes = []
            library.localscribe_canary_revision.restype = ctypes.c_char_p
            if library.localscribe_canary_abi() != 1 or library.localscribe_canary_revision() != REVISION:
                raise WorkerError("runtime_unavailable", "Canary runtime identity does not match this app")
            library.localscribe_canary_load.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
            library.localscribe_canary_load.restype = ctypes.c_int
            library.localscribe_canary_transcribe.argtypes = [
                ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_int,
                ctypes.POINTER(ctypes.c_char), ctypes.c_int,
            ]
            library.localscribe_canary_transcribe.restype = ctypes.c_int
            library.localscribe_canary_free.argtypes = [ctypes.c_void_p]
            library.localscribe_canary_free.restype = None
            model = ctypes.c_void_p()
            result = library.localscribe_canary_load(str(model_path).encode("utf-8"), ctypes.byref(model))
            if result != 0 or not model.value:
                if model.value:
                    library.localscribe_canary_free(model)
                raise WorkerError("model_load_failed", "Canary could not load the selected model on Metal")
            return cls(library, model)
        except (OSError, AttributeError) as error:
            raise WorkerError("runtime_unavailable", "The bundled Canary Metal runtime could not be loaded") from error

    def transcribe(self, pcm16: bytes, *, language: str | None, context: str) -> TranscriptionResult:
        if not self._model.value:
            raise WorkerError("model_not_loaded", "Canary is not loaded")
        if language not in {None, "en"}:
            raise WorkerError("unsupported_language", "Canary supports English only")
        if context:
            raise WorkerError("unsupported_context", "Canary does not support recognition prompts")
        if not pcm16 or len(pcm16) % 2 or len(pcm16) > MAX_SAMPLES * 2:
            raise WorkerError("invalid_audio", "Canary requires at most ten minutes of 16 kHz mono PCM16")
        audio = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
        parts: list[str] = []
        total_chars = 0
        for chunk in _chunks(audio):
            output = ctypes.create_string_buffer(MAX_TEXT_BYTES)
            result = self._library.localscribe_canary_transcribe(
                self._model, chunk.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
                chunk.size, output, len(output),
            )
            if result in {3, 4}:
                raise WorkerError("transcription_failed", "Canary reached its output limit; try a shorter dictation")
            if result != 0:
                raise WorkerError("transcription_failed", "Canary transcription failed")
            try:
                text = output.value.decode("utf-8", errors="strict").strip()
            except UnicodeDecodeError as error:
                raise WorkerError("transcription_failed", "Canary returned invalid text") from error
            if text:
                total_chars += len(text) + bool(parts)
                if total_chars > 100000:
                    raise WorkerError("transcription_failed", "Canary transcript exceeded the output limit")
                parts.append(text)
        return TranscriptionResult(text=" ".join(parts), language="en")

    def release_transient_memory(self) -> None:
        # The bridge's RAII session frees the KV cache on every call, including
        # failures. Do not load MLX just to clear a cache this runtime never used.
        pass

    def close(self) -> None:
        if self._model.value:
            model, self._model = self._model, ctypes.c_void_p()
            self._library.localscribe_canary_free(model)
