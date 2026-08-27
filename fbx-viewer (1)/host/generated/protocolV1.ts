/** Generated convenience types for auvra.host/1. Runtime validation lives in protocol.ts. */
export type Revision = number;
export type ProtocolId = string;
export type SessionId = string;
export type Method = "host.ping" | "host.getCapabilities";
export type ErrorCode = "invalid_request" | "invalid_response" | "session_mismatch" | "unknown_method" | "revision_conflict" | "internal_error";
export interface Request { protocol: "auvra.host/1"; type: "request"; id: ProtocolId; session: SessionId; revision: Revision; method: Method; payload: Record<string, never>; }
export interface PingResult { pong: true; }
export interface CapabilitiesResult { protocol: "auvra.host/1"; methods: ["host.ping", "host.getCapabilities"]; }
export type SuccessResult = PingResult | CapabilitiesResult;
export interface SuccessResponse { protocol: "auvra.host/1"; type: "response"; id: ProtocolId; session: SessionId; revision: Revision; ok: true; result: SuccessResult; }
export interface ErrorResponse { protocol: "auvra.host/1"; type: "response"; id: ProtocolId; session: SessionId; revision: Revision; ok: false; error: { code: ErrorCode; message: string; details?: Record<string, never> }; }
export type Response = SuccessResponse | ErrorResponse;
export interface Event { protocol: "auvra.host/1"; type: "event"; event: "host.session" | "host.revision"; session: SessionId; revision: Revision; payload: Record<string, never>; }
export interface Session { protocol: "auvra.host/1"; type: "session"; session: SessionId; revision: Revision; status: "created" | "active" | "closed"; }
export type Message = Request | Response | Event | Session;
