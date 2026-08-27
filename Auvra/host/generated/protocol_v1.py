"""Generated convenience types for auvra.host/1."""
from typing import Literal, NotRequired, TypedDict
ProtocolId = str
SessionId = str
Revision = int
Method = Literal["host.ping", "host.getCapabilities", "project.getStatus", "project.create", "project.open", "project.openRecent", "project.close", "project.getSnapshot", "project.applyChanges", "project.save", "project.saveAs", "project.exportPack", "project.importPack", "project.importLegacy", "asset.beginUpload", "asset.resolve"]
ErrorCode = Literal["invalid_request", "invalid_response", "session_mismatch", "unknown_method", "revision_conflict", "cancelled", "locking", "read_only", "invalid_project", "unsupported_version", "migration_failed", "disk_failure", "permission_denied", "recovery_required", "internal_error"]
class Request(TypedDict):
    protocol: Literal["auvra.host/1"]
    type: Literal["request"]
    id: ProtocolId
    session: SessionId
    revision: Revision
    method: Method
    payload: dict[str, object]
class PingResult(TypedDict):
    pong: Literal[True]
class CapabilitiesResult(TypedDict, total=False):
    protocol: Literal["auvra.host/1"]
    methods: list[Method]
    projectMethods: list[Method]
class ProjectResult(TypedDict, total=False):
    projectId: str | None
    revision: Revision
    name: str | None
    readOnly: bool
    dirty: bool
    busy: bool
    progress: float | None
    recoveryAvailable: bool
    recoveryId: str
    recoveryKind: str
    recoveryPoints: list[dict[str, object]]
    recentProjects: list[dict[str, str]]
    status: str
    domains: list[str] | dict[str, object]
    documents: list[object]
    cursor: str
    hasMore: bool
    handle: str
    uploadId: str
    expiresAt: float
    method: str
    url: str
    assetId: str
    size: int
    sha256: str
    mime: str
    report: dict[str, object]
SuccessResult = PingResult | CapabilitiesResult | ProjectResult
class SuccessResponse(TypedDict):
    protocol: Literal["auvra.host/1"]
    type: Literal["response"]
    id: ProtocolId
    session: SessionId
    revision: Revision
    ok: Literal[True]
    result: PingResult | CapabilitiesResult | ProjectResult
class ErrorBody(TypedDict):
    code: ErrorCode
    message: str
    details: NotRequired[dict[str, object]]
class ErrorResponse(TypedDict):
    protocol: Literal["auvra.host/1"]
    type: Literal["response"]
    id: ProtocolId
    session: SessionId
    revision: Revision
    ok: Literal[False]
    error: ErrorBody
class Event(TypedDict):
    protocol: Literal["auvra.host/1"]
    type: Literal["event"]
    event: Literal["host.session", "host.revision", "project.status", "project.opening", "project.opened", "project.closing", "project.closed", "project.revision", "project.dirty", "project.readOnly", "project.progress", "project.recovery"]
    session: SessionId
    revision: Revision
    payload: dict[str, object]
class Session(TypedDict):
    protocol: Literal["auvra.host/1"]
    type: Literal["session"]
    session: SessionId
    revision: Revision
    status: Literal["created", "active", "closed"]
Message = Request | SuccessResponse | ErrorResponse | Event | Session
