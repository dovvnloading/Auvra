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
for (const vector of vectors.valid) if (!validate(vector.message)) throw new Error(`valid vector rejected: ${vector.name}`);
for (const vector of vectors.invalid) if (validate(vector.message)) throw new Error(`invalid vector accepted: ${vector.name}`);
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
  await writeFile(resolve(temp, "run.ts"), `import { FakeHost } from "./host/fakeHost.ts";
const host = new FakeHost();
const request = { protocol: "auvra.host/1", type: "request", id: "r1", session: host.session, revision: 0, method: "host.ping", payload: {} };
const reply = await host.request(request);
if (!reply.ok || !reply.result.pong) throw new Error("ping behavior failed");
const event = host.emitRevision();
if (event.revision !== 1) throw new Error("revision event failed");
const next = await host.request({ ...request, revision: 1 });
if (!next.ok) throw new Error("post-event request failed");
const wrongKind = await host.request({ protocol: "auvra.host/1", type: "session", session: host.session, revision: 1, status: "active" });
if (wrongKind.ok || wrongKind.error.code !== "invalid_request") throw new Error("non-request message did not fail closed");
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
