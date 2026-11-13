import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const project = fileURLToPath(new URL('../../', import.meta.url));
const docs = path.resolve(project, '../docs');
const evidenceFile = path.join(docs, 'texture-suite-m0-gpu-captures.json');
const matrixFile = path.join(docs, 'texture-suite-m0-gpu-matrix.md');
const hashFile = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const formats = { bc4: 'BC4 signed', bc5: 'BC5', bc7: 'BC7', etc2: 'ETC2 RGB8', etc2a: 'ETC2 RGBA8 EAC', astc: 'ASTC 4×4' };
const unknown = 'not-tested';

async function importCapture([backend, directory, head, run, artifact, os]) {
  if (!['webgl2', 'webgpu'].includes(backend) || !directory || !/^[a-f0-9]{40}$/.test(head) ||
      !/^\d+$/.test(run) || !/^\d+$/.test(artifact) || !os) {
    throw new Error('Use capture <webgl2|webgpu> <extracted artifact directory> <workflow head SHA> <run ID> <artifact ID> <runner OS>. Check out its visual references first.');
  }
  const scene = (await readJson(path.join(directory, 'numbers.json')))['texture-graph'];
  const compression = scene?.materialCompression;
  if (compression?.backend !== backend) throw new Error('Missing or mismatched compression evidence');
  for (const key of Object.keys(formats)) {
    const result = compression.formats[key];
    if (!result || !result.feature || result.status !== (result.supported ? 'verified' : 'not-tested')) {
      throw new Error('Missing or unsuccessful compression fixture: ' + key);
    }
  }
  const cook = scene.graphCook;
  if (!cook || !(cook.pixels > 0) || typeof cook.fallback !== 'boolean' ||
      cook.backend !== (cook.fallback ? 'webgl2' : backend)) throw new Error('Missing or inconsistent graph cook');
  const bc1 = scene.bc1Parity;
  if (bc1 && !['verified', 'not-tested'].includes(bc1.status)) throw new Error('Unsuccessful BC1 fixture');
  if (bc1?.status === 'verified' && !(bc1.webgpuBC && bc1.webgl2S3TC)) throw new Error('Missing BC1 flags');
  const reference = path.join(project, 'tests/visual/references', backend === 'webgpu' ? 'webgpu' : '', 'texture-graph.png');
  const snapshot = {
    backend, os, workflowHead: head, artifact: 'https://github.com/dovvnloading/Auvra/actions/runs/' + run + '/artifacts/' + artifact,
    capture: scene.provenance ?? null, referenceSha256: await hashFile(reference),
    screenshotSha256: await hashFile(path.join(directory, 'texture-graph.actual.png')),
    cook: { backend: cook.backend, fallback: cook.fallback, pixels: cook.pixels }, compression,
    bc1: bc1 ?? null, deviceLoss: scene.deviceLoss ?? null,
  };
  if (snapshot.capture && snapshot.capture.referenceSha256 !== snapshot.referenceSha256) {
    throw new Error('The local visual reference differs from the one used in the capture');
  }
  if (snapshot.capture && snapshot.capture.screenshotSha256 !== snapshot.screenshotSha256) {
    throw new Error('The artifact screenshot differs from the one recorded in the capture');
  }
  const entries = await readJson(evidenceFile);
  entries[backend] = snapshot;
  await writeFile(evidenceFile, JSON.stringify(entries, null, 2) + '\n');
}

