import { describe, expect, it, vi } from 'vitest';
import type { TerrainData, TerrainEditLayer } from '../../types';
import {
  activeEditLayer, editLayerBlock, externalizeEditLayers, hasPendingEditLayers, isEditLayerPending, withEditLayerChange, withEditLayerMerged, withoutEditLayer, withStroke,
} from '../../components/Environment/Terrain/terrainEditLayers';

const layer = (changes: Partial<TerrainEditLayer> = {}): TerrainEditLayer => ({ id: 'a', name: 'Hills', visible: true, locked: false, opacity: 1, ...changes });

// A grid of one cell: four samples.
const terrain = (changes: Partial<TerrainData> = {}): TerrainData => ({
  resolution: 1, width: 10, depth: 10, heights: [1, 1, 1, 1], editLayers: [layer()], activeEditLayer: 'a', ...changes,
});

describe('terrain edit layers', () => {
  it('sends a stroke straight to the ground with no layer chosen', () => {
    const plain = terrain({ activeEditLayer: undefined });
    const next = withStroke(plain, [1, 1, 1, 1], [2, 1, 1, 1]);
    expect(next.heights).toEqual([2, 1, 1, 1]);
    expect(next.editLayers?.[0].deltas).toBeUndefined();
  });

  it('remembers what a stroke changed in the chosen layer, and adds up strokes', () => {
    const first = withStroke(terrain(), [1, 1, 1, 1], [3, 1, 1, 1]);
    expect(first.editLayers?.[0].deltas).toEqual([2, 0, 0, 0]);
    const second = withStroke(first, [3, 1, 1, 1], [3, 5, 1, 1]);
    expect(second.editLayers?.[0].deltas).toEqual([2, 4, 0, 0]);
    expect(second.heights).toEqual([3, 5, 1, 1]);
  });

  it('hiding a layer takes its work off, and showing it puts it back', () => {
    const painted = withStroke(terrain(), [1, 1, 1, 1], [3, 1, 1, 1]);
    const hidden = withEditLayerChange(painted, 'a', { visible: false });
    expect(hidden.heights).toEqual([1, 1, 1, 1]);
    const shown = withEditLayerChange(hidden, 'a', { visible: true });
    expect(shown.heights).toEqual([3, 1, 1, 1]);
  });

  it('keeps later work on other layers when one is hidden', () => {
    const two = terrain({ editLayers: [layer(), layer({ id: 'b', name: 'Paths' })] });
    const first = withStroke(two, [1, 1, 1, 1], [3, 1, 1, 1]);
    const second = withStroke({ ...first, activeEditLayer: 'b' }, [3, 1, 1, 1], [4, 2, 1, 1]);
    const hidden = withEditLayerChange(second, 'a', { visible: false });
    expect(hidden.heights).toEqual([2, 2, 1, 1]);
  });

  it('fades a layer by its strength, and a stroke on a faded layer fades with it', () => {
    const painted = withStroke(terrain(), [1, 1, 1, 1], [3, 1, 1, 1]);
    const half = withEditLayerChange(painted, 'a', { opacity: 0.5 });
    expect(half.heights).toEqual([2, 1, 1, 1]);
    const stroke = withStroke(half, [2, 1, 1, 1], [3, 1, 1, 1]);
    // One metre at half strength is two metres of the layer's own.
    expect(stroke.editLayers?.[0].deltas?.[0]).toBe(4);
    const full = withEditLayerChange(stroke, 'a', { opacity: 1 });
    expect(full.heights?.[0]).toBe(5);
  });

  it('removing a layer takes its work with it, and merging keeps it', () => {
    const painted = withStroke(terrain(), [1, 1, 1, 1], [3, 1, 1, 1]);
    const removed = withoutEditLayer(painted, 'a');
    expect(removed.heights).toEqual([1, 1, 1, 1]);
    expect(removed.editLayers).toBeUndefined();
    expect(removed.activeEditLayer).toBeUndefined();
    const merged = withEditLayerMerged(painted, 'a');
    expect(merged.heights).toEqual([3, 1, 1, 1]);
    expect(merged.editLayers).toBeUndefined();
  });

  it('says why a stroke cannot go in', () => {
    expect(editLayerBlock(terrain())).toBeNull();
    expect(editLayerBlock(terrain({ editLayers: [layer({ locked: true })] }))).toMatch(/locked/);
    expect(editLayerBlock(terrain({ editLayers: [layer({ visible: false })] }))).toMatch(/hidden/);
    expect(editLayerBlock(terrain({ editLayers: [layer({ opacity: 0 })] }))).toMatch(/faded/);
    expect(editLayerBlock(terrain({ activeEditLayer: undefined }))).toBeNull();
    expect(activeEditLayer(terrain())?.id).toBe('a');
  });

  it('stores changes as an asset, and waits for them to load before editing', async () => {
    const upload = vi.fn(async () => 'c'.repeat(64));
    const painted = withStroke(terrain(), [1, 1, 1, 1], [3, 1, 1, 1]);
    const stored = await externalizeEditLayers(painted, upload, new Set());
    expect(upload).toHaveBeenCalledTimes(1);
    const saved = stored.editLayers![0];
    expect(saved.deltas).toBeUndefined();
    expect(saved.heightfield).toEqual({ assetId: 'c'.repeat(64), encoding: 'float32le', columns: 2, rows: 2 });
    expect(isEditLayerPending(saved)).toBe(true);
    expect(hasPendingEditLayers(stored)).toBe(true);
    expect(editLayerBlock(stored)).toMatch(/loading/);
  });

  it('uploads again unless the document being replaced still names the asset', async () => {
    const upload = vi.fn(async () => 'd'.repeat(64));
    const painted = withStroke(terrain(), [1, 1, 1, 1], [3, 1, 1, 1]);
    await externalizeEditLayers(painted, upload, new Set());
    await externalizeEditLayers(painted, upload, new Set(['d'.repeat(64)]));
    expect(upload).toHaveBeenCalledTimes(1);
    await externalizeEditLayers(painted, upload, new Set());
    expect(upload).toHaveBeenCalledTimes(2);
  });
});
