"""Deterministic, path-minimising asset cooking primitives."""

from __future__ import annotations

import json
import hashlib
from pathlib import Path
import shutil
from typing import Any

from .pipeline import ReleaseError, _assert_no_forbidden, _assert_regular_tree, _read_policy, canonical_json, sha256


# Keep cooking bounded even when it is fed an accidentally broad source tree.
# JSON is intentionally bounded more tightly because it is canonicalized in
# memory; all other assets are copied and hashed in chunks.
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_ASSET_BYTES = 512 * 1024 * 1024
MAX_TOTAL_ASSET_BYTES = 2 * 1024 * 1024 * 1024
COPY_CHUNK_BYTES = 1024 * 1024


def _strict_json(raw: bytes, relative: str) -> bytes:
    def reject_constant(value: str) -> Any:
        raise ReleaseError(f"asset JSON contains non-finite value: {relative}")

    def reject_duplicate(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ReleaseError(f"asset JSON contains duplicate key: {relative}")
            result[key] = value
        return result

    try:
        value = json.loads(raw.decode("utf-8"), parse_constant=reject_constant, object_pairs_hook=reject_duplicate)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReleaseError(f"asset JSON is invalid: {relative}") from exc
    return canonical_json(value)


def cook_assets(source_root: Path, output_root: Path) -> dict[str, Any]:
    """Copy regular source assets in stable order and emit a path-free manifest.

    The manifest contains only package-relative paths, sizes, and streamed
    SHA-256 digests.  Machine-specific source paths never enter its bytes.
    """

    policy = _read_policy()
    source = source_root.resolve()
    if output_root.exists():
        if output_root.is_symlink() or not output_root.is_dir():
            raise ReleaseError("asset output root is unsafe")
        shutil.rmtree(output_root)
    output_root.mkdir(parents=True)
    files = _assert_regular_tree(source, label="asset")
    entries: list[dict[str, Any]] = []
    total_bytes = 0
    for path in files:
        relative = path.relative_to(source).as_posix()
        _assert_no_forbidden(relative, policy)
        target = output_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        source_size = path.stat().st_size
        if source_size > MAX_ASSET_BYTES:
            raise ReleaseError(f"asset exceeds per-file limit: {relative}")
        total_bytes += source_size
        if total_bytes > MAX_TOTAL_ASSET_BYTES:
            raise ReleaseError("asset tree exceeds total size limit")
        if path.suffix.lower() == ".json":
            if source_size > MAX_JSON_BYTES:
                raise ReleaseError(f"JSON asset exceeds canonicalization limit: {relative}")
            raw = path.read_bytes()
            cooked = _strict_json(raw, relative)
            if len(cooked) > MAX_ASSET_BYTES:
                raise ReleaseError(f"canonical JSON asset exceeds per-file limit: {relative}")
            target.write_bytes(cooked)
            output_digest = sha256(target)
        else:
            digest = hashlib.sha256()
            with path.open("rb") as source_stream, target.open("wb") as target_stream:
                for chunk in iter(lambda: source_stream.read(COPY_CHUNK_BYTES), b""):
                    digest.update(chunk)
                    target_stream.write(chunk)
            output_digest = digest.hexdigest()
        entries.append({"path": relative, "size": target.stat().st_size, "sha256": output_digest})
    entries.sort(key=lambda item: item["path"])
    manifest = {"schema": 1, "assetCount": len(entries), "assets": entries}
    (output_root / "assets-manifest.json").write_bytes(canonical_json(manifest))
    return manifest


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(prog="release.asset_cooking")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        cook_assets(args.source, args.output)
    except (OSError, ReleaseError) as exc:
        parser.error(str(exc))
