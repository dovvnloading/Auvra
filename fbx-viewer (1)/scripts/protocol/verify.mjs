import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";
import { buildSync } from "esbuild";

const root = resolve(import.meta.dirname, "..", "..", "..");
const schema = JSON.parse(await readFile(resolve(root, "protocol", "v1", "auvra-host.schema.json"), "utf8"));
const vectors = JSON.parse(await readFile(resolve(root, "protocol", "v1", "conformance.json"), "utf8"));
const standaloneValidator = await readFile(resolve(root, "fbx-viewer (1)", "host", "generated", "validateProtocolV1.ts"), "utf8");
if (/\brequire\s*\(|\b(?:eval|Function)\s*\(/.test(standaloneValidator)) {
  throw new Error("standalone protocol validator contains a browser-unsafe runtime construct");
}
const validate = new Ajv2020({ strict: true }).compile(schema);
const MAX_MESSAGE_BYTES = 256 * 1024;
const bounded = (message) => Buffer.byteLength(JSON.stringify(message), "utf8") <= MAX_MESSAGE_BYTES;
for (const vector of vectors.valid) if (!validate(vector.message) || !bounded(vector.message)) throw new Error(`valid vector rejected or oversized: ${vector.name}`);
for (const vector of vectors.invalid) if (validate(vector.message) && bounded(vector.message)) throw new Error(`invalid vector accepted: ${vector.name}`);
const engineAjv = new Ajv2020({ strict: true });
engineAjv.addSchema(schema);
const validateEngineResult = engineAjv.getSchema(`${schema.$id}#/$defs/engineResult`);
if (!validateEngineResult) throw new Error("engine result schema is unavailable");
const featureNames = schema.$defs.engineFeature.enum;
const engineFeatureResult = { kind: "engine.status", protocol: "auvra.native/1", status: "ready", worldRevision: 0, viewport: "closed", featureCapabilities: featureNames.map((feature) => ({ feature, supported: true, fallbackReason: null })) };
if (!validateEngineResult(engineFeatureResult)) throw new Error("exact native feature capability table was rejected");
const duplicateFeatures = structuredClone(engineFeatureResult);
duplicateFeatures.featureCapabilities[1] = { ...duplicateFeatures.featureCapabilities[0] };
if (validateEngineResult(duplicateFeatures)) throw new Error("duplicate native feature capability names were accepted");
const reorderedFeatures = structuredClone(engineFeatureResult);
[reorderedFeatures.featureCapabilities[0], reorderedFeatures.featureCapabilities[1]] = [reorderedFeatures.featureCapabilities[1], reorderedFeatures.featureCapabilities[0]];
if (validateEngineResult(reorderedFeatures)) throw new Error("reordered native feature capabilities were accepted");
console.log(`protocol conformance passed (${vectors.valid.length} valid, ${vectors.invalid.length} invalid)`);

if (process.argv.includes("--fake-host")) {
  const temp = resolve(root, "fbx-viewer (1)", "dist", ".auvra-protocol-fake-host");
  await rm(temp, { recursive: true, force: true });
  await mkdir(resolve(temp, "host", "generated"), { recursive: true });
  await cp(resolve(root, "fbx-viewer (1)", "host", "generated", "protocolV1.ts"), resolve(temp, "host", "generated", "protocolV1.ts"));
  await cp(resolve(root, "fbx-viewer (1)", "host", "generated", "validateProtocolV1.ts"), resolve(temp, "host", "generated", "validateProtocolV1.ts"));
  let protocol = await readFile(resolve(root, "fbx-viewer (1)", "host", "protocol.ts"), "utf8");
  protocol = protocol
    .replaceAll('"./generated/protocolV1"', '"./generated/protocolV1.ts"')
    .replaceAll('"./generated/validateProtocolV1"', '"./generated/validateProtocolV1.ts"');
  await writeFile(resolve(temp, "host", "protocol.ts"), protocol, "utf8");
  let fake = await readFile(resolve(root, "fbx-viewer (1)", "host", "fakeHost.ts"), "utf8");
  fake = fake.replaceAll('"./protocol"', '"./protocol.ts"').replaceAll('"./transport"', '"./transport.ts"').replaceAll('"./generated/protocolV1"', '"./generated/protocolV1.ts"');
  await writeFile(resolve(temp, "host", "fakeHost.ts"), fake, "utf8");
  const copyRuntimeModule = async (source, target, replacements = []) => {
    let contents = await readFile(resolve(root, "fbx-viewer (1)", source), "utf8");
    for (const [from, to] of replacements) contents = contents.replaceAll(from, to);
    await mkdir(resolve(temp, target, ".."), { recursive: true });
    await writeFile(resolve(temp, target), contents, "utf8");
  };
  await copyRuntimeModule("host/bootstrap.ts", "host/bootstrap.ts", [
    ['"./fakeHost"', '"./fakeHost.ts"'], ['"./nativeTransport"', '"./nativeTransport.ts"'],
    ['"./transport"', '"./transport.ts"'], ['"../diagnostics/runtime"', '"../diagnostics/runtime.ts"'],
  ]);
  await copyRuntimeModule("host/nativeTransport.ts", "host/nativeTransport.ts", [
    ['"./protocol"', '"./protocol.ts"'], ['"./transport"', '"./transport.ts"'],
    ['"./generated/protocolV1"', '"./generated/protocolV1.ts"'], ['"../diagnostics/runtime"', '"../diagnostics/runtime.ts"'],
  ]);
  await copyRuntimeModule("host/transport.ts", "host/transport.ts", [['"./generated/protocolV1"', '"./generated/protocolV1.ts"']]);
  await copyRuntimeModule("host/protocol.ts", "host/protocol.ts", [
    ['"./generated/protocolV1"', '"./generated/protocolV1.ts"'],
    ['"./generated/validateProtocolV1"', '"./generated/validateProtocolV1.ts"'],
  ]);
  await copyRuntimeModule("diagnostics/runtime.ts", "diagnostics/runtime.ts");
  await copyRuntimeModule("host/engine.ts", "host/engine.ts", [
    ['"./bootstrap"', '"./bootstrap.ts"'], ['"./generated/protocolV1"', '"./generated/protocolV1.ts"'],
    ["'../diagnostics/runtime'", "'../diagnostics/runtime.ts'"],
  ]);
  await copyRuntimeModule("utils/projectService.ts", "utils/projectService.ts", [
    ["'../host/bootstrap'", "'../host/bootstrap.ts'"], ["'../host/generated/protocolV1'", "'../host/generated/protocolV1.ts'"],
    ["'../diagnostics/runtime'", "'../diagnostics/runtime.ts'"],
  ]);
  await writeFile(resolve(temp, "run.ts"), `import { FakeHost } from "./host/fakeHost.ts";
import { NativeEngineService } from "./host/engine.ts";
import { ProjectService } from "./utils/projectService.ts";
const host = new FakeHost();
const request = { protocol: "auvra.host/1", type: "request", id: "r1", session: host.session, revision: 0, method: "host.ping", payload: {} };
const reply = await host.request(request);
if (!reply.ok || !reply.result.pong) throw new Error("ping behavior failed");
const event = host.emitRevision();
if (event.revision !== 1) throw new Error("revision event failed");
const next = await host.request({ ...request, revision: 1 });
if (!next.ok) throw new Error("post-event request failed");
const created = await host.request({ ...request, id: "create", revision: 1, method: "project.create", payload: { name: "Demo" } });
if (!created.ok || !created.result.projectId) throw new Error("project create behavior failed");
const upload = await host.request({ ...request, id: "upload", revision: created.revision, method: "asset.beginUpload", payload: { projectId: created.result.projectId, expectedRevision: 0, size: 3, mime: "application/octet-stream", name: "asset.bin" } });
if (!upload.ok || !upload.result.url) throw new Error("asset ticket behavior failed");
const uploaded = await host.requestAsset({ method: "PUT", url: upload.result.url, origin: "https://assets.auvra.local", mime: "application/octet-stream", body: new Uint8Array([1, 2, 3]) });
if (uploaded.status !== 204 || !uploaded.sha256) throw new Error("asset upload behavior failed");
let consumed = false;
try { await host.requestAsset({ method: "PUT", url: upload.result.url, origin: "https://assets.auvra.local", mime: "application/octet-stream", body: new Uint8Array([1, 2, 3]) }); } catch { consumed = true; }
if (!consumed) throw new Error("asset ticket was reusable");
const resolved = await host.request({ ...request, id: "resolve", revision: upload.revision, method: "asset.resolve", payload: { projectId: created.result.projectId, assetId: uploaded.sha256 } });
if (!resolved.ok || !resolved.result.url) throw new Error("asset resolve behavior failed");
const downloaded = await host.requestAsset({ method: "GET", url: resolved.result.url, origin: "https://assets.auvra.local" });
if (downloaded.status !== 200 || downloaded.sha256 !== uploaded.sha256) throw new Error("asset download behavior failed");
const configured = await host.request({ ...request, id: "provider-config", revision: resolved.revision, method: "provider.configure", payload: { providerId: "ollama", expectedSettingsRevision: 0, settings: { enabled: true, routes: [{ capability: "text", modelId: "ollama.default" }, { capability: "commands", modelId: "ollama.default" }], fallbackPolicy: "none", requireCostConfirmation: true, budgets: { perJobMicroUsd: 0, dailyMicroUsd: 0, monthlyMicroUsd: 0 } } } });
if (!configured.ok || configured.result.kind !== "provider.status" || configured.result.settingsRevision !== 1) throw new Error("provider configuration behavior failed");
const inferred = await host.request({ ...request, id: "infer", revision: configured.revision, method: "inference.submit", payload: { projectId: created.result.projectId, expectedRevision: 1, providerId: "ollama", modelId: "ollama.default", capability: "text", route: "local" } });
if (!inferred.ok || inferred.result.kind !== "inference.submit" || inferred.result.job.outputText !== "deterministic fake response") throw new Error("provider inference behavior failed");
const listedJobs = await host.request({ ...request, id: "jobs", revision: inferred.revision, method: "inference.list", payload: { projectId: created.result.projectId } });
if (!listedJobs.ok || listedJobs.result.kind !== "inference.list" || listedJobs.result.jobs.length !== 1) throw new Error("project-scoped provider job listing failed");
const commandJob = await host.request({ ...request, id: "command-job", revision: listedJobs.revision, method: "inference.submit", payload: { projectId: created.result.projectId, expectedRevision: 1, providerId: "ollama", modelId: "ollama.default", capability: "commands", route: "local", input: "add a label" } });
if (!commandJob.ok || commandJob.result.kind !== "inference.submit" || !commandJob.result.job.proposalId) throw new Error("command job behavior failed");
const proposal = await host.request({ ...request, id: "command-preview", revision: commandJob.revision, method: "command.preview", payload: { projectId: created.result.projectId, expectedRevision: 1, jobId: commandJob.result.job.jobId } });
if (!proposal.ok || proposal.result.kind !== "command.preview") throw new Error("command preview behavior failed");
const approved = await host.request({ ...request, id: "command-approve", revision: proposal.revision, method: "command.approve", payload: { projectId: created.result.projectId, expectedRevision: 1, proposalId: proposal.result.proposalId } });
if (!approved.ok || approved.result.kind !== "command.approve" || !approved.result.transactionId) throw new Error("command approval behavior failed");
const undone = await host.request({ ...request, id: "command-undo", revision: approved.revision, method: "command.undo", payload: { projectId: created.result.projectId, expectedRevision: 2, transactionId: approved.result.transactionId } });
if (!undone.ok || undone.result.kind !== "command.undo") throw new Error("command undo behavior failed");
const wrongKind = await host.request({ protocol: "auvra.host/1", type: "session", session: host.session, revision: 1, status: "active" });
if (wrongKind.ok || wrongKind.error.code !== "invalid_request") throw new Error("non-request message did not fail closed");
const blockedEngineApply = await host.request({ ...request, id: "engine-project-owned", revision: host.currentRevision, method: "engine.applyChanges", payload: { expectedRevision: 0, entities: [] } });
if (blockedEngineApply.ok || blockedEngineApply.error.code !== "unsupported_capability") throw new Error("fake host allowed a competing native project mutation");
const engineHost = new FakeHost("fake-engine-session");
const engineCall = (id, method, payload = {}) => engineHost.request({ ...request, session: engineHost.session, id, revision: engineHost.currentRevision, method, payload });
const engineCaps = await engineCall("engine-caps", "host.getCapabilities");
if (!engineCaps.ok || engineCaps.result.engineMethods.length !== 8 || engineCaps.result.engineMethods[7] !== "engine.recover") throw new Error("engine capability list is incomplete");
const engineStatus = await engineCall("engine-status", "engine.getStatus");
if (!engineStatus.ok || engineStatus.result.kind !== "engine.status" || engineStatus.result.protocol !== "auvra.native/1") throw new Error("engine status behavior failed");
if (engineStatus.result.featureCapabilities?.length !== 16 || engineStatus.result.dockSupport !== "unsupported" || engineStatus.result.dockActive !== false) throw new Error("engine feature or dock capability behavior failed");
const engineSnapshot = await engineCall("engine-snapshot", "engine.getSnapshot");
if (!engineSnapshot.ok || engineSnapshot.result.kind !== "engine.snapshot") throw new Error("engine snapshot behavior failed");
const engineApply = await engineCall("engine-apply", "engine.applyChanges", { expectedRevision: 0, entities: [{ id: "reference", position: [0, 0, 0], color: [0.2, 0.6, 1, 1] }] });
if (!engineApply.ok || engineApply.result.kind !== "engine.applyChanges" || engineApply.result.worldRevision !== 1) throw new Error("engine apply behavior failed");
const engineConflict = await engineCall("engine-conflict", "engine.applyChanges", { expectedRevision: 0, entities: [] });
if (engineConflict.ok || engineConflict.error.code !== "revision_conflict") throw new Error("engine revision conflict was accepted");
const engineOpen = await engineCall("engine-open", "engine.openViewport", { width: 640, height: 480, title: "Auvra Native Viewport" });
if (!engineOpen.ok || engineOpen.result.viewport !== "open") throw new Error("engine viewport open behavior failed");
const engineClose = await engineCall("engine-close", "engine.closeViewport");
if (!engineClose.ok || engineClose.result.viewport !== "closed") throw new Error("engine viewport close behavior failed");
const engineRender = await engineCall("engine-render", "engine.renderReference", { sceneId: "basic", width: 64, height: 64 });
if (!engineRender.ok || engineRender.result.kind !== "engine.renderReference" || engineRender.result.referenceScene !== "basic" || engineRender.result.referenceVersion !== 1 || engineRender.result.signature.length < 16) throw new Error("engine reference render behavior failed");
const engineMetrics = await engineCall("engine-metrics", "engine.getMetrics");
if (!engineMetrics.ok || engineMetrics.result.kind !== "engine.metrics" || !engineMetrics.result.metrics) throw new Error("engine metrics behavior failed");
const engineRecover = await engineCall("engine-recover", "engine.recover");
if (!engineRecover.ok || engineRecover.result.kind !== "engine.recover") throw new Error("engine recovery behavior failed");
const engineReloadSnapshot = await engineCall("engine-reload", "engine.getSnapshot");
if (!engineReloadSnapshot.ok || engineReloadSnapshot.result.entities.length !== 1 || engineReloadSnapshot.result.worldRevision !== 1) throw new Error("engine world did not survive editor reload");
const interleavedBackend = new FakeHost("interleaved-session");
const sentRevisions = [];
const sharedHost = {
  get session() { return interleavedBackend.session; },
  get currentRevision() { return interleavedBackend.currentRevision; },
  request(request) { sentRevisions.push({ id: request.id, revision: request.revision, method: request.method }); return interleavedBackend.request(request); },
  subscribe(listener) { return interleavedBackend.subscribe(listener); },
};
const interleavedProject = new ProjectService(sharedHost);
const interleavedEngine = new NativeEngineService();
(interleavedEngine as unknown as { host: typeof sharedHost }).host = sharedHost;
await interleavedEngine.openViewport();
await interleavedProject.create("Interleaved");
await interleavedEngine.closeViewport();
await interleavedProject.applyChanges([{ domain: "objects", operation: "upsert", id: "object-1", value: { id: "object-1" } }]);
if (sentRevisions.map(({ revision }) => revision).join(",") !== "0,1,2,3") throw new Error("interleaved services sent a stale host revision");
console.log("fake host behavior passed");
` , "utf8");
  let buildError;
  try {
    buildSync({
      entryPoints: [resolve(temp, "run.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: resolve(temp, "run.mjs"),
    });
  } catch (error) {
    buildError = error;
  }
  if (buildError) {
    await rm(temp, { recursive: true, force: true });
    process.stderr.write(`${buildError?.message || buildError || "fake host bundle failed"}\n`);
    process.exit(1);
  }
  const command = process.platform === "win32" ? "node.exe" : "node";
  const result = spawnSync(command, [resolve(temp, "run.mjs")], { encoding: "utf8" });
  await rm(temp, { recursive: true, force: true });
  if (result.status !== 0) { process.stderr.write(result.stderr || result.stdout || "fake host behavior failed\n"); process.exit(result.status ?? 1); }
  process.stdout.write(result.stdout);
}
