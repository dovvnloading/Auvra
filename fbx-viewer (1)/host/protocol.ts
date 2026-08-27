import type { Message, Request, Response } from "./generated/protocolV1";
import validateProtocolV1 from "./generated/validateProtocolV1";

// Ajv compiles the canonical Draft 2020-12 schema during the deterministic
// generation step. The browser executes this standalone validator without
// eval/new Function, so the editor's CSP can keep dynamic code disabled.
const validate = validateProtocolV1 as ((value: unknown) => boolean) & { errors?: unknown };

export class ProtocolError extends Error { constructor(message = "Invalid protocol message") { super(message); this.name = "ProtocolError"; } }
export function isValidMessage(value: unknown): value is Message { return validate(value) === true; }
export function assertMessage(value: unknown): asserts value is Message { if (!isValidMessage(value)) throw new ProtocolError(); }
export function assertRequest(value: unknown): asserts value is Request { assertMessage(value); if (value.type !== "request") throw new ProtocolError(); }
export function assertResponse(value: unknown): asserts value is Response { assertMessage(value); if (value.type !== "response") throw new ProtocolError(); }
export function schemaErrors(): unknown { return validate.errors ?? null; }
