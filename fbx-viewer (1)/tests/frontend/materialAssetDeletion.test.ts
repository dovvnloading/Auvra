import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // Legacy IndexedDB is opened (read-only) when utils/db.ts is imported.
  (globalThis as { indexedDB?: unknown }).indexedDB = { open: () => ({}) };
  return { status: { projectId: 'project-a' as string | null, readOnly: false } };
});

vi.mock('../../utils/projectService', () => ({
  projectService: {
    getStatus: () => ({ ...mocks.status }),
    assertWritable: () => undefined,
    applyChanges: vi.fn(),
    getSnapshotAll: vi.fn(),
  },
}));

import { dbOperations, withoutMaterialOverrideAsset } from '../../utils/db';
import { projectService } from '../../utils/projectService';
import { createMaterialGraph, type MaterialGraph } from '../../runtime/materials/materialGraph';
import { materialAssetDocument, materialLibrary, withoutGraphTexture } from '../../runtime/materials/materialLibrary';
import { boundMaterialGraph } from '../../runtime/materials/graphMaterial';

const committedChanges = () => vi.mocked(projectService.applyChanges).mock.calls.map(([changes]) => changes);

/** A graph whose base colour samples `textureId` and whose normal reads `normalId`. */
const texturedGraph = (textureId: string, normalId: string): MaterialGraph => {
  const graph = createMaterialGraph();
  return {
    nodes: [
      ...graph.nodes,
      { id: 'albedo', type: 'texture', x: 0, y: 0, params: { texture: textureId } },
      { id: 'bumps', type: 'normalMap', x: 0, y: 0, params: { texture: normalId, strength: 1 } },
    ],
    links: [
      { fromNode: 'albedo', fromOutput: 'rgb', toNode: graph.nodes[0].id, toInput: 'baseColor' },
      { fromNode: 'bumps', fromOutput: 'out', toNode: graph.nodes[0].id, toInput: 'normal' },
    ],
  };
};

beforeEach(() => {
  vi.mocked(projectService.applyChanges).mockReset();
  vi.mocked(projectService.getSnapshotAll).mockReset();
  materialLibrary.replaceAll([]);
});

describe('deleting a material asset', () => {
  it('clears it from the model materials it shades in the same batch', async () => {
    const crate = { id: 'crate', name: 'Crate', materialOverrides: { Wood: { materialId: 'teal', roughness: 0.3 }, Metal: { materialId: 'other' } } };
    const rock = { id: 'rock', name: 'Rock', materialOverrides: { Stone: { materialId: 'teal' } } };
    const tree = { id: 'tree', name: 'Tree' };
    vi.mocked(projectService.getSnapshotAll).mockResolvedValue({ revision: 1, domains: { models: [crate, rock, tree] } } as never);

    await dbOperations.deleteMaterialAsset('teal');

    expect(committedChanges()).toEqual([[
      { domain: 'materials', operation: 'remove', id: 'teal' },
      { domain: 'models', operation: 'upsert', id: 'crate', value: { ...crate, materialOverrides: { Wood: { roughness: 0.3 }, Metal: { materialId: 'other' } } } },
      { domain: 'models', operation: 'upsert', id: 'rock', value: { ...rock, materialOverrides: {} } },
    ]]);
  });

  it('keeps overrides that do not use it as they are', () => {
    const overrides = { Wood: { materialId: 'other' } };
    expect(withoutMaterialOverrideAsset(overrides, 'teal')).toBe(overrides);
  });
});

describe('deleting a texture a material graph samples', () => {
  it('clears it from the graph and the stored texture list in the same batch', async () => {
    const graph = texturedGraph('bricks', 'bricks-normal');
    const stored = materialAssetDocument({ id: 'wall', name: 'Wall', graph });
    vi.mocked(projectService.getSnapshotAll).mockResolvedValue({ revision: 1, domains: { textures: [{ id: 'bricks' }], materials: [stored] } } as never);

    await dbOperations.deleteTexture('bricks');

    const [[removal, update]] = committedChanges();
    expect(removal).toEqual({ domain: 'textures', operation: 'remove', id: 'bricks' });
    expect(update).toMatchObject({ domain: 'materials', operation: 'upsert', id: 'wall' });
    const value = update.value as typeof stored;
    expect(value.textureIds).toEqual(['bricks-normal']);
    expect(value.graph.nodes.find(node => node.id === 'albedo')?.params.texture).toBe('');
    expect(value.graph.nodes.find(node => node.id === 'bumps')?.params.texture).toBe('bricks-normal');
    expect(value.graph.links).toEqual(graph.links);
  });

  it('leaves graphs that do not sample it alone', () => {
    const graph = texturedGraph('bricks', 'bricks-normal');
    expect(withoutGraphTexture(graph, 'grass')).toBe(graph);
  });

  it('clears it from the open library so the next save does not name it again', () => {
    materialLibrary.replaceAll([{ id: 'wall', name: 'Wall', graph: texturedGraph('bricks', 'bricks-normal') }]);
    const material = new THREE.MeshStandardMaterial();
    materialLibrary.assign(material, 'wall');

    materialLibrary.forgetTexture('bricks');

    const asset = materialLibrary.get('wall')!;
    expect(materialAssetDocument(asset).textureIds).toEqual(['bricks-normal']);
    expect(boundMaterialGraph(material)?.nodes.find(node => node.id === 'albedo')?.params.texture).toBe('');
  });
});
