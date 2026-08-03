from __future__ import annotations

import argparse
import json
import platform
import sys
import tempfile
import wave
from importlib.metadata import version
from pathlib import Path

FAMILY_MODEL_IDS = {
    "whisper-large-v3": "Systran/faster-whisper-large-v3",
    "whisper-large-v2": "Systran/faster-whisper-large-v2",
    "qwen3-asr-0-6b": "cstr/qwen3-asr-0.6b-GGUF",
    "qwen3-asr-1-7b": "cstr/qwen3-asr-1.7b-GGUF",
}


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
    parser.add_argument(
        "--family",
        choices=tuple(FAMILY_MODEL_IDS),
        default="whisper-large-v3",
        help="Curated family to load when --model-root is supplied.",
    )
    parser.add_argument(
        "--tier",
        choices=("high", "medium", "low"),
        default="medium",
        help="Curated performance tier to load when --model-root is supplied.",
    )
    parser.add_argument("--audio", type=Path, help="optional 16 kHz mono PCM16 WAV fixture")
    parser.add_argument(
        "--repeat",
        type=int,
        default=1,
        choices=range(1, 21),
        metavar="1..20",
        help="repeat inference in one loaded runtime to prove warm reuse",
    )
    return parser.parse_args()


def _smoke_model(
    worker_module: object,
    model_root: Path,
    family: str,
    tier: str,
    audio_path: Path | None,
    repeat: int,
) -> dict[str, object]:
    model_id = FAMILY_MODEL_IDS[family]
    compute_types = (
        worker_module.QWEN_TIER_COMPUTE_TYPES
        if model_id in worker_module.QWEN_MODEL_IDS
        else worker_module.WHISPER_TIER_COMPUTE_TYPES
    )
    compute_type = compute_types[tier]
    manifest = worker_module.MODEL_PROFILES[(model_id, tier, compute_type)]
    model_directory = model_root.resolve() / manifest.storage_directory
    if model_id in worker_module.QWEN_MODEL_IDS:
        runtime = worker_module.CrispASRRuntime.load(
            model_directory,
            compute_type,
            manifest,
        )
    else:
        runtime = worker_module.FasterWhisperRuntime.load(
            model_directory,
            compute_type,
            manifest,
        )
    try:
        with tempfile.TemporaryDirectory(prefix="localscribe-cuda-smoke-") as temporary:
            temporary_path = Path(temporary)
            fixture = audio_path.resolve(strict=True) if audio_path else temporary_path / "silence.wav"
            if audio_path is None:
                with wave.open(str(fixture), "wb") as wav:
                    wav.setnchannels(worker_module.REQUIRED_CHANNELS)
                    wav.setsampwidth(worker_module.REQUIRED_SAMPLE_WIDTH_BYTES)
                    wav.setframerate(worker_module.REQUIRED_SAMPLE_RATE)
                    wav.writeframes(b"\x00\x00" * worker_module.REQUIRED_SAMPLE_RATE)
            # validate_audio_path confines reads to the supplied session root.
            # Copying arbitrary fixtures is unnecessary: use their parent as the
            # explicit root for this local verification command.
            audio = worker_module.validate_audio_path(str(fixture), str(fixture.parent))
            results = [runtime.transcribe(audio, language="en", context="") for _ in range(repeat)]
    finally:
        runtime.close()
    return {
        "family": family,
        "tier": tier,
        "computeType": compute_type,
        "modelDirectory": str(model_directory),
        "repeat": repeat,
        "resultCharacters": [len(result.text) for result in results],
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
    required_compute_types = set(worker_module.WHISPER_TIER_COMPUTE_TYPES.values())
    missing_compute_types = sorted(required_compute_types.difference(supported_compute_types))
    if missing_compute_types:
        raise RuntimeError(
            "CUDA device does not support every LocalScribe tier: "
            + ", ".join(missing_compute_types)
        )

    device = worker_module.query_device_info()
    model_smoke = (
        _smoke_model(
            worker_module,
            arguments.model_root,
            arguments.family,
            arguments.tier,
            arguments.audio,
            arguments.repeat,
        )
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
