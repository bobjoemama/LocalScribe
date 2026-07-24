from __future__ import annotations

import argparse
import json
import platform
import sys
import tempfile
import wave
from importlib.metadata import version
from pathlib import Path


def _exact_version(distribution: str, expected: str, label: str) -> str:
    actual = version(distribution)
    if actual != expected:
        raise RuntimeError(f"{label} version mismatch: expected {expected}, received {actual!r}")
    return actual


def _parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate LocalScribe's Windows CUDA runtime")
    parser.add_argument(
        "--model-root",
        type=Path,
        help=(
            "optional existing LocalScribe model root; when supplied, verify and load the "
            "pinned large-v3 model and run one second of silent inference"
        ),
    )
    return parser.parse_args()


def _smoke_model(worker_module: object, model_root: Path) -> dict[str, object]:
    manifest = worker_module.MODEL_MANIFESTS[worker_module.MODEL_ID]
    model_directory = model_root.resolve() / manifest.storage_directory
    runtime = worker_module.FasterWhisperRuntime.load(
        model_directory,
        "int8_float16",
        manifest,
    )
    try:
        with tempfile.TemporaryDirectory(prefix="localscribe-cuda-smoke-") as temporary:
            audio_path = Path(temporary) / "silence.wav"
            with wave.open(str(audio_path), "wb") as wav:
                wav.setnchannels(worker_module.REQUIRED_CHANNELS)
                wav.setsampwidth(worker_module.REQUIRED_SAMPLE_WIDTH_BYTES)
                wav.setframerate(worker_module.REQUIRED_SAMPLE_RATE)
                wav.writeframes(b"\x00\x00" * worker_module.REQUIRED_SAMPLE_RATE)
            audio = worker_module.validate_audio_path(str(audio_path), temporary)
            result = runtime.transcribe(audio, language="en", context="")
    finally:
        runtime.close()
    return {
        "computeType": "int8_float16",
        "modelDirectory": str(model_directory),
        "resultCharacters": len(result.text),
    }


def main() -> int:
    arguments = _parse_arguments()
    if sys.platform != "win32" or platform.machine().casefold() not in {"amd64", "x86_64"}:
        raise RuntimeError("CUDA smoke requires Windows x64")

    from localscribe_windows_worker import worker as worker_module

    worker_module._configure_windows_cuda_dlls()

    import ctranslate2

    versions = {
        "ctranslate2": _exact_version("ctranslate2", "4.8.1", "CTranslate2"),
        "fasterWhisper": _exact_version("faster-whisper", "1.2.1", "faster-whisper"),
        "numpy": _exact_version("numpy", "2.5.1", "NumPy"),
        "pynvml": _exact_version("nvidia-ml-py", "13.610.43", "nvidia-ml-py"),
    }

    cuda_devices = int(ctranslate2.get_cuda_device_count())
    if cuda_devices < 1:
        raise RuntimeError("CTranslate2 did not detect an NVIDIA CUDA device")
    supported_compute_types = sorted(
        str(value) for value in ctranslate2.get_supported_compute_types("cuda", 0)
    )
    required_compute_types = set(worker_module.TIER_COMPUTE_TYPES.values())
    missing_compute_types = sorted(required_compute_types.difference(supported_compute_types))
    if missing_compute_types:
        raise RuntimeError(
            "CUDA device does not support every LocalScribe tier: "
            + ", ".join(missing_compute_types)
        )

    device = worker_module.query_device_info()
    model_smoke = (
        _smoke_model(worker_module, arguments.model_root)
        if arguments.model_root is not None
        else None
    )
    print(
        json.dumps(
            {
                "platform": "win32",
                "architecture": "x64",
                "cudaDevices": cuda_devices,
                "deviceName": device.device_name,
                "totalVramBytes": device.total_vram_bytes,
                "freeVramBytes": device.free_vram_bytes,
                "supportedComputeTypes": supported_compute_types,
                "versions": versions,
                "modelSmoke": model_smoke,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