async function generate() {
  const { outputFiles } = await build({
    stdin: { contents: "export { TEXTURE_NODE_DEFINITIONS, NODE_CATEGORY_ORDER, SUBGRAPH_PLACEHOLDER } from './texturing/graph/registry';", resolveDir: project },
    bundle: true, format: 'esm', platform: 'browser', write: false,
  });
  const registry = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'));
  const definitions = [...registry.TEXTURE_NODE_DEFINITIONS, registry.SUBGRAPH_PLACEHOLDER];
  const byCategory = Map.groupBy(definitions, node => node.category);
  if (new Set(definitions.map(node => node.type)).size !== definitions.length ||
      [...byCategory.keys()].some(category => !registry.NODE_CATEGORY_ORDER.includes(category))) {
    throw new Error('Duplicate node type or missing category in the registry');
  }
  const { webgl2: gl, webgpu: gpu } = await readJson(evidenceFile);
  const lines = [
    '# Texture suite GPU capability matrix', '',
    'Generated from the texture graph registry and the two archived software-adapter captures below. The editor and player WebGL2 columns share the WebGL2 texture evaluator. The player WebGPU column records the same WebGPU evaluator the player calls. These fixture rows establish individual GPU operations. The authoring UI, standalone player and native integration have separate rows.', '',
    'A verified cell requires a completed fixture on the stated backend. Fallback records a successful cook on a different backend. Unsupported records an explicit implementation rejection. Not-tested identifies an unmeasured path or configuration.', '',
    '## GPU operations and application flows', '',
    '| Fixture or flow | Editor WebGL2 | Player WebGL2 | Player WebGPU | Native scaffold |', '|---|---|---|---|---|',
  ];
  const row = (label, webgl = unknown, webgpu = unknown) => lines.push('| ' + [label, webgl, webgl, webgpu, unknown].join(' | ') + ' |');
  const graphStatus = evidence => evidence.cook.fallback ? 'fallback' : 'verified';
  row('512² brick graph with Perlin, tiles, multiply blend, height-to-normal and graph-mode pixel processor', graphStatus(gl), graphStatus(gpu));
  for (const [key, label] of Object.entries(formats)) {
    row('Saved ' + label + ' · 64 sampled pixels', gl.compression.formats[key].status, gpu.compression.formats[key].status);
  }
  const pairedBc1 = gpu.bc1?.status === 'verified' ? 'verified' : unknown;
  row('BC1 red/green stripes · paired WebGL2 and WebGPU readback', pairedBc1, pairedBc1);
  // Both paired sampler checks must succeed before the WebGPU scene can report a native cook.
  const paired = gpu.cook.fallback ? unknown : 'verified';
  row('Instanced scatter · four layering modes and wrapped copies', paired, paired);
  row('Applied Paint snapshot · base colour, roughness and metallic samples', paired, paired);
  row('Code-mode GLSL with a user-defined struct · explicit translator rejection', unknown, 'unsupported');
  row('Pooled target reuse and explicit device destruction/reacquisition · red/green pixels', unknown, gpu.deviceLoss?.status === 'verified' ? 'verified' : unknown);
  for (const flow of [
    'Author and repaint layers, masks and multiple UDIM tiles in the editor',
    'Mesh baking, scan capture and photometric reconstruction',
    'Publish graph outputs, export a painted GLB and reopen the exported model',
    'Play a standalone project with painted material overrides or curve subgraphs',
    'Cross-renderer sampled coat, sheen, anisotropy, specular and thin-film parity',
    'Cancel a live cook, edit a source image and verify the next presented frame',
  ]) row(flow);
  lines.push('', '## Registry coverage', '', 'The registry contains ' + definitions.length + ' node types across ' + byCategory.size + ' families, including the dynamically resolved subgraph. Each row asks whether the entire family has device-backed coverage. The table above records the narrower configurations that have been measured.', '',
    '| Family and registered node types | Editor WebGL2 | Player WebGL2 | Player WebGPU | Native scaffold |', '|---|---|---|---|---|');
  for (const category of registry.NODE_CATEGORY_ORDER) {
    const ids = byCategory.get(category).map(node => node.type).sort();
    row('**' + category + '** · ' + ids.map(id => '`' + id + '`').join(', '));
  }
  lines.push('', '## Captures', '');
  for (const evidence of [gl, gpu]) {
    const c = evidence.compression, p = evidence.capture;
    lines.push('### ' + evidence.backend, '',
      '- ' + evidence.os + ' · ' + [c.vendor, c.renderer, c.architecture, c.device].filter(Boolean).join(' · '),
      '- Browser ' + (p?.browser || 'unavailable in this capture') + '. Chromium driver inventory ' + (p?.browserDevices?.map(d => [d.device, d.driverVendor, d.driverVersion].filter(Boolean).join(' / ')).filter(Boolean).join(', ') || 'unavailable in this capture') + '.',
      '- Workflow head `' + evidence.workflowHead + '`. Checkout ' + (p?.sourceCommit ? '`' + p.sourceCommit + '`' : 'unrecorded') + '. [CI artifact](' + evidence.artifact + ')',
      '- Reference PNG SHA-256 `' + evidence.referenceSha256 + '`. Screenshot SHA-256 `' + evidence.screenshotSha256 + '`.',
      '- Compression flags ' + [...new Set(Object.values(c.formats).map(result => '`' + result.feature + '` (' + result.supported + ')'))].join(', ') + '.', '');
  }
  lines.push('## Reproduce', '', 'From `fbx-viewer (1)`, run `npm ci` and `npm run texture:matrix`. Use `npm run texture:matrix -- --check` to detect drift. To replace a capture, first check out the visual reference used in that run and extract its artifact. Run `npm run texture:matrix -- capture <backend> <directory> <workflow-head-sha> <run-id> <artifact-id> <runner-os>` for each backend, then regenerate. Keep a failed run for diagnosis and retain the last successful evidence.', '',
    'Fixture details, tolerances and remaining hardware gates are in the [GPU capability evidence](texture-suite-m0-gpu-capability-evidence.md). Adapter flags and sampled results are in the [capture records](texture-suite-m0-gpu-captures.json).', '');
  return lines.join('\n');
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'capture') await importCapture(args);
else if (mode && mode !== '--check') throw new Error('Expected --check, capture, or no arguments');
const markdown = await generate();
if (mode === '--check') {
  if (markdown !== await readFile(matrixFile, 'utf8')) throw new Error('GPU matrix is stale. Run npm run texture:matrix.');
} else await writeFile(matrixFile, markdown);
