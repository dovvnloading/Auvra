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
    uploadAsset: vi.fn(),
  },
}));

import { dbOperations } from '../../utils/db';
import { projectService } from '../../utils/projectService';
import { withPaintedBaseMap, withoutPaintedBaseMaps } from '../../utils/materialOverrides';

beforeEach(() => {
  vi.mocked(projectService.applyChanges).mockReset();
  vi.mocked(projectService.getSnapshotAll).mockReset();
  vi.mocked(projectService.uploadAsset).mockReset();
});

describe('a picture the mask tool puts on a model', () => {
  it('is kept as a texture and becomes the painted base map of the materials\' overrides, not an older texture override', async () => {
    const robot = {
      id: 'robot', name: 'Robot', assetId: 'a'.repeat(64),
      textureOverrides: { Body: 'older', Visor: 'older' },
      materialOverrides: { Body: { roughness: 0.4 }, Arm: { normalTextureId: 'bumps' } },
    };
    vi.mocked(projectService.uploadAsset).mockResolvedValue('picture');
    vi.mocked(projectService.getSnapshotAll).mockResolvedValue({ revision: 3, domains: { models: [robot] } } as never);

    const textureId = await dbOperations.addModelTextureOverride('robot', ['Body', 'Arm'], new File(['png'], 'paint.png'), { width: 8, height: 8 });

    expect(textureId).toBe('picture');
    expect(vi.mocked(projectService.applyChanges).mock.calls).toEqual([[[
      { domain: 'textures', operation: 'upsert', id: 'picture', value: { id: 'picture', name: 'paint.png', assetId: 'picture', dimensions: { width: 8, height: 8 } } },
      { domain: 'models', operation: 'upsert', id: 'robot', value: {
        ...robot,
        materialOverrides: {
          Body: { roughness: 0.4, mapTextureId: 'picture', paintedMap: true },
          Arm: { normalTextureId: 'bumps', mapTextureId: 'picture', paintedMap: true },
        },
        textureOverrides: { Visor: 'older' },
      } },
    ]]]);
  });
});

describe('painted base maps', () => {
  it('are put on beside what an override holds, and taken off leaving the rest', () => {
    const painted = withPaintedBaseMap({ Body: { roughness: 0.3 } }, ['Body', 'Visor'], 'picture');
    expect(painted).toEqual({ Body: { roughness: 0.3, mapTextureId: 'picture', paintedMap: true }, Visor: { mapTextureId: 'picture', paintedMap: true } });
    const plain = { Hull: { mapTextureId: 'chosen' } };
    expect(withoutPaintedBaseMaps({ ...painted, ...plain })).toEqual({ Body: { roughness: 0.3 }, ...plain });
    expect(withoutPaintedBaseMaps(plain)).toBe(plain);
  });
});
