"""Deterministic model for install/upgrade/rollback/uninstall acceptance."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .pipeline import ReleaseError, verify_package


@dataclass
class LifecycleState:
    """A side-effect-free model mirroring Windows package lifecycle rules."""

    installed: dict[str, tuple[int, int, int, int]] = field(default_factory=dict)
    user_data: dict[str, bytes] = field(default_factory=dict)

    @staticmethod
    def _version(value: str) -> tuple[int, int, int, int]:
        parts = value.split(".")
        if len(parts) != 4 or any(not part.isdigit() for part in parts):
            raise ReleaseError("lifecycle package version is invalid")
        return tuple(int(part) for part in parts)  # type: ignore[return-value]

    def install(self, package_root: Path, *, channel: str, force_any_version: bool = False) -> dict[str, Any]:
        manifest = verify_package(package_root, expected_channel=channel)
        identity = str(manifest["identity"])
        version = self._version(str(manifest["version"]))
        current = self.installed.get(identity)
        if current is not None and version < current and not force_any_version:
            raise ReleaseError("older package requires explicit rollback permission")
        self.installed[identity] = version
        return {"action": "rollback" if current and version < current else "install", "identity": identity,
                "version": manifest["version"], "userDataPreserved": True}

    def uninstall(self, *, channel: str) -> dict[str, Any]:
        policy = {"stable": "Auvra", "beta": "Auvra.Beta", "dev": "Auvra.Dev"}
        identity = policy.get(channel)
        if identity is None:
            raise ReleaseError("unknown lifecycle channel")
        self.installed.pop(identity, None)
        return {"action": "uninstall", "identity": identity, "userDataPreserved": True}


def verify_lifecycle(package_root: Path, *, channel: str) -> dict[str, Any]:
    state = LifecycleState(user_data={"projects/example.auvra": b"preserve"})
    manifest = verify_package(package_root, expected_channel=channel)
    state.install(package_root, channel=channel)
    first = dict(state.user_data)
    state.install(package_root, channel=channel)
    if state.user_data != first:
        raise ReleaseError("upgrade changed user data")
    identity = str(manifest["identity"])
    current = state.installed[identity]
    state.installed[identity] = (current[0] + 1, current[1], current[2], current[3])
    try:
        state.install(package_root, channel=channel)
    except ReleaseError:
        rollback = state.install(package_root, channel=channel, force_any_version=True)
        if rollback["action"] != "rollback":
            raise ReleaseError("rollback was not recorded")
    state.uninstall(channel=channel)
    if state.user_data != first:
        raise ReleaseError("uninstall removed user data")
    return {"schema": 1, "channel": channel, "identity": manifest["identity"],
            "version": manifest["version"], "userDataPreserved": True}
