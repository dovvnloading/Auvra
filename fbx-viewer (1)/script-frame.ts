import * as BabelModule from "@babel/standalone";
import { createExecutionGuard, type HUDExecutionGuard } from "./components/HUDEditor/hudExecutionGuard";
import {
  SCRIPT_LIMITS,
  SCRIPT_PROTOCOL_VERSION,
  type ScriptCommand,
  type ScriptFrameMessage,
  type ScriptHostMessage,
} from "./runtime/scripting/protocol";
import {
  SCRIPT_GUARD_IDENTIFIER,
  compileScriptSource,
  createScriptHost,
  isScriptSnapshot,
  isScriptSource,
  type ScriptError,
} from "./runtime/scripting/scriptApi";

type ScriptCompiler = Pick<typeof import("@babel/standalone"), "transform">;
type BootstrapMessage = Extract<ScriptHostMessage, { type: "auvra-script-bootstrap" }>;
type PortMessage = Exclude<ScriptHostMessage, BootstrapMessage>;

const EXECUTION_BUDGET = { maxSteps: SCRIPT_LIMITS.maxStepsPerCallback, maxMs: SCRIPT_LIMITS.maxMsPerCallback };
let channel: MessagePort | null = null;
let bootstrapped = false;

function loadCompiler(): ScriptCompiler {
  // CommonJS interop may expose the API on the namespace or on `default`.
  const loaded = typeof BabelModule.transform === "function"
    ? BabelModule
    : (BabelModule as unknown as { default?: ScriptCompiler }).default;
  if (!loaded || typeof loaded.transform !== "function") throw new Error("Script compiler failed to load");
  return loaded;
}

const compiler = loadCompiler();

/**
 * Takes away the ways script code could create new code at runtime, which the compiler never saw
 * and so never instrumented: eval, the Function constructors and string timers. The script host
 * captured the Function constructor it evaluates compiled scripts with when its module loaded.
 */
function lockDynamicEvaluation(): void {
  const blocked = function blockedEvaluation(): never {
    throw new EvalError("Scripts cannot evaluate code at runtime");
  };
  // `fn instanceof Function` and `fn.constructor === Function` keep working.
  blocked.prototype = Function.prototype;
  const functionPrototypes = [
    Function.prototype,
    Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {}),
  ];
  for (const prototype of functionPrototypes) {
    Object.defineProperty(prototype, "constructor", { value: blocked, writable: false, configurable: false });
  }
  for (const name of ["eval", "Function"]) {
    Object.defineProperty(globalThis, name, { value: blocked, writable: false, configurable: false });
  }
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (typeof handler !== "function") throw new EvalError("Scripts cannot evaluate code at runtime");
    return nativeSetTimeout(handler, timeout, ...args);
  }) as typeof window.setTimeout;
  window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (typeof handler !== "function") throw new EvalError("Scripts cannot evaluate code at runtime");
    return nativeSetInterval(handler, timeout, ...args);
  }) as typeof window.setInterval;
}

// Compiled scripts tick this one guard. Every callback call swaps in a fresh budget; code a script
// runs later (a timer callback) ticks the latest guard, which opens a new slice once the event loop
// has turned, as for HUD code.
let activeGuard: HUDExecutionGuard = createExecutionGuard(EXECUTION_BUDGET);
const scriptGuard = Object.freeze({
  tick: (): void => {
    try {
      activeGuard.tick();
    } catch {
      throw new RangeError("Script exceeded its execution budget");
    }
  },
});
const host = createScriptHost({
  scope: { [SCRIPT_GUARD_IDENTIFIER]: scriptGuard },
  invoke: (call) => {
    activeGuard = createExecutionGuard(EXECUTION_BUDGET);
    call();
  },
});

function byteLength(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? new TextEncoder().encode(encoded).byteLength : SCRIPT_LIMITS.maxMessageBytes + 1;
  } catch {
    return SCRIPT_LIMITS.maxMessageBytes + 1;
  }
}

function hasKeys(candidate: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(candidate).length === keys.length && Object.keys(candidate).every((key) => keys.includes(key));
}

function isBootstrap(value: unknown): value is BootstrapMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!hasKeys(candidate, ["type", "nonce", "version"])) return false;
  return candidate.type === "auvra-script-bootstrap" && candidate.version === SCRIPT_PROTOCOL_VERSION &&
    typeof candidate.nonce === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(candidate.nonce);
}

// Frame messages skip the byte count, which would serialize every snapshot again; their shape is
// still checked in full. Load messages carry the script sources and are counted.
function isPortMessage(value: unknown, nonce: string): value is PortMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "load") {
    return hasKeys(candidate, ["type", "nonce", "scripts", "snapshot"]) && candidate.nonce === nonce &&
      Array.isArray(candidate.scripts) && candidate.scripts.length <= SCRIPT_LIMITS.maxScripts &&
      candidate.scripts.every(isScriptSource) && isScriptSnapshot(candidate.snapshot) &&
      byteLength(value) <= SCRIPT_LIMITS.maxMessageBytes;
  }
  if (candidate.type === "frame") {
    return hasKeys(candidate, ["type", "nonce", "snapshot"]) && candidate.nonce === nonce && isScriptSnapshot(candidate.snapshot);
  }
  return candidate.type === "unload" && hasKeys(candidate, ["type", "nonce"]) && candidate.nonce === nonce;
}

function post(message: ScriptFrameMessage): void {
  channel?.postMessage(message);
}

function postResults(errors: ScriptError[], frame: number, commands: ScriptCommand[]): void {
  for (const error of errors) post({ type: "error", scriptId: error.scriptId, message: error.message });
  post({ type: "commands", frame, commands });
}

// Every load and frame message is answered with exactly one commands message, after its errors.
function handleMessage(message: PortMessage): void {
  if (message.type === "load") {
    const loadErrors = host.load(message.scripts, (source) => compileScriptSource(source, compiler), message.snapshot);
    postResults([...loadErrors, ...host.errors()], message.snapshot.frame, host.flush());
  } else if (message.type === "frame") {
    const commands = host.frame(message.snapshot);
    postResults(host.errors(), message.snapshot.frame, commands);
  } else {
    host.unload();
  }
}

function closeChannel(): void {
  host.unload();
  channel?.close();
  channel = null;
}

function receiveMessage(event: MessageEvent<unknown>): void {
  if (bootstrapped || event.source !== window.parent || !isBootstrap(event.data) || event.ports.length !== 1) return;
  if (byteLength(event.data) > SCRIPT_LIMITS.maxMessageBytes) return;
  const bootstrapNonce = event.data.nonce;
  bootstrapped = true;
  window.removeEventListener("message", receiveMessage);
  channel = event.ports[0];
  channel.onmessage = (portEvent: MessageEvent<unknown>) => {
    if (!channel || !isPortMessage(portEvent.data, bootstrapNonce)) {
      closeChannel();
      return;
    }
    try {
      handleMessage(portEvent.data);
    } catch {
      closeChannel();
    }
  };
  channel.start();
  post({ type: "ready" });
}

lockDynamicEvaluation();
window.addEventListener("message", receiveMessage);
