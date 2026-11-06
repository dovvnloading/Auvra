import * as THREE from 'three';
import { createElement } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LoadedModelData } from '../../types';

const mocks = vi.hoisted(() => ({
  getSnapshotAll: vi.fn(),
}));

vi.mock('../../utils/projectService', () => ({
  projectService: {
    getStatus: () => ({ projectId: 'project-a', readOnly: false }),
    getSnapshotAll: mocks.getSnapshotAll,
  },
}));

import { MaterialEditor } from '../../components/Tools/MaterialEditor';
import { applyMaterialOverrides, tagOverrideTexture } from '../../utils/materialOverrides';

describe('a map the texture library does not list yet', () => {
  it('takes its name from the project, which keeps it', async () => {
    mocks.getSnapshotAll.mockResolvedValue({ domains: { textures: [{ id: 'mask-picture', name: 'Painted Body.png' }, { id: 'other', name: 'Other' }] } });
    const body = new THREE.MeshStandardMaterial({ name: 'Body', map: new THREE.Texture() });
    const root = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), body));
    const overrides = { Body: { mapTextureId: 'mask-picture', paintedMap: true } };
    applyMaterialOverrides(root, overrides, () => tagOverrideTexture(new THREE.Texture(), 'mask-picture', 'map'));
    const model: LoadedModelData & { materialOverrides?: unknown } = {
      id: 'model-1', name: 'Robot', url: '', object: root, animations: [], category: 'Prop', isPlacedInScene: true, materialOverrides: overrides,
    };
    render(createElement(MaterialEditor, { model, textures: [], onSave: async () => undefined }));
    fireEvent.click(screen.getByRole('button', { name: /Body/ }));
    await waitFor(() => expect(within(screen.getByLabelText('Base map')).getByRole('combobox').textContent).toContain('Painted Body.png'));
    expect(mocks.getSnapshotAll).toHaveBeenCalledTimes(1);
    expect(mocks.getSnapshotAll).toHaveBeenCalledWith('textures');
  });
});
