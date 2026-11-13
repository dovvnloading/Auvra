import { isDeepStrictEqual } from 'node:util';

const phases = ['coldEvalMs', 'coldSyncMs', 'encodeMs', 'cachedEvalMs', 'editEvalMs', 'editSyncMs'];

export function validateTextureSample(scene, renderer, resolution) {
  const cook = scene?.textureCook;
  if (!cook) throw new Error('Missing texture graph cook');
  if (cook.backend !== renderer || scene.textureCookProblem) {
    throw new Error(`Requested ${renderer}, cooked on ${cook.backend}: ${scene.textureCookProblem ?? 'unexpected fallback'}`);
  }
  if (cook.resolution !== resolution) throw new Error(`Expected ${resolution}px, got ${cook.resolution}px`);
  if (cook.firstNodes !== 5 || cook.cachedNodes !== 0 || cook.editNodes !== 4) {
    throw new Error(`Proof graph cold/cache/edit node counts must be 5/0/4, got ${cook.firstNodes}/${cook.cachedNodes}/${cook.editNodes}`);
  }
  if (![cook.graphSha256, cook.editedGraphSha256].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
      || cook.graphSha256 === cook.editedGraphSha256) throw new Error('Missing or unchanged proof graph hashes');
  for (const phase of phases) {
    if (!Number.isFinite(cook[phase]) || cook[phase] < 0) throw new Error(`Invalid duration for ${phase}`);
  }
  const memory = cook.allocationBytes;
  if (!memory || ![memory.baseline, memory.peak, memory.end].every(bytes => Number.isSafeInteger(bytes) && bytes >= 0)
      || memory.peak < Math.max(memory.baseline, memory.end)) throw new Error('Invalid allocation byte counts');
}

export function summarizeTextureSamples(results) {
  if (!results.length) throw new Error('No texture benchmark samples');
  let configuration;
  const times = Object.fromEntries(phases.map(phase => [phase, []]));
  for (const [index, numbers] of results.entries()) {
    const scene = numbers['texture-graph'];
    const { createdAt, ...metadata } = numbers._benchmark;
    validateTextureSample(scene, metadata.rendererRequested, metadata.resolution);
    const cook = scene.textureCook;
    const current = { ...metadata, graphSha256: cook.graphSha256, editedGraphSha256: cook.editedGraphSha256,
      backend: cook.backend, adapter: cook.adapter, allocationScope: cook.allocationBytes.scope };
    if (configuration && !isDeepStrictEqual(configuration, current)) {
      throw new Error(`Sample ${index + 1} has a different benchmark configuration`);
    }
    configuration = current;
    for (const phase of phases) times[phase].push(cook[phase]);
  }
  const summaries = {};
  for (const [phase, values] of Object.entries(times)) {
    values.sort((a, b) => a - b);
    summaries[phase] = { p50: values[Math.ceil(values.length * 0.5) - 1], p95: values[Math.ceil(values.length * 0.95) - 1] };
  }
  return { samples: results.length, method: 'nearest rank', configuration, phases: summaries };
}
