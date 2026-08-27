"""Generated convenience types for auvra.host/1."""
from typing import Literal, NotRequired, TypedDict
ProtocolId = str
SessionId = str
Revision = int
Method = Literal["host.ping", "host.getCapabilities"]
ErrorCode = Literal["invalid_request", "invalid_response", "session_mismatch", "unknown_method", "revision_conflict", "internal_error"]
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
class CapabilitiesResult(TypedDict):
    protocol: Literal["auvra.host/1"]
    methods: list[Method]
SuccessResult = PingResult | CapabilitiesResult
class SuccessResponse(TypedDict):
    protocol: Literal["auvra.host/1"]
    type: Literal["response"]
    id: ProtocolId
    session: SessionId
    revision: Revision
    ok: Literal[True]
    result: PingResult | CapabilitiesResult
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
    event: Literal["host.session", "host.revision"]
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
