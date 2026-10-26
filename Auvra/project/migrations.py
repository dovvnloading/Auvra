"""Ordered native project format migrations.

A project descriptor carries ``schemaVersion``, the version of the on-disk
format.  Opening a project written by an older engine runs every registered
migration on the path from its version to the version this engine writes, in
order, in memory, before anything is validated against the current schemas.
The repository then commits the migrated descriptor and domain documents as
one ordinary transaction, so an interrupted upgrade recovers to the complete
old or the complete new project.

Version 1 is the first native format, so the shipped registry is empty.  A
future format change appends a ``Migration(1, 2, ...)`` to ``MIGRATIONS``.
Tests inject their own registry by replacing ``REGISTRY``.

``engineVersion`` is informational provenance: the release that last wrote
the descriptor.  Compatibility is decided only by ``schemaVersion``.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping

from Auvra.diagnostics import traced
from .errors import InvalidProjectError, UnsupportedVersionError

ENGINE_VERSION = "0.2.0"
CURRENT_SCHEMA_VERSION = 1

#: ``migrate(descriptor, domains) -> (descriptor, domains)``.  Both arguments
#: are private deep copies the step may mutate.  ``domains`` maps a domain
#: name to its raw on-disk document and only holds domains that exist.
MigrationFunction = Callable[
    [dict[str, Any], dict[str, Any]], tuple[dict[str, Any], dict[str, Any]]
]


class ProjectMigrationError(InvalidProjectError):
    """A registered migration failed or produced an unusable project."""

    code = "migration_failed"


@dataclass(frozen=True)
class Migration:
    from_version: int
    to_version: int
    summary: str
    migrate: MigrationFunction


@dataclass(frozen=True)
class MigrationResult:
    descriptor: dict[str, Any]
    domains: dict[str, Any]
    applied: tuple[Migration, ...]


def _is_version(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


class MigrationRegistry:
    """Migrations keyed by the schema version they upgrade from."""

    def __init__(self, migrations: Iterable[Migration] = ()) -> None:
        self._steps: dict[int, Migration] = {}
        for migration in migrations:
            self.register(migration)

    def register(self, migration: Migration) -> None:
        if not _is_version(migration.from_version) or not _is_version(migration.to_version):
            raise ValueError("migration versions must be non-negative integers")
        if migration.to_version <= migration.from_version:
            raise ValueError("a migration must move to a newer schema version")
        if migration.from_version in self._steps:
            raise ValueError(f"duplicate migration from schema version {migration.from_version}")
        if not callable(migration.migrate):
            raise ValueError("migration function must be callable")
        self._steps[migration.from_version] = migration

    @property
    def migrations(self) -> tuple[Migration, ...]:
        return tuple(self._steps[key] for key in sorted(self._steps))

    def plan(self, version: Any, target: int = CURRENT_SCHEMA_VERSION) -> tuple[Migration, ...]:
        """Return the ordered steps from ``version`` to ``target``.

        An empty plan means the project is already current.  A newer, malformed
        or unreachable version raises ``UnsupportedVersionError``.
        """
        if not _is_version(version):
            raise UnsupportedVersionError(f"unsupported project version: schemaVersion {version!r} is not a format version")
        if version > target:
            raise UnsupportedVersionError(
                f"unsupported project version: schemaVersion {version} is newer than this engine "
                f"(Auvra {ENGINE_VERSION} reads up to {target}); open it with a newer Auvra"
            )
        steps: list[Migration] = []
        current = version
        while current < target:
            step = self._steps.get(current)
            if step is None or step.to_version > target:
                raise UnsupportedVersionError(
                    f"unsupported project version: no migration from schemaVersion {version} to {target}"
                )
            steps.append(step)
            current = step.to_version
        return tuple(steps)

    @traced("project.migrations", "migrate")
    def migrate(self, descriptor: Mapping[str, Any], domains: Mapping[str, Any],
                target: int = CURRENT_SCHEMA_VERSION) -> MigrationResult:
        """Run the planned steps on copies; inputs are never modified."""
        steps = self.plan(descriptor.get("schemaVersion"), target)
        current_descriptor = copy.deepcopy(dict(descriptor))
        current_domains = copy.deepcopy(dict(domains))
        for step in steps:
            label = f"{step.from_version}->{step.to_version}"
            try:
                result = step.migrate(current_descriptor, current_domains)
            except Exception as exc:
                raise ProjectMigrationError(f"project migration {label} failed: {exc}") from exc
            if (not isinstance(result, tuple) or len(result) != 2 or not isinstance(result[0], dict)
                    or not isinstance(result[1], dict)):
                raise ProjectMigrationError(f"project migration {label} returned an invalid result")
            current_descriptor, current_domains = result
            current_descriptor["schemaVersion"] = step.to_version
        return MigrationResult(current_descriptor, current_domains, steps)


MIGRATIONS: tuple[Migration, ...] = ()
REGISTRY = MigrationRegistry(MIGRATIONS)


def active_registry() -> MigrationRegistry:
    """The registry the repository consults, resolved at call time."""
    return REGISTRY


def stamp_engine_version(descriptor: dict[str, Any]) -> dict[str, Any]:
    """Record the engine release writing ``descriptor`` and return it."""
    descriptor["engineVersion"] = ENGINE_VERSION
    return descriptor
