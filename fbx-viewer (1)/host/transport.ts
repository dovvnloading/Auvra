import type { Request, Response, Event } from "./generated/protocolV1";

export interface HostTransport {
  request(request: Request): Promise<Response>;
  subscribe(listener: (event: Event) => void): () => void;
  close(): void;
}
