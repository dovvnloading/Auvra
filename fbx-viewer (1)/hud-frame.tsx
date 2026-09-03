import React from "react";
import { createRoot, type Root } from "react-dom/client";
import "./styles.css";

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_CODE_BYTES = 192 * 1024;
const MAX_PROPS_BYTES = 32 * 1024;
const MAX_EXECUTION_STEPS = 100_000;
const MAX_EXECUTION_MS = 50;
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("HUD sandbox root is missing");
const root: Root = createRoot(rootElement);
let channel: MessagePort | null = null;
let bootstrapped = false;

type BootstrapMessage = { type: "auvra-hud-bootstrap"; nonce: string; version: 1 };
type RenderMessage = { type: "render"; nonce: string; code: string; props: Record<string, unknown> };

function byteLength(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? new TextEncoder().encode(encoded).byteLength : MAX_MESSAGE_BYTES + 1;
  } catch {
    return MAX_MESSAGE_BYTES + 1;
  }
}

function isBootstrap(value: unknown): value is BootstrapMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 3 || !Object.keys(candidate).every((key) => ["type", "nonce", "version"].includes(key))) return false;
  return candidate.type === "auvra-hud-bootstrap" && candidate.version === 1 &&
    typeof candidate.nonce === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(candidate.nonce);
}

function isRender(value: unknown, nonce: string): value is RenderMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 4 || !Object.keys(candidate).every((key) => ["type", "nonce", "code", "props"].includes(key))) return false;
  return candidate.type === "render" && candidate.nonce === nonce && typeof candidate.code === "string" &&
    !!candidate.props && typeof candidate.props === "object" && !Array.isArray(candidate.props) &&
    byteLength(value) <= MAX_MESSAGE_BYTES && byteLength(candidate.code) <= MAX_CODE_BYTES &&
    byteLength(candidate.props) <= MAX_PROPS_BYTES;
}

function createExecutionGuard(): { tick: () => void } {
  const started = performance.now();
  let steps = 0;
  return {
    tick: () => {
      steps += 1;
      if (steps > MAX_EXECUTION_STEPS || performance.now() - started > MAX_EXECUTION_MS) {
        throw new Error("HUD execution exceeded the sandbox budget");
      }
    },
  };
}

function renderMessage(value: RenderMessage): void {
  try {
    // This is the only dynamic evaluation site and is intentionally confined to
    // the opaque-origin, sandboxed HUD document.
    const getComponent = new Function("React", "__auvraHudGuard", `return (${value.code});`);
    const Component = getComponent(React, createExecutionGuard()) as React.ComponentType<Record<string, unknown>>;
    root.render(React.createElement(Component, value.props));
  } catch (error) {
    channel?.postMessage({ type: "diagnostic", code: "runtime_error" });
    root.render(React.createElement("div", {
      style: { color: "#ef4444", fontSize: "10px", fontFamily: "sans-serif", padding: "4px", background: "rgba(0,0,0,.8)" },
    }, `Runtime Error: ${error instanceof Error ? error.message.slice(0, 256) : "unknown error"}`));
  }
}

function receiveMessage(event: MessageEvent<unknown>): void {
  if (bootstrapped || event.source !== window.parent || !isBootstrap(event.data) || event.ports.length !== 1) return;
  if (byteLength(event.data) > MAX_MESSAGE_BYTES) return;
  const bootstrapNonce = event.data.nonce;
  bootstrapped = true;
  window.removeEventListener("message", receiveMessage);
  channel = event.ports[0];
  channel.onmessage = (portEvent: MessageEvent<unknown>) => {
    if (!channel || !isRender(portEvent.data, bootstrapNonce)) {
      channel?.close();
      channel = null;
      return;
    }
    renderMessage(portEvent.data);
  };
  channel.start();
}

window.addEventListener("message", receiveMessage);
