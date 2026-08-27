import React, { useEffect, useRef, useState } from "react";
import * as Babel from "@babel/standalone";
import { AlertTriangle, Loader2 } from "lucide-react";

interface DynamicHUDComponentProps {
  code: string;
  [key: string]: unknown;
}

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_CODE_BYTES = 192 * 1024;
const MAX_PROPS_BYTES = 32 * 1024;

function byteLength(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? new TextEncoder().encode(encoded).byteLength : MAX_MESSAGE_BYTES + 1;
  } catch {
    return MAX_MESSAGE_BYTES + 1;
  }
}

function createNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const DynamicHUDComponent: React.FC<DynamicHUDComponentProps> = ({ code, ...props }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const nonceRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compiledCode, setCompiledCode] = useState<string | null>(null);
  const [frameReady, setFrameReady] = useState(false);

  useEffect(() => {
    if (!code) {
      setCompiledCode(null);
      return;
    }
    try {
      if (new TextEncoder().encode(code).byteLength > MAX_CODE_BYTES) {
        throw new Error("HUD code exceeds the sandbox limit");
      }
      const sourceForBabel = `function GeneratedComponent(props) {${code}}`;
      const compiled = Babel.transform(sourceForBabel, { presets: ["react"] }).code;
      const clean = compiled?.replace('"use strict";', "").trim() || null;
      if (!clean || byteLength(clean) > MAX_CODE_BYTES) throw new Error("HUD code exceeds the sandbox limit");
      setCompiledCode(clean);
      setError(null);
    } catch (caught) {
      let message = caught instanceof Error ? caught.message : "HUD compile failed";
      if (message.includes("return outside of function")) message = "Code error: Ensure 'return' is inside logic.";
      else if (message.includes("Adjacent JSX elements")) message = "JSX Error: Wrap elements in <>.</> .";
      setError(message.slice(0, 256));
      setCompiledCode(null);
    }
  }, [code]);

  const teardown = (): void => {
    portRef.current?.close();
    portRef.current = null;
    nonceRef.current = null;
    setFrameReady(false);
  };

  useEffect(() => () => teardown(), []);

  const handleFrameLoad = (): void => {
    teardown();
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    const channel = new MessageChannel();
    const nonce = createNonce();
    nonceRef.current = nonce;
    portRef.current = channel.port1;
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const candidate = value as Record<string, unknown>;
      if (candidate.type === "error" && typeof candidate.message === "string") setError(candidate.message.slice(0, 256));
    };
    channel.port1.start();
    // The sandbox has an opaque origin because allow-same-origin is omitted.
    // A single '*' transfer is therefore unavoidable, protected by the
    // source/nonce/port checks in hud-frame.tsx.
    iframe.contentWindow.postMessage({ type: "auvra-hud-bootstrap", version: 1, nonce }, "*", [channel.port2]);
    setFrameReady(true);
  };

  useEffect(() => {
    const port = portRef.current;
    const nonce = nonceRef.current;
    if (!frameReady || !port || !nonce || !compiledCode) return;
    const message = { type: "render", nonce, code: compiledCode, props };
    if (byteLength(message) > MAX_MESSAGE_BYTES || byteLength(compiledCode) > MAX_CODE_BYTES || byteLength(props) > MAX_PROPS_BYTES) {
      setError("HUD update exceeds the sandbox message limit");
      return;
    }
    try {
      port.postMessage(message);
    } catch {
      teardown();
      setError("HUD properties could not be transferred to the sandbox");
    }
  }, [compiledCode, frameReady, props]);

  if (error) {
    return <div className="w-full h-full flex flex-col items-center justify-center bg-red-900/20 border border-red-500/50 rounded p-2 text-center">
      <AlertTriangle size={24} className="text-red-500 mb-1" />
      <span className="text-[10px] text-red-300 font-mono break-all">{error}</span>
    </div>;
  }
  if (!compiledCode) {
    return <div className="w-full h-full flex items-center justify-center text-gray-500"><Loader2 size={16} className="animate-spin" /></div>;
  }
  return <iframe
    ref={iframeRef}
    src="/hud-frame.html"
    onLoad={handleFrameLoad}
    // Scripts run in an opaque origin; no same-origin permission is granted.
    sandbox="allow-scripts"
    className="w-full h-full border-0 bg-transparent pointer-events-none"
    title="HUD Sandbox"
  />;
};
