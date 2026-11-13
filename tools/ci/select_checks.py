"""Conservative, fail-open CI path routing for Auvra.

A missing diff, unknown new top-level path, or workflow change runs every
check. Documentation-only changes are the one intentional fast path to no jobs.
"""

from __future__ import annotations

import argparse
import sys

CHECKS = ("editor", "browser", "python", "native", "player", "smoke")
ALL = frozenset(CHECKS)


def classify(paths: list[str], *, full: bool = False) -> set[str]:
    names = [path.strip().replace("\\", "/") for path in paths if path.strip()]
    if full or not names:
        return set(ALL)

    selected: set[str] = set()
    for path in names:
        # Changing the routing itself, CI, or shared metadata must exercise all gates.
        if path.startswith((".github/", "tools/ci/", "protocol/", "project/")):
            return set(ALL)
        if path == "LICENSE" or path.startswith("LICENSE."):
            return set(ALL)

        if path in {"docs/texture-suite-m0-gpu-captures.json", "docs/texture-suite-m0-gpu-matrix.md"}:
            selected.add("editor")
            continue
        if path.startswith("docs/") or path.lower().endswith((".md", ".rst")):
            continue
        if path in {".gitignore", ".gitattributes", ".editorconfig"}:
            continue

        if path.startswith("fbx-viewer (1)/"):
            selected.update(("editor", "browser", "smoke"))
            if path.startswith(("fbx-viewer (1)/scripts/protocol/", "fbx-viewer (1)/host/generated/")):
                selected.update(("python", "native", "player"))
            if path.startswith(("fbx-viewer (1)/scripts/player/", "fbx-viewer (1)/runtime/player/")):
                selected.add("player")
            continue
        if path.startswith("Auvra/"):
            selected.update(("python", "smoke"))
            continue
        if path.startswith("tests/"):
            selected.add("python")
            if path.startswith("tests/desktop/"):
                selected.add("smoke")
            continue
        if path.startswith("tools/"):
            selected.add("python")
            continue
        if path.startswith("release/"):
            selected.update(("python", "player"))
            continue
        if path.startswith("native/"):
            selected.update(("native", "smoke"))
            continue
        if path.startswith("player-desktop/"):
            selected.add("player")
            continue
        if path in {"pyproject.toml", "uv.lock"}:
            selected.update(("python", "smoke"))
            continue
        if path in {"Cargo.toml", "Cargo.lock", "rust-toolchain.toml"}:
            selected.update(("native", "player", "smoke"))
            continue

        # Never silently skip checks when the repository gains a new code area.
        return set(ALL)

    return selected


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event", required=True, choices=("push", "pull_request", "workflow_dispatch"))
    args = parser.parse_args()
    chosen = classify(sys.stdin.read().splitlines(), full=args.event == "workflow_dispatch")
    for check in CHECKS:
        print(f"{check}={'true' if check in chosen else 'false'}")
    print(f"Selected CI checks: {', '.join(sorted(chosen)) or 'none (docs-only)'}", file=sys.stderr)


if __name__ == "__main__":
    main()
