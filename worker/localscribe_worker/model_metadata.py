"""Dependency-free model-directory metadata policy shared by worker tests."""

from __future__ import annotations

from pathlib import PurePosixPath


def is_inert_model_metadata(
    relative: PurePosixPath,
    expected_names: frozenset[str],
) -> bool:
    """Return whether *relative* is harmless metadata next to a declared file.

    Finder writes ``.DS_Store`` and ``.localized`` files, while copies through
    some filesystems leave AppleDouble ``._name`` sidecars.  The exemption is
    deliberately narrow: a sidecar is inert only when its sibling is declared
    by the curated manifest.  The caller remains responsible for rejecting
    directories and symbolic links wearing these names.

    Keep this policy in step with ``isInertDirectoryMetadata`` in
    ``src/main/modelSpec.ts``.  The cross-language source test executes this
    module without importing the worker's ML runtime dependencies.
    """
    name = relative.name
    if name in (".DS_Store", ".localized"):
        return True
    if not name.startswith("._"):
        return False
    sibling = relative.parent / name[2:]
    return sibling.as_posix() in expected_names
