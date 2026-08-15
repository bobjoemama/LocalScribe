#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import uuid
import wave
from pathlib import Path

MACOS_FAMILY_TIER_MANIFESTS = {
    "parakeet-unified-en-0-6b": {
        "high": ("parakeet-unified-en-0-6b-coreml-fp16.json", "coreml-fp16"),
        "medium": ("parakeet-unified-en-0-6b-coreml-int8.json", "coreml-int8"),
    },
    "whisper-large-v3": {
        "high": ("whisper-large-v3-mlx.json", "float16"),
        "medium": ("whisper-large-v3-mlx-8bit.json", "int8"),
        "low": ("whisper-large-v3-mlx-4bit.json", "int4"),
    },
    "whisper-large-v2": {
        "high": ("whisper-large-v2-mlx.json", "float16"),
        "medium": ("whisper-large-v2-mlx-8bit.json", "int8"),
        "low": ("whisper-large-v2-mlx-4bit.json", "int4"),
    },
    "qwen3-asr-1-7b": {
        "high": ("qwen3-asr-1-7b-mlx-bf16.json", "bfloat16"),
        "medium": ("qwen3-asr-1-7b-mlx-8bit.json", "int8"),
        "low": ("qwen3-asr-1-7b-mlx-4bit.json", "int4"),
    },
    "qwen3-asr-0-6b": {
        "high": ("qwen3-asr-0-6b-mlx-bf16.json", "bfloat16"),
        "medium": ("qwen3-asr-0-6b-mlx-8bit.json", "int8"),
        "low": ("qwen3-asr-0-6b-mlx-4bit.json", "int4"),
    },
}


def load_model_id(manifest_path: Path, family_id: str) -> str:
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"could not read model manifest: {manifest_path}") from error
    model_id = raw.get("modelId") if isinstance(raw, dict) else None
    platform = raw.get("platform") if isinstance(raw, dict) else None
    manifest_family_id = raw.get("familyId") if isinstance(raw, dict) else None
    if (
        platform != "darwin-arm64"
        or manifest_family_id != family_id
        or not isinstance(model_id, str)
        or not model_id
    ):
        raise RuntimeError(f"invalid macOS model manifest: {manifest_path}")
    return model_id


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True)
    parser.add_argument("--worker", required=True)
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument(
        "--family",
        choices=tuple(MACOS_FAMILY_TIER_MANIFESTS),
        default="whisper-large-v3",
        help="Curated local ASR family to smoke; Whisper large-v3 is the default.",
    )
    parser.add_argument("--tier", choices=("high", "medium", "low"), default="medium")
    parser.add_argument(
        "--mode",
        choices=("after-stop", "live"),
        default="after-stop",
        help="Exercise final-WAV or true incremental inference. Live is currently Parakeet-only.",
    )
    parser.add_argument(
        "--repeat",
        type=int,
        default=1,
        help="Transcribe the same fixture repeatedly in one worker process to prove warm reuse.",
    )
    parser.add_argument(
        "--allow-download",
        action="store_true",
        help="Explicitly permit downloading the pinned tier before the smoke test.",
    )
    args = parser.parse_args()
    if args.repeat < 1 or args.repeat > 20:
        parser.error("--repeat must be between 1 and 20")
    family_tiers = MACOS_FAMILY_TIER_MANIFESTS[args.family]
    if args.tier not in family_tiers:
        parser.error(f"{args.family} has no {args.tier} profile")
    if args.mode == "live" and args.family != "parakeet-unified-en-0-6b":
        parser.error("--mode live requires parakeet-unified-en-0-6b")
    # Preserve the venv launcher path. Resolving its symlink would bypass the
    # venv and make the packaged runtime's site-packages unavailable.
    python_executable = Path(os.path.abspath(args.python))
    if not python_executable.is_file():
        raise RuntimeError(f"packaged Python executable not found: {python_executable}")
    worker_directory = Path(args.worker).resolve(strict=True)
    model_root = Path(args.model_root).resolve(strict=True)
    audio_path = Path(args.audio).resolve(strict=True)
    manifest_filename, compute_type = family_tiers[args.tier]
    manifest_path = (
        Path(__file__).resolve().parents[1]
        / "resources"
        / "model-manifest"
        / manifest_filename
    )
    model_id = load_model_id(manifest_path, args.family)

    environment = {
        "HOME": str(Path.home()),
        "PATH": os.environ.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin"),
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
        "PYTHONPATH": str(worker_directory),
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
    }
    process = subprocess.Popen(
        [str(python_executable), "-B", "-m", "localscribe_worker"],
        cwd=worker_directory,
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdin and process.stdout and process.stderr

    def receive() -> dict[str, object]:
        line = process.stdout.readline()
        if not line:
            raise RuntimeError(process.stderr.read() or "worker exited without a response")
        return json.loads(line)

    def request(payload: dict[str, object]) -> dict[str, object]:
        payload["id"] = str(uuid.uuid4())
        process.stdin.write(json.dumps(payload) + "\n")
        process.stdin.flush()
        response = receive()
        if response.get("type") == "error":
            raise RuntimeError(str(response))
        return response

    hello = receive()
    installed = None
    if args.allow_download:
        installed = request({
            "type": "install_model",
            "tier": args.tier,
            "modelId": model_id,
            "computeType": compute_type,
            "modelRoot": str(model_root),
            "allowDownload": True,
        })
    ready = request({
        "type": "load_model",
        "tier": args.tier,
        "modelId": model_id,
        "computeType": compute_type,
        "modelRoot": str(model_root),
        "asrMode": args.mode,
        "allowDownload": False,
    })
    if args.mode == "after-stop":
        finals = [
            request({
                "type": "transcribe",
                "audioPath": str(audio_path),
                "allowedRoot": str(audio_path.parent),
                "language": "English",
                "context": "" if args.family == "parakeet-unified-en-0-6b" else "LocalScribe",
            })
            for _ in range(args.repeat)
        ]
        partials: list[dict[str, object]] = []
    else:
        with wave.open(str(audio_path), "rb") as wav:
            if (
                wav.getnchannels() != 1
                or wav.getsampwidth() != 2
                or wav.getframerate() != 16_000
                or wav.getcomptype() != "NONE"
            ):
                raise RuntimeError("live smoke audio must be mono 16 kHz PCM16 WAV")
            pcm16 = wav.readframes(wav.getnframes())
        finals = []
        partials = []
        for _ in range(args.repeat):
            request({"type": "begin_live", "language": "English", "context": ""})
            session_partials = []
            for offset in range(0, len(pcm16), 8 * 1024):
                chunk = pcm16[offset : offset + 8 * 1024]
                if not chunk:
                    continue
                session_partials.append(request({
                    "type": "append_live",
                    "audioBase64": base64.b64encode(chunk).decode("ascii"),
                }))
            partials.extend(session_partials)
            finals.append(request({"type": "finish_live"}))
    request({"type": "shutdown"})
    process.wait(timeout=5)
    print(json.dumps(
        {
            "hello": hello,
            "installed": installed,
            "ready": ready,
            "mode": args.mode,
            "final": finals[0],
            "finals": finals,
            "partialCount": len(partials),
            "lastPartial": partials[-1] if partials else None,
        },
        ensure_ascii=False,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
