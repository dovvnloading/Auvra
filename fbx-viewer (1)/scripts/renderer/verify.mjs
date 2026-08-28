import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontend = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const rendererRoot = join(frontend, "renderer");
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: frontend, encoding: "utf8", windowsHide: true, ...options });
  if (result.error) throw result.error;
  return result;
}

async function rendererSources() {
  const names = await readdir(rendererRoot);
  return names.filter((name) => /\.(?:ts|tsx)$/.test(name)).sort();
}

async function typecheck(files) {
  const tsc = join(frontend, "node_modules", "typescript", "bin", "tsc");
  const result = run(process.execPath, [tsc, "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", "--jsx", "react-jsx", "--skipLibCheck", ...files.map((name) => join("renderer", name))]);
  check(result.status === 0, `strict renderer typecheck failed:\n${result.stdout || ""}${result.stderr || ""}`);
}

async function compileCore() {
  const temp = await mkdtemp(join(tmpdir(), "auvra-renderer-"));
  const core = ["contracts.ts", "conventions.ts", "capabilities.ts", "renderGraph.ts", "registry.ts"];
  const tsc = join(frontend, "node_modules", "typescript", "bin", "tsc");
  try {
    const result = run(process.execPath, [tsc, "--strict", "--target", "ES2022", "--module", "commonjs", "--moduleResolution", "node", "--skipLibCheck", "--outDir", temp, ...core.map((name) => join("renderer", name))]);
    check(result.status === 0, `pure renderer core compilation failed:\n${result.stdout || ""}${result.stderr || ""}`);
    if (result.status !== 0) return null;
    const load = async (name) => import(`${pathToFileURL(join(temp, name)).href}?verify=${Date.now()}`);
    return { temp, contracts: await load("contracts.js"), conventions: await load("conventions.js"), capabilities: await load("capabilities.js"), graph: await load("renderGraph.js"), registry: await load("registry.js") };
  } catch (error) {
    check(false, `pure renderer core compilation/import failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    // Imports complete before this cleanup; no generated artifacts remain.
    await rm(temp, { recursive: true, force: true });
  }
}

function expectGraphError(graph, description, code, label) {
  try { graph.compileRenderGraph(description); check(false, `${label} was accepted`); }
  catch (error) { check(error?.diagnostics?.some((entry) => entry.code === code), `${label} did not report ${code}`); }
}

async function behaviorTests() {
  const modules = await compileCore();
  if (!modules) return;
  const { contracts, conventions, capabilities, graph, registry } = modules;
  const first = new contracts.HandlePool("buffer");
  const handle = first.allocate();
  check(contracts.isResourceHandle(handle, "buffer"), "allocated handle is not a valid buffer handle");
  check(first.isLive(handle), "allocated handle is not live");
  check(first.release(handle), "live handle could not be released");
  check(!first.isLive(handle) && !first.release(handle), "released handle was reusable");
  const next = first.allocate();
  check(next === "buffer:1:2", `handle generation is not deterministic: ${next}`);
  check(!first.isLive(handle), "stale handle became live after slot reuse");
  check(conventions.isRenderConventions(conventions.RENDER_CONVENTIONS), "fixed render conventions rejected themselves");
  check(!conventions.isRenderConventions({ ...conventions.RENDER_CONVENTIONS, color: { ...conventions.RENDER_CONVENTIONS.color, toneMappingExposure: 2 } }), "non-contract tone-mapping exposure was accepted");
  try { conventions.assertRenderConventions({ version: 1 }); check(false, "invalid conventions were accepted"); } catch { /* expected */ }

  const report = (webgpu, qualified = true) => ({ tier: "portable-modern", backends: [
    { backend: "webgl2", available: true, tier: "compatibility", features: [], limits: {} },
    { backend: "webgpu", available: webgpu, tier: "native-advanced", features: ["storage"], limits: { maxSamples: 4 }, qualification: { qualified, sceneIds: ["basic"] } },
  ] });
  const webgpu = capabilities.selectBackend("webgpu", report(true), { sceneId: "basic" });
  check(webgpu.backend === "webgpu" && !webgpu.fallback, "qualified WebGPU request did not select WebGPU");
  const unqualified = capabilities.selectBackend("webgpu", report(true, false), { sceneId: "basic" });
  check(unqualified.backend === "webgl2" && unqualified.fallback && unqualified.fallbackReasons.length > 0, "unqualified WebGPU did not deliberately fall back to WebGL2");
  const unavailable = capabilities.selectBackend("webgpu", report(false), { sceneId: "basic" });
  check(unavailable.backend === "webgl2" && unavailable.fallback, "unavailable WebGPU did not fall back to WebGL2");
  const auto = capabilities.selectBackend("auto", report(true, false));
  check(auto.backend === "webgl2" && !auto.fallback, "auto selection changed the stable WebGL2 default");

  const valid = graph.compileRenderGraph({
    resources: [{ id: "color", kind: "texture" }, { id: "lighting", kind: "texture" }, { id: "unused", kind: "buffer" }],
    passes: [
      { id: "geometry", writes: ["color"] },
      { id: "lighting", reads: ["color"], writes: ["lighting"] },
      { id: "unused", writes: ["unused"] },
      { id: "present", reads: ["lighting"], sideEffects: true },
    ],
    outputs: ["lighting"],
  });
  check(valid.passes.map((pass) => pass.id).join(",") === "geometry,lighting,present", "render graph ordering is not deterministic");
  check(valid.culledPasses.includes("unused"), "unreferenced render pass was not culled");
  check(valid.lifetimes.color?.firstUse === 0 && valid.lifetimes.color?.lastUse === 1, "render resource lifetime is incorrect");
  check(valid.transitions.some((entry) => entry.resourceId === "color" && entry.from === "write" && entry.to === "read"), "render resource transition was not recorded");
  const resources = [{ id: "a", kind: "texture" }, { id: "b", kind: "texture" }];
  expectGraphError(graph, { resources: [{ id: "a", kind: "texture" }, { id: "a", kind: "texture" }], passes: [] }, "duplicate-resource", "duplicate resources");
  expectGraphError(graph, { resources, passes: [{ id: "p", reads: ["a"], writes: ["a"] }] }, "in-pass-hazard", "in-pass hazard");
  expectGraphError(graph, { resources, passes: [{ id: "p", reads: ["a"] }] }, "missing-producer", "missing producer");
  expectGraphError(graph, { resources, passes: [{ id: "p1", writes: ["a"] }, { id: "p2", writes: ["a"] }] }, "duplicate-producer", "duplicate producer");
  expectGraphError(graph, { resources, passes: [{ id: "p1", reads: ["b"], writes: ["a"] }, { id: "p2", reads: ["a"], writes: ["b"] }] }, "cycle", "render graph cycle");

  // The registry has no DOM dependency until a real canvas is registered.
  check(typeof registry.rendererCoordinator.getSnapshot === "function", "renderer registry is not DOM-independent at import time");
  const listeners = new Map();
  const canvas = { getContext: () => null, addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: () => {}, dispatchEvent: (event) => { listeners.get(event.type)?.(event); return true; } };
  const surfaceId = `verify.registry.${process.pid}`;
  try {
    registry.rendererCoordinator.registerSurface({ id: surfaceId, role: "reference", canvas, selectedBackend: "webgl2", tier: "compatibility" });
    registry.rendererCoordinator.markReady(surfaceId);
    const before = registry.rendererCoordinator.getSnapshot(surfaceId);
    check(before.lifecycle === "ready", "renderer registry surface did not become ready");
    registry.rendererCoordinator.markContextLost(surfaceId);
    check(registry.rendererCoordinator.getSnapshot(surfaceId).lifecycle === "lost", "renderer registry did not report context loss");
    const previousConsoleError = console.error;
    console.error = () => {};
    try {
      registry.rendererCoordinator.registerSurface({ id: surfaceId, role: "reference", canvas });
      check(false, "duplicate renderer surface registration was accepted");
    } catch { /* expected duplicate rejection */ }
    finally { console.error = previousConsoleError; }
  } finally { registry.rendererCoordinator.unregisterSurface(surfaceId); }
}

async function staticChecks(files) {
  const all = await Promise.all(files.map(async (name) => [name, await readFile(join(rendererRoot, name), "utf8")]));
  const rootFiles = [];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (/\.(?:ts|tsx)$/.test(entry.name)) rootFiles.push([path, await readFile(path, "utf8")]);
    }
  }
  await collect(frontend);
  for (const [path, text] of rootFiles) {
    const rel = relative(frontend, path).replaceAll("\\", "/");
    if (rel !== "renderer/AuvraCanvas.tsx") check(!/<Canvas\b/.test(text), `${rel} directly renders R3F Canvas`);
    const preserve = [...text.matchAll(/preserveDrawingBuffer\s*:\s*(true|false)/g)];
    for (const match of preserve) check(match[1] === "true" ? rel === "renderer/capture.ts" : true, `${rel} violates preserveDrawingBuffer policy`);
    if (rel === "renderer/AuvraCanvas.tsx") check(/preserveDrawingBuffer\s*:\s*false/.test(text), "AuvraCanvas presentation wrapper must explicitly disable preserveDrawingBuffer");
    if (rel === "renderer/capture.ts") check(/preserveDrawingBuffer\s*:\s*true/.test(text), "capture renderer must explicitly enable preserveDrawingBuffer");
    if (!rel.startsWith("scripts/")) check(!/console\.(?:log|info|warn|error|debug)\s*\(/.test(text), `${rel} retains production console logging`);
    if (rel === "App.tsx") check(!/console\s*\.\s*(?:log|warn|error|info|debug)\s*=/.test(text), "App.tsx replaces a console method");
  }
  const surfaces = [];
  for (const [path, text] of rootFiles) for (const match of text.matchAll(/\bsurfaceId\s*=\s*["']([^"']+)["']/g)) surfaces.push([match[1], relative(frontend, path)]);
  const seen = new Map();
  for (const [id, path] of surfaces) {
    check(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id), `${path} has an invalid surface id '${id}'`);
    if (seen.has(id)) failures.push(`surface id '${id}' is declared by both ${seen.get(id)} and ${path}`); else seen.set(id, path);
  }
  const publicContracts = ["contracts.ts", "conventions.ts", "renderGraph.ts"].map((name) => Object.fromEntries(all)[name] || "").join("\n");
  check(!/\b(?:WebGL|WebGPU|GPU|THREE|HTMLCanvasElement|CanvasRenderingContext)\b/.test(publicContracts), "public renderer contracts expose backend-native or DOM types");
  const reference = Object.fromEntries(all)["referenceScenes.ts"] || "";
  const nativeReference = Object.fromEntries(all)["nativeReference.ts"] || "";
  const diagnostics = Object.fromEntries(all)["diagnostics.ts"] || "";
  check(/REFERENCE_BASELINE/.test(reference) && /maxCpuP95Ms\s*:\s*\d+/.test(reference) && /maxGpuFrameMs\s*:\s*\d+/.test(reference) && /maxMemoryBytes\s*:\s*\d+/.test(reference), "reference scene budgets are missing");
  check(reference.includes("createRenderPipeline") && reference.includes("onSubmittedWorkDone") && !reference.includes("WebGPURenderer"), "WebGPU reference probe must remain directly owned and compatible with the production build target");
  check(/runNativeReferenceGate/.test(nativeReference) && /referenceVersion\s*!==\s*1/.test(nativeReference) && /FEATURES/.test(nativeReference) && /entry\.feature\s*!==\s*FEATURES\[index\]/.test(nativeReference) && /REFERENCE_BASELINE/.test(nativeReference), "native cross-backend reference gate is incomplete");
  check(/runNativeReferenceGate/.test(diagnostics), "native reference gate is not exposed through renderer diagnostics");
  const expectedSurfaceIds = new Set(["editor-scene-viewer", "preview-retexture-editor", "preview-animation-graph", "runtime-sandbox", "editor-environment-viewport", "runtime-level-game-loop"]);
  check(surfaces.length === expectedSurfaceIds.size && surfaces.every(([id]) => expectedSurfaceIds.has(id)), "renderer surface IDs do not match the six stable editor/runtime surfaces");
}

const files = await rendererSources();
await typecheck(files);
await behaviorTests();
await staticChecks(files);
if (failures.length) { console.error(failures.map((failure) => `FAIL: ${failure}`).join("\n")); process.exit(1); }
console.log(`renderer verification passed (${files.length} renderer modules checked)`);
