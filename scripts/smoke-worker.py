#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path


MACOS_FAMILY_TIER_MANIFESTS = {
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
        help="Curated MLX Whisper family to smoke; large-v3 is the default.",
    )
    parser.add_argument("--tier", choices=("high", "medium", "low"), default="medium")
    parser.add_argument(
        "--allow-download",
        action="store_true",
        help="Explicitly permit downloading the pinned tier before the smoke test.",
    )
    args = parser.parse_args()
    manifest_filename, compute_type = MACOS_FAMILY_TIER_MANIFESTS[args.family][args.tier]
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
        "PYTHONPATH": args.worker,
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
    }
    process = subprocess.Popen(
        [args.python, "-B", "-m", "localscribe_worker"],
        cwd=args.worker,
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
    ready = request({
        "type": "load_model",
        "tier": args.tier,
        "modelId": model_id,
        "computeType": compute_type,
        "modelRoot": args.model_root,
        "allowDownload": args.allow_download,
    })
    final = request({
        "type": "transcribe",
        "audioPath": args.audio,
        "allowedRoot": os.path.dirname(args.audio),
        "language": "English",
        "context": "LocalScribe",
    })
    request({"type": "shutdown"})
    process.wait(timeout=5)
    print(json.dumps({"hello": hello, "ready": ready, "final": final}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
