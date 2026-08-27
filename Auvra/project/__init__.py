"""Native, host-owned Auvra project persistence.

The package deliberately uses only Python's standard library for file format,
locking, transactions, archives, and indexing.  ``jsonschema`` is used only
when validating the checked-in schemas.
"""

from .errors import (
    AuvraProjectError, ArchiveValidationError, InvalidProjectError,
    LockError, ReadOnlyError, RevisionConflictError, UnsupportedVersionError,
)
from .repository import ProjectRepository, ProjectStatus, ProjectSnapshot
from .assets import AssetStore, AssetReference
from .legacy import LegacyArchive, LegacyMigrationReport, validate_archive
from .index import ProjectIndex
from .serialization import canonical_json, load_json, dump_json
from .schemas import validate_domain, validate_project_descriptor
from .service import ProjectService

__all__ = [
    "AuvraProjectError", "ArchiveValidationError", "InvalidProjectError",
    "LockError", "ReadOnlyError", "RevisionConflictError",
    "UnsupportedVersionError", "ProjectRepository", "ProjectStatus",
    "ProjectSnapshot", "AssetStore", "AssetReference", "LegacyArchive",
    "LegacyMigrationReport", "validate_archive", "ProjectIndex",
    "canonical_json", "load_json", "dump_json",
    "validate_domain", "validate_project_descriptor",
    "ProjectService",
]
