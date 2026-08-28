"""Injected, allowlisted settings skeleton; no file or project authority."""

from __future__ import annotations

from copy import deepcopy
from collections.abc import Iterable, Mapping
import math
from typing import Any

from Auvra.diagnostics.core import trace_public_class


class SettingsError(ValueError):
    pass


class SettingsConflict(SettingsError):
    pass


@trace_public_class("host_settings", concise=("update",))
class SettingsStore:
    """In-memory settings store whose backing state is explicitly injected."""

    def __init__(self, initial: Mapping[str, Any] | None = None, *, allowed_keys: Iterable[str] | None = None,
                 defaults: Mapping[str, Any] | None = None) -> None:
        initial = dict(initial or {})
        defaults = dict(defaults or {})
        self._allowed = frozenset(allowed_keys if allowed_keys is not None else set(initial) | set(defaults))
        self._values = dict(defaults)
        self._revision = 0
        self._validate_keys(defaults)
        self._validate_keys(initial)
        for value in (*defaults.values(), *initial.values()):
            self._validate_value(value)
        self._values.update(deepcopy(initial))

    def _validate_keys(self, values: Mapping[str, Any]) -> None:
        unknown = set(values) - self._allowed
        if unknown:
            raise SettingsError("unknown setting")

    @classmethod
    def _validate_value(cls, value: Any, *, depth: int = 0, seen: set[int] | None = None) -> None:
        seen = seen or set()
        if depth > 8:
            raise SettingsError("setting value is too deep")
        if value is None or isinstance(value, (str, bool)):
            if isinstance(value, str) and len(value) > 1024:
                raise SettingsError("setting string is too long")
            return
        if isinstance(value, int) and not isinstance(value, bool):
            if abs(value) > 9007199254740991: raise SettingsError("setting number is out of bounds")
            return
        if isinstance(value, float):
            if not math.isfinite(value): raise SettingsError("setting number must be finite")
            return
        marker = id(value)
        if marker in seen: raise SettingsError("cyclic setting value")
        seen.add(marker)
        try:
            if isinstance(value, Mapping):
                if len(value) > 64 or any(not isinstance(key, str) or len(key) > 128 for key in value):
                    raise SettingsError("setting object is too large")
                for key, item in value.items():
                    cls._validate_value(key, depth=depth + 1, seen=seen)
                    cls._validate_value(item, depth=depth + 1, seen=seen)
                return
            if isinstance(value, (list, tuple)):
                if len(value) > 64: raise SettingsError("setting array is too large")
                for item in value: cls._validate_value(item, depth=depth + 1, seen=seen)
                return
        finally:
            seen.remove(marker)
        raise SettingsError("setting value is not JSON-compatible")

    @property
    def revision(self) -> int:
        return self._revision

    def snapshot(self) -> dict[str, Any]:
        return {"revision": self._revision, "values": deepcopy(self._values)}

    def update(self, values: Mapping[str, Any], expected_revision: int) -> dict[str, Any]:
        if expected_revision != self._revision:
            raise SettingsConflict("settings revision conflict")
        if not isinstance(values, Mapping):
            raise SettingsError("settings must be an object")
        self._validate_keys(values)
        for value in values.values(): self._validate_value(value)
        self._values.update(deepcopy(dict(values)))
        self._revision += 1
        return self.snapshot()
