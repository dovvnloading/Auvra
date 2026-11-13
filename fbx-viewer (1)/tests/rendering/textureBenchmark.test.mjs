import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeTextureSamples, validateTextureSample } from '../../scripts/rendering/textureBenchmark.mjs';

function sample(ms) {
  return {
    _benchmark: { createdAt: new Date(ms).toISOString(), sourceCommit: 'test', resolution: 512,
      rendererRequested: 'webgl2', browserGpuDevices: [{ driverVersion: '1' }] },
    'texture-graph': { textureCookProblem: null, textureCook: { backend: 'webgl2', resolution: 512,
      firstNodes: 5, cachedNodes: 0, editNodes: 4, graphSha256: 'a'.repeat(64), editedGraphSha256: 'b'.repeat(64),
      adapter: { renderer: 'test' }, allocationBytes: { scope: 'WebGL2 cooking context', baseline: 4, peak: 20, end: 10 },
      coldEvalMs: ms, coldSyncMs: ms + 1, encodeMs: ms + 2, cachedEvalMs: 0, editEvalMs: ms + 3, editSyncMs: ms + 4,
    } },
  };
}

test('reports nearest-rank percentiles for each distinct phase, retaining genuine zero durations', () => {
  const results = Array.from({ length: 20 }, (_, i) => sample(20 - i));
  const summary = summarizeTextureSamples(results);
  assert.equal(summary.samples, 20);
  assert.deepEqual(summary.phases.coldEvalMs, { p50: 10, p95: 19 });
  assert.deepEqual(summary.phases.cachedEvalMs, { p50: 0, p95: 0 });
  assert.deepEqual(summary.phases.editSyncMs, { p50: 14, p95: 23 });
});

test('keeps adapter, driver, graph, and commit changes out of a common baseline', () => {
  const set = (key, value) => row => { row['texture-graph'].textureCook[key] = value; };
  for (const change of [set('adapter', { renderer: 'other' }), set('editedGraphSha256', 'c'.repeat(64)),
    row => { row._benchmark.browserGpuDevices[0].driverVersion = '2'; }, row => { row._benchmark.sourceCommit = 'different'; }]) {
    const second = sample(2);
    change(second);
    assert.throws(() => summarizeTextureSamples([sample(1), second]), /different benchmark configuration/);
  }
});

test('rejects a fallback, cache regression, wrong resolution, impossible memory values or invalid phase timings', () => {
  for (const patch of [{ backend: 'webgl2-fallback' }, { editNodes: 5 }, { firstNodes: 4 }, { cachedNodes: 1 },
    { editSyncMs: Infinity }, { encodeMs: -1 }, { resolution: 2048 }, { editedGraphSha256: 'a'.repeat(64) },
    { allocationBytes: { peak: 10, baseline: 12, end: 5 } }]) {
    const scene = sample(1)['texture-graph'];
    Object.assign(scene.textureCook, patch);
    assert.throws(() => validateTextureSample(scene, 'webgl2', 512));
  }
});
