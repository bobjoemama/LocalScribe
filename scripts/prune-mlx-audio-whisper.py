"""Remove the unsupported Whisper backend from the pinned generated runtime.

mlx-audio 0.4.6 eagerly imports its backends. Patch only that import before
removing the corresponding subtree, and reconcile its wheel RECORD. Qwen's
Transformers WhisperFeatureExtractor and all upstream notices remain intact.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import shutil
from email.parser import Parser
from pathlib import Path

MLX_AUDIO_VERSION = "0.4.6"
UPSTREAM_INIT_SHA256 = "db39aa6e797032da6003b69aa7d18be9fdc14215727bbac7be378765ae9cf6c9"
PATCHED_INIT_SHA256 = "df8a5588ea2f2ee13ac86274973a5ed9b3de75c928169f900fac8aa03178e772"
INIT_PATH = "mlx_audio/stt/models/__init__.py"
WHISPER_PATH = "mlx_audio/stt/models/whisper"
WHISPER_IMPORT = b"    whisper,\n"


def verify_pruned_whisper(site_packages: Path) -> dict[str, object]:
    """Read-only verification of the exact pinned post-pruning runtime."""
    site_packages = site_packages.resolve(strict=True)
    dist_info = site_packages / f"mlx_audio-{MLX_AUDIO_VERSION}.dist-info"
    for relative in (
        "mlx_audio", "mlx_audio/stt", "mlx_audio/stt/models", INIT_PATH,
        dist_info.name, f"{dist_info.name}/METADATA",
        f"{dist_info.name}/localscribe-pruning.json", f"{dist_info.name}/RECORD",
    ):
        target = site_packages / relative
        if target.is_symlink() or not target.exists():
            raise ValueError(f"Expected an ordinary pruned runtime path: {relative}")
    metadata = Parser().parsestr((dist_info / "METADATA").read_text(encoding="utf-8"))
    if metadata["Name"] != "mlx-audio" or metadata["Version"] != MLX_AUDIO_VERSION:
        raise ValueError("Pinned mlx-audio distribution version does not match")
    expected = {
        "version": MLX_AUDIO_VERSION,
        "originalSha256": UPSTREAM_INIT_SHA256,
        "patchedSha256": PATCHED_INIT_SHA256,
        "removedPaths": [WHISPER_PATH],
    }
    marker_path = dist_info / "localscribe-pruning.json"
    marker_source = marker_path.read_bytes()
    marker = json.loads(marker_source)
    if marker != expected:
        raise ValueError("mlx-audio pruning marker does not match the pinned transformation")
    initializer_source = (site_packages / INIT_PATH).read_bytes()
    if hashlib.sha256(initializer_source).hexdigest() != PATCHED_INIT_SHA256:
        raise ValueError("Pruned mlx-audio backend initializer hash does not match")
    backend = site_packages / WHISPER_PATH
    if backend.exists() or backend.is_symlink():
        raise ValueError("Retired mlx-audio Whisper backend remains in the runtime")
    record = dist_info / "RECORD"
    if not record.is_file():
        raise ValueError("Pruned mlx-audio RECORD is not an ordinary file")
    try:
        rows = list(csv.reader(io.StringIO(record.read_text(encoding="utf-8")), strict=True))
    except csv.Error as error:
        raise ValueError("Pruned mlx-audio RECORD is malformed") from error
    if any(len(row) != 3 for row in rows):
        raise ValueError("Pruned mlx-audio RECORD is malformed")
    if any(row[0] == WHISPER_PATH or row[0].startswith(f"{WHISPER_PATH}/") for row in rows):
        raise ValueError("Pruned mlx-audio RECORD still lists the retired backend")
    # Other rows can legitimately change during ordinary runtime pruning and
    # native signing. Bind only this transformation's initializer and marker.
    for relative, contents in (
        (INIT_PATH, initializer_source),
        (marker_path.relative_to(site_packages).as_posix(), marker_source),
    ):
        matching = [row for row in rows if row[0] == relative]
        digest = base64.urlsafe_b64encode(hashlib.sha256(contents).digest()).decode().rstrip("=")
        if matching != [[relative, f"sha256={digest}", str(len(contents))]]:
            raise ValueError(f"Pruned mlx-audio RECORD does not bind exactly one {relative}")
    return expected


def prune_whisper(site_packages: Path) -> None:
    site_packages = site_packages.resolve(strict=True)
    dist_info = site_packages / f"mlx_audio-{MLX_AUDIO_VERSION}.dist-info"
    initializer = site_packages / INIT_PATH
    backend = site_packages / WHISPER_PATH
    metadata = dist_info / "METADATA"
    record = dist_info / "RECORD"
    marker = dist_info / "localscribe-pruning.json"
    if marker.exists() or marker.is_symlink():
        raise ValueError("mlx-audio pruning marker already exists")
    for relative in (
        "mlx_audio", "mlx_audio/stt", "mlx_audio/stt/models", WHISPER_PATH,
        dist_info.name, f"{dist_info.name}/METADATA", f"{dist_info.name}/RECORD", INIT_PATH,
    ):
        target = site_packages / relative
        if target.is_symlink() or not target.exists():
            raise ValueError(f"Expected an ordinary pinned runtime path: {relative}")
    if not backend.is_dir() or not all(p.is_file() for p in (initializer, metadata, record)):
        raise ValueError("Pinned mlx-audio runtime layout does not match")
    package_metadata = Parser().parsestr(metadata.read_text(encoding="utf-8"))
    if (
        package_metadata["Name"] != "mlx-audio"
        or package_metadata["Version"] != MLX_AUDIO_VERSION
    ):
        raise ValueError("Pinned mlx-audio distribution version does not match")
    source = initializer.read_bytes()
    if hashlib.sha256(source).hexdigest() != UPSTREAM_INIT_SHA256:
        raise ValueError("Pinned mlx-audio backend initializer hash does not match")
    if source.count(WHISPER_IMPORT) != 1:
        raise ValueError("Expected exactly one pinned Whisper backend import")
    patched_source = source.replace(WHISPER_IMPORT, b"")
    if hashlib.sha256(patched_source).hexdigest() != PATCHED_INIT_SHA256:
        raise ValueError("Pinned mlx-audio transformation output does not match")
    rows = list(csv.reader(io.StringIO(record.read_text(encoding="utf-8"))))
    if any(len(row) != 3 for row in rows):
        raise ValueError("Pinned mlx-audio RECORD is malformed")
    if sum(row[0] == INIT_PATH for row in rows) != 1:
        raise ValueError("Pinned mlx-audio RECORD must contain exactly one initializer")
    if not any(row[0].startswith(f"{WHISPER_PATH}/") for row in rows):
        raise ValueError("Pinned mlx-audio RECORD does not contain the retired backend")
    patched_digest = base64.urlsafe_b64encode(hashlib.sha256(patched_source).digest())
    marker_source = (json.dumps(
        {
            "version": MLX_AUDIO_VERSION,
            "originalSha256": UPSTREAM_INIT_SHA256,
            "patchedSha256": hashlib.sha256(patched_source).hexdigest(),
            "removedPaths": [WHISPER_PATH],
        },
        sort_keys=True,
        indent=2,
    ) + "\n").encode("utf-8")
    marker_digest = base64.urlsafe_b64encode(hashlib.sha256(marker_source).digest())
    patched_record = io.StringIO(newline="")
    writer = csv.writer(patched_record, lineterminator="\n")
    for row in rows:
        if row[0].startswith(f"{WHISPER_PATH}/"):
            continue
        if row[0] == INIT_PATH:
            row = [INIT_PATH, f"sha256={patched_digest.decode().rstrip('=')}", str(len(patched_source))]
        writer.writerow(row)
    writer.writerow([
        marker.relative_to(site_packages).as_posix(),
        f"sha256={marker_digest.decode().rstrip('=')}",
        str(len(marker_source)),
    ])

    # All identity and record checks complete before changing generated output.
    initializer.write_bytes(patched_source)
    shutil.rmtree(backend)
    marker.write_bytes(marker_source)
    record.write_text(patched_record.getvalue(), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="Verify a pruned runtime without writes")
    parser.add_argument("site_packages", type=Path)
    args = parser.parse_args()
    if args.verify:
        verify_pruned_whisper(args.site_packages)
        print(f"Verified pruned mlx-audio {MLX_AUDIO_VERSION} runtime")
    else:
        prune_whisper(args.site_packages)
        print(f"Removed unsupported mlx-audio {MLX_AUDIO_VERSION} Whisper backend")


if __name__ == "__main__":
    main()
