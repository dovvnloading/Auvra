import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { frontendDiagnostics } from "../../diagnostics/runtime";

interface DynamicHUDComponentProps {
  code: string;
  [key: string]: unknown;
}

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_CODE_BYTES = 192 * 1024;
const MAX_PROPS_BYTES = 32 * 1024;
const HUD_GUARD_IDENTIFIER = "__auvraHudGuard";
// Relative to Vite's base so the sandbox page resolves wherever the editor or player is served from.
const HUD_FRAME_SRC = `${(import.meta as ImportMeta & { env: { BASE_URL: string } }).env.BASE_URL}hud-frame.html`;

type HUDCompiler = Pick<typeof import("@babel/standalone"), "transform">;
let hudCompiler: HUDCompiler | null = null;
let hudCompilerLoad: Promise<HUDCompiler> | null = null;

/**
 * Loads @babel/standalone on first use so the compiler stays out of the
 * startup bundle; a HUD without Custom elements never downloads it.
 */
export function loadHUDCompiler(): Promise<HUDCompiler> {
  if (hudCompiler) return Promise.resolve(hudCompiler);
  hudCompilerLoad ??= import("@babel/standalone").then((module) => {
    // CommonJS interop may expose the API on the namespace or on `default`.
    const loaded = typeof module.transform === "function" ? module : (module as { default?: HUDCompiler }).default;
    if (!loaded || typeof loaded.transform !== "function") throw new Error("HUD compiler failed to load");
    hudCompiler = loaded;
    return loaded;
  }).catch((caught: unknown) => {
    hudCompilerLoad = null;
    throw caught;
  });
  return hudCompilerLoad;
}

// Babel compiles user code before it crosses the sandbox boundary. Every
// loop and function body receives a cheap guard tick, allowing the iframe to
// terminate infinite loops and recursive components without blocking the
// editor renderer indefinitely.
const boundedExecutionPlugin = ({ types: t }: any) => {
  const tick = () => t.expressionStatement(
    t.callExpression(
      t.memberExpression(t.identifier(HUD_GUARD_IDENTIFIER), t.identifier("tick")),
      [],
    ),
  );
  const guardBody = (node: any): any => {
    if (t.isBlockStatement(node)) {
      node.body.unshift(tick());
      return node;
    }
    // A concise arrow body is an expression, the arrow's return value.
    if (t.isExpression(node)) return t.blockStatement([tick(), t.returnStatement(node)]);
    return t.blockStatement([tick(), node]);
  };
  return {
    name: "auvra-hud-execution-budget",
    visitor: {
      ForStatement(path: any) { path.node.body = guardBody(path.node.body); },
      ForInStatement(path: any) { path.node.body = guardBody(path.node.body); },
      ForOfStatement(path: any) { path.node.body = guardBody(path.node.body); },
      WhileStatement(path: any) { path.node.body = guardBody(path.node.body); },
      DoWhileStatement(path: any) { path.node.body = guardBody(path.node.body); },
      FunctionDeclaration(path: any) { path.node.body = guardBody(path.node.body); },
      FunctionExpression(path: any) { path.node.body = guardBody(path.node.body); },
      ArrowFunctionExpression(path: any) {
        path.node.body = guardBody(path.node.body);
        path.node.expression = false;
      },
    },
  };
};

function byteLength(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? new TextEncoder().encode(encoded).byteLength : MAX_MESSAGE_BYTES + 1;
  } catch {
    return MAX_MESSAGE_BYTES + 1;
  }
}

/**
 * Compiles HUD component body source into the guarded component expression the
 * sandbox evaluates with `React` and `__auvraHudGuard` in scope. Call
 * loadHUDCompiler() first or pass the loaded compiler.
 */
export function compileHUDCode(code: string, Babel: HUDCompiler | null = hudCompiler): string {
  if (new TextEncoder().encode(code).byteLength > MAX_CODE_BYTES) {
    throw new Error("HUD code exceeds the sandbox limit");
  }
  if (new RegExp(`\\b${HUD_GUARD_IDENTIFIER}\\b`).test(code)) {
    throw new Error("HUD code uses a reserved sandbox identifier");
  }
  if (!Babel) throw new Error("HUD compiler is not loaded");
  const sourceForBabel = `function GeneratedComponent(props) {${code}}`;
  const compiled = Babel.transform(sourceForBabel, {
    presets: ["react"],
    plugins: [boundedExecutionPlugin],
  }).code;
  const clean = compiled?.replace('"use strict";', "").trim() || null;
  if (!clean || byteLength(clean) > MAX_CODE_BYTES) throw new Error("HUD code exceeds the sandbox limit");
  return clean;
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
    let cancelled = false;
    loadHUDCompiler().then((compiler) => {
      if (cancelled) return;
      setCompiledCode(compileHUDCode(code, compiler));
      setError(null);
    }).catch((caught: unknown) => {
      if (cancelled) return;
      frontendDiagnostics.failure('hud_compile_failed', caught);
      let message = caught instanceof Error ? caught.message : "HUD compile failed";
      if (message.includes("return outside of function")) message = "Code error: Ensure 'return' is inside logic.";
      else if (message.includes("Adjacent JSX elements")) message = "JSX Error: Wrap elements in <>.</> .";
      setError(message.slice(0, 256));
      setCompiledCode(null);
    });
    return () => { cancelled = true; };
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
      if (candidate.type === "diagnostic" && candidate.code === "runtime_error") {
        frontendDiagnostics.failure('hud_runtime_failed');
      }
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
      frontendDiagnostics.failure('hud_transport_failed');
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
    src={HUD_FRAME_SRC}
    onLoad={handleFrameLoad}
    // Scripts run in an opaque origin; no same-origin permission is granted.
    sandbox="allow-scripts"
    className="w-full h-full border-0 bg-transparent pointer-events-none"
    title="HUD Sandbox"
  />;
};
