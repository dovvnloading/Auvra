import { describe, expect, it } from 'vitest';
import {
  compileRenderGraph,
  RenderGraphValidationError,
  type RenderGraphDescription,
  type RenderGraphErrorCode,
} from '../../renderer/renderGraph';

function expectOutputError(description: RenderGraphDescription, code: RenderGraphErrorCode, resourceId: string): void {
  try {
    compileRenderGraph(description);
    throw new Error('Expected an invalid render graph to fail compilation');
  } catch (error) {
    expect(error).toBeInstanceOf(RenderGraphValidationError);
    expect((error as RenderGraphValidationError).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code, resourceId })]),
    );
  }
}

describe('render graph output validation', () => {
  it('rejects misspelled output IDs instead of silently culling all passes', () => {
    expectOutputError({
      resources: [{ id: 'color', kind: 'texture' }],
      passes: [{ id: 'render', writes: ['color'] }],
      outputs: ['colro'],
    }, 'invalid-resource', 'colro');
  });

  it('rejects a declared output with no producer', () => {
    expectOutputError({
      resources: [{ id: 'color', kind: 'texture' }],
      passes: [],
      outputs: ['color'],
    }, 'missing-producer', 'color');
  });

  it('allows an external output without an internal producer', () => {
    const compiled = compileRenderGraph({
      resources: [{ id: 'backbuffer', kind: 'texture', external: true }],
      passes: [],
      outputs: ['backbuffer'],
    });
    expect(compiled.passes).toEqual([]);
    expect(compiled.culledPasses).toEqual([]);
  });

  it('keeps a valid output producer and its dependencies, but culls unused passes', () => {
    const compiled = compileRenderGraph({
      resources: [
        { id: 'geometry', kind: 'texture' },
        { id: 'color', kind: 'texture' },
        { id: 'unused', kind: 'texture' },
      ],
      passes: [
        { id: 'geometry', writes: ['geometry'] },
        { id: 'shade', reads: ['geometry'], writes: ['color'] },
        { id: 'unused', writes: ['unused'] },
      ],
      outputs: ['color'],
    });
    expect(compiled.passes.map((pass) => pass.id)).toEqual(['geometry', 'shade']);
    expect(compiled.culledPasses).toEqual(['unused']);
  });

  it('keeps optional outputs optional for side-effect-only graphs', () => {
    const compiled = compileRenderGraph({
      resources: [],
      passes: [{ id: 'present', sideEffects: true }],
    });
    expect(compiled.passes.map((pass) => pass.id)).toEqual(['present']);
  });
});
