#!/usr/bin/env python3
"""Bind uv's locked Python graph to the packages and wheels in a candidate app."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import tomllib
from email.parser import BytesParser
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from packaging.tags import sys_tags
from packaging.utils import canonicalize_name, parse_wheel_filename


def fail(message: str) -> RuntimeError:
    return RuntimeError(f"Python SBOM reconciliation failed: {message}")


def require_within(path: Path, root: Path, label: str) -> Path:
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(root) or not resolved.is_dir():
        raise fail(f"{label} is not a directory inside the candidate app")
    return resolved


def installed_distributions(site_packages: Path) -> dict[str, tuple[str, str]]:
    installed: dict[str, tuple[str, str]] = {}
    for dist_info in sorted(site_packages.glob("*.dist-info")):
        metadata_path = dist_info / "METADATA"
        if not metadata_path.is_file() or metadata_path.is_symlink():
            raise fail(f"{dist_info.name} has no ordinary METADATA file")
        metadata = BytesParser().parsebytes(metadata_path.read_bytes(), headersonly=True)
        name = metadata.get("Name")
        version = metadata.get("Version")
        if not name or not version:
            raise fail(f"{dist_info.name} has incomplete package identity")
        canonical = canonicalize_name(name)
        if canonical in installed:
            raise fail(f"candidate contains duplicate distribution {canonical}")
        installed[canonical] = (name, version)
    if not installed:
        raise fail("candidate contains no installed Python distributions")
    return installed


def selected_wheel(package: dict[str, Any], supported_tags: dict[Any, int]) -> dict[str, str]:
    compatible: list[tuple[int, dict[str, str]]] = []
    for wheel in package.get("wheels", []):
        url = wheel.get("url")
        archive_hash = wheel.get("hash")
        if not isinstance(url, str) or not isinstance(archive_hash, str):
            raise fail(f"lock entry for {package.get('name')} has malformed wheel metadata")
        filename = Path(unquote(urlparse(url).path)).name
        try:
            _, _, _, wheel_tags = parse_wheel_filename(filename)
        except Exception as error:  # packaging reports several precise parse errors
            raise fail(f"lock entry has invalid wheel filename {filename}") from error
        ranks = [supported_tags[tag] for tag in wheel_tags if tag in supported_tags]
        if ranks:
            compatible.append((min(ranks), {"url": url, "hash": archive_hash, "file": filename}))
    if not compatible:
        raise fail(f"lock has no compatible wheel for {package.get('name')} {package.get('version')}")
    compatible.sort(key=lambda item: (item[0], item[1]["file"]))
    return compatible[0][1]


def reconcile(
    bom: dict[str, Any],
    lock: dict[str, Any],
    installed: dict[str, tuple[str, str]],
) -> dict[str, Any]:
    components = bom.get("components")
    metadata_component = bom.get("metadata", {}).get("component")
    dependencies = bom.get("dependencies")
    if not isinstance(components, list) or not isinstance(metadata_component, dict) or not isinstance(dependencies, list):
        raise fail("input is not a complete CycloneDX graph")

    component_by_name: dict[str, dict[str, Any]] = {}
    for component in components:
        if not isinstance(component, dict) or not isinstance(component.get("name"), str):
            raise fail("input contains a component without a package name")
        canonical = canonicalize_name(component["name"])
        if canonical in component_by_name:
            raise fail(f"input contains duplicate component {canonical}")
        component_by_name[canonical] = component
    root_name = canonicalize_name(str(metadata_component.get("name", "")))
    root_ref = metadata_component.get("bom-ref")
    if not root_name or not isinstance(root_ref, str):
        raise fail("input has no stable root component")

    lock_by_name: dict[str, dict[str, Any]] = {}
    for package in lock.get("package", []):
        if not isinstance(package, dict) or not isinstance(package.get("name"), str):
            raise fail("uv lock contains malformed package metadata")
        canonical = canonicalize_name(package["name"])
        if canonical in lock_by_name:
            raise fail(f"uv lock contains duplicate package {canonical}")
        lock_by_name[canonical] = package

    if root_name not in installed:
        raise fail(f"candidate does not contain the root distribution {root_name}")
    root_installed_version = installed[root_name][1]
    if metadata_component.get("version") != root_installed_version:
        raise fail("candidate root distribution version does not match the SBOM")

    supported_tags = {tag: index for index, tag in enumerate(sys_tags())}
    retained: list[dict[str, Any]] = []
    for canonical, (_display_name, installed_version) in sorted(installed.items()):
        if canonical == root_name:
            continue
        component = component_by_name.get(canonical)
        package = lock_by_name.get(canonical)
        if component is None or package is None:
            raise fail(f"installed distribution {canonical} is absent from the SBOM or lock")
        if component.get("version") != installed_version or package.get("version") != installed_version:
            raise fail(f"version mismatch for installed distribution {canonical}")
        wheel = selected_wheel(package, supported_tags)
        algorithm, separator, content = wheel["hash"].partition(":")
        if separator != ":" or algorithm != "sha256" or len(content) != 64:
            raise fail(f"selected wheel for {canonical} has no SHA-256 lock digest")
        component["hashes"] = [{"alg": "SHA-256", "content": content}]
        component["externalReferences"] = [
            {"type": "distribution", "url": wheel["url"], "hashes": component["hashes"]}
        ]
        component["properties"] = sorted(
            [
                *(component.get("properties") if isinstance(component.get("properties"), list) else []),
                {"name": "com.localscribe.selected-wheel", "value": wheel["file"]},
                {"name": "com.localscribe.inventory-source", "value": "packaged-dist-info"},
            ],
            key=lambda entry: (str(entry.get("name")), str(entry.get("value"))),
        )
        retained.append(component)

    retained_refs = {root_ref, *(component.get("bom-ref") for component in retained)}
    if None in retained_refs:
        raise fail("retained component has no stable reference")
    filtered_dependencies = []
    for dependency in dependencies:
        if not isinstance(dependency, dict) or dependency.get("ref") not in retained_refs:
            continue
        depends_on = dependency.get("dependsOn")
        if not isinstance(depends_on, list):
            raise fail("input dependency edge is malformed")
        filtered_dependencies.append(
            {**dependency, "dependsOn": sorted(ref for ref in depends_on if ref in retained_refs)}
        )
    if {dependency["ref"] for dependency in filtered_dependencies} != retained_refs:
        raise fail("input dependency graph does not cover every packaged distribution")

    bom["components"] = sorted(retained, key=lambda component: canonicalize_name(component["name"]))
    bom["dependencies"] = sorted(filtered_dependencies, key=lambda dependency: dependency["ref"])
    bom.pop("serialNumber", None)
    bom["metadata"].pop("timestamp", None)
    bom["metadata"]["properties"] = [
        {"name": "com.localscribe.scope", "value": "exact packaged Python distribution inventory"},
        {"name": "com.localscribe.inventory-count", "value": str(len(installed))},
    ]
    return bom


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", required=True)
    parser.add_argument("--lock", required=True)
    parser.add_argument("--sbom", required=True)
    arguments = parser.parse_args()

    app = Path(arguments.app).resolve(strict=True)
    if app.suffix != ".app" or not app.is_dir():
        raise fail("candidate is not a macOS application bundle")
    resources = require_within(app / "Contents" / "Resources", app, "Resources")
    site_package_roots = list((resources / "python-runtime" / "venv" / "lib").glob("python*/site-packages"))
    if len(site_package_roots) != 1:
        raise fail("candidate must contain exactly one Python site-packages directory")
    site_packages = require_within(site_package_roots[0], resources, "site-packages")
    bom = json.loads(Path(arguments.sbom).read_text(encoding="utf-8"))
    lock = tomllib.loads(Path(arguments.lock).read_text(encoding="utf-8"))
    reconciled = reconcile(bom, lock, installed_distributions(site_packages))
    # The selected-wheel digest identifies the upstream input, not our pruned
    # tree. Verify and disclose the deterministic build-time modification.
    pruning_spec = importlib.util.spec_from_file_location(
        "localscribe_mlx_pruning", Path(__file__).with_name("prune-mlx-audio-whisper.py")
    )
    if pruning_spec is None or pruning_spec.loader is None:
        raise fail("MLX Audio pruning verifier is unavailable")
    pruning = importlib.util.module_from_spec(pruning_spec)
    pruning_spec.loader.exec_module(pruning)
    marker = pruning.verify_pruned_whisper(site_packages)
    component = next(
        (entry for entry in reconciled["components"] if entry["name"] == "mlx-audio"), None
    )
    if component is None:
        raise fail("MLX Audio is missing from the candidate inventory")
    component["properties"].extend([
        {"name": "com.localscribe.build-modification", "value": "Unsupported Whisper backend removed by scripts/prune-mlx-audio-whisper.py"},
        {"name": "com.localscribe.original-initializer-sha256", "value": marker["originalSha256"]},
        {"name": "com.localscribe.patched-initializer-sha256", "value": marker["patchedSha256"]},
    ])
    component["properties"].sort(key=lambda entry: (entry["name"], entry["value"]))
    json.dump(reconciled, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
