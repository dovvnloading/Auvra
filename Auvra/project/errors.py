"""Stable errors exposed by the project service."""

class AuvraProjectError(Exception):
    code = "project_error"

class InvalidProjectError(AuvraProjectError):
    code = "invalid_project"

class UnsupportedVersionError(AuvraProjectError):
    code = "unsupported_version"

class ReadOnlyError(AuvraProjectError):
    code = "read_only"

class LockError(AuvraProjectError):
    code = "locked"

class RevisionConflictError(AuvraProjectError):
    code = "revision_conflict"

class ArchiveValidationError(AuvraProjectError):
    code = "invalid_archive"

class RecoveryRequiredError(AuvraProjectError):
    code = "recovery_required"

class DiskError(AuvraProjectError):
    code = "disk_error"
