import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImportOptionsDialog, type ImportChoice } from '../../components/UI/Browser/ImportOptionsDialog';
import type { ModelFileReport } from '../../utils/fbxImport/nativeImporter';
import { convertOptionsFor, resolveImportSettings, suggestedImportSettings } from '../../utils/processing/ModelTransforms';

const report = (fields: Partial<ModelFileReport> = {}): ModelFileReport => ({
  format: 'fbx', version: 7700, ascii: false, creator: '', application: 'Maker', upAxis: '+Y', frontAxis: '+Z', metresPerUnit: 0.01, framesPerSecond: 30,
  meshes: 1, triangles: 1000, vertices: 600, skinnedMeshes: 0, blendShapes: 0, meshesWithPolygons: 0, meshesWithoutUvs: 0, meshesWithoutNormals: 0,
  boundsMin: [-50, 0, -20], boundsMax: [50, 180, 20],
  looseMeshes: [], bones: 0, boneNames: [], collisionMeshes: 0, sockets: 0, lodGroups: 0, cameras: 0, lights: 0, materials: 1,
  outputVertices: 0, outputTriangles: 0, tangentsGenerated: 0, tangentsFromFile: 0, partsWithoutTangents: 0, maxInfluences: 0, verticesOverInfluenceLimit: 0, verticesWithoutWeights: 0,
  clips: [], warnings: [],
  ...fields,
});

const PERSON_BONES = ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Head', 'mixamorig:LeftArm', 'mixamorig:RightArm', 'mixamorig:LeftUpLeg', 'mixamorig:RightUpLeg'];

const open = async (read: ModelFileReport | null, props: Partial<React.ComponentProps<typeof ImportOptionsDialog>> = {}) => {
  const onConfirm = vi.fn<(choice: ImportChoice) => void>();
  const onCancel = vi.fn();
  render(<ImportOptionsDialog name="thing.fbx" inspect={async () => read} onConfirm={onConfirm} onCancel={onCancel} {...props} />);
  await waitFor(() => expect(screen.queryByText(/Reading the file/)).toBeNull());
  return { onConfirm, onCancel };
};

describe('what an import starts with', () => {
  it('keeps the size a file says it is', () => {
    expect(suggestedImportSettings(report()).settings.normalize).toBe(false);
    expect(suggestedImportSettings(report()).note).toBeUndefined();
  });

  it('gives a person the file makes a giant a person\'s height, and says so', () => {
    const suggested = suggestedImportSettings(report({ boneNames: PERSON_BONES, boundsMin: [-195, 0, -36], boundsMax: [195, 378, 36] }));
    expect(suggested.settings.normalize).toBe(true);
    // Fitting works on the largest side, here the arm span: this one makes the height 1.8 m.
    expect(suggested.settings.targetSize * 378 / 390).toBeCloseTo(1.8, 2);
    expect(suggested.note).toContain('3.78 m tall');
  });

  it('leaves alone a creature with no person\'s bones, however big', () => {
    expect(suggestedImportSettings(report({ boneNames: ['Root', 'Tail'], boundsMin: [0, 0, 0], boundsMax: [800, 900, 200] })).settings.normalize).toBe(false);
  });

  it('fits a model whose unit cannot be right', () => {
    const suggested = suggestedImportSettings(report({ metresPerUnit: 1, boundsMin: [0, 0, 0], boundsMax: [20000, 100, 100] }));
    expect(suggested.settings).toMatchObject({ normalize: true, targetSize: 2 });
    expect(suggested.note).toContain('20000 m');
  });

  it('leaves out a small loose mesh and measures without it, but keeps a big one', () => {
    const small = report({
      triangles: 14486, looseMeshes: [{ name: 'Icosphere', triangles: 80 }], boneNames: PERSON_BONES,
      boundsMin: [-95, -100, -100], boundsMax: [95, 164, 100], boundsWithoutLooseMin: [-28, 0, -44], boundsWithoutLooseMax: [28, 161, 44],
    });
    const suggested = suggestedImportSettings(small);
    expect(suggested.settings.looseMeshes).toBe(false);
    expect(suggested.settings.normalize).toBe(false);
    expect(suggestedImportSettings(report({ triangles: 1000, looseMeshes: [{ name: 'Prop', triangles: 400 }] })).settings.looseMeshes).toBe(true);
  });

  it('says nothing about loose meshes for a file without any, as older models were read', () => {
    expect(suggestedImportSettings(report()).settings.looseMeshes).toBeUndefined();
  });
});

describe('import settings', () => {
  it('keeps what they say and nothing more', () => {
    expect(resolveImportSettings({ normalize: false, targetSize: 2 })).toEqual({ normalize: false, targetSize: 2 });
    expect(resolveImportSettings({ normalize: false, targetSize: 2, looseMeshes: false, excludedClips: ['Run'], keyThreshold: 0, smoothingAngle: 45 }))
      .toEqual({ normalize: false, targetSize: 2, looseMeshes: false, excludedClips: ['Run'], keyThreshold: 0, smoothingAngle: 45 });
  });

  it('drops what makes no sense', () => {
    const resolved = resolveImportSettings({ normalize: false, targetSize: 2, keyThreshold: -1, smoothingAngle: 500, excludedClips: [] });
    expect(resolved).toEqual({ normalize: false, targetSize: 2 });
  });

  it('read a model the old way when they mention nothing else', () => {
    expect(convertOptionsFor({ normalize: true, targetSize: 5 })).toBeUndefined();
    expect(convertOptionsFor(undefined)).toBeUndefined();
    expect(convertOptionsFor({ normalize: true, targetSize: 5, looseMeshes: false, animation: false })).toEqual({ looseMeshes: false, animation: false });
  });
});

describe('the import dialog', () => {
  it('says what the file holds and how big it comes in', async () => {
    await open(report({ bones: 67, maxInfluences: 8 }));
    expect(screen.getByText(/Maker · FBX 7\.7 · centimetres/)).toBeTruthy();
    expect(screen.getByText(/1,000 triangles/)).toBeTruthy();
    expect(screen.getByText(/67 bones, up to 8 per vertex \(the strongest 4 are kept\)/)).toBeTruthy();
    expect(screen.getByText('Comes in at 1 × 1.8 × 0.4 m')).toBeTruthy();
  });

  it('fits to a size, and shows what that does', async () => {
    const { onConfirm } = await open(report());
    fireEvent.click(screen.getByRole('radio', { name: 'Fit to a size' }));
    fireEvent.change(screen.getByLabelText('Target size'), { target: { value: '3.6' } });
    expect(screen.getByText('Comes in at 2 × 3.6 × 0.8 m')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(onConfirm.mock.calls[0][0].settings).toEqual({ normalize: true, targetSize: 3.6 });
  });

  it('will not import at a size that makes no sense', async () => {
    await open(report());
    fireEvent.click(screen.getByRole('radio', { name: 'Fit to a size' }));
    fireEvent.change(screen.getByLabelText('Target size'), { target: { value: '-1' } });
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('tells why a person starts at a person\'s height', async () => {
    await open(report({ boneNames: PERSON_BONES, boundsMin: [-195, 0, -36], boundsMax: [195, 378, 36] }));
    expect(screen.getByText(/The file makes this character 3\.78 m tall, so it is set to 1\.8 m\./)).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Fit to a size' }).getAttribute('aria-checked')).toBe('true');
  });

  it('offers to keep a loose mesh, which comes out by default', async () => {
    const { onConfirm } = await open(report({
      triangles: 14486, looseMeshes: [{ name: 'Icosphere', triangles: 80 }],
      boundsMin: [-95, -100, -100], boundsMax: [95, 164, 100], boundsWithoutLooseMin: [-28, 0, -44], boundsWithoutLooseMax: [28, 161, 44],
    }));
    expect(screen.getByText(/Icosphere \(80 triangles\), outside the skeleton/)).toBeTruthy();
    expect(screen.getByText('Comes in at 0.56 × 1.61 × 0.88 m')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(onConfirm.mock.calls[0][0].settings.looseMeshes).toBe(false);
  });

  it('measures with a loose mesh once it is kept', async () => {
    await open(report({
      triangles: 14486, looseMeshes: [{ name: 'Icosphere', triangles: 80 }],
      boundsMin: [-95, -100, -100], boundsMax: [95, 164, 100], boundsWithoutLooseMin: [-28, 0, -44], boundsWithoutLooseMax: [28, 161, 44],
    }));
    fireEvent.click(screen.getByLabelText('Keep meshes outside the skeleton'));
    expect(screen.getByText('Comes in at 1.9 × 2.64 × 2 m')).toBeTruthy();
  });

  it('brings in the clips that are ticked', async () => {
    const clips = [{ name: 'Armature|Walk', duration: 1, start: 0, layers: 1 }, { name: 'Armature|Run', duration: 0.5, start: 0, layers: 1 }];
    const { onConfirm } = await open(report({ clips }));
    fireEvent.click(screen.getByLabelText('Import Run'));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(onConfirm.mock.calls[0][0].settings.excludedClips).toEqual(['Armature|Run']);
  });

  it('leaves animation out altogether when no clip is ticked', async () => {
    const clips = [{ name: 'Walk', duration: 1, start: 0, layers: 1 }, { name: 'Run', duration: 0.5, start: 0, layers: 1 }];
    const { onConfirm } = await open(report({ clips }));
    fireEvent.click(screen.getByRole('button', { name: 'None' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const { settings } = onConfirm.mock.calls[0][0];
    expect(settings.animation).toBe(false);
    expect(settings.excludedClips).toBeUndefined();
  });

  it('chooses how many animation keys to keep', async () => {
    const { onConfirm } = await open(report({ clips: [{ name: 'Walk', duration: 1, start: 0, layers: 1 }] }));
    fireEvent.click(screen.getByRole('radio', { name: 'Every key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(onConfirm.mock.calls[0][0].settings.keyThreshold).toBe(0);
  });

  it('lists images a file does not hold, and takes the ones found by name', async () => {
    const { onConfirm } = await open(report({ images: [{ file: 'Atlas.PNG', embedded: false }, { file: 'held.png', embedded: true }, { file: 'other.png', embedded: false }] }));
    expect(screen.getByText('Images not in the file: 2')).toBeTruthy();
    expect(screen.queryByText('held.png')).toBeNull();
    const picker = document.querySelector('input[type=file][multiple]') as HTMLInputElement;
    const found = new File(['x'], 'atlas.png', { type: 'image/png' });
    const unrelated = new File(['x'], 'unrelated.png', { type: 'image/png' });
    fireEvent.change(picker, { target: { files: [found, unrelated] } });
    expect(screen.getByText('Images not in the file: 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(onConfirm.mock.calls[0][0].images).toEqual([found]);
  });

  it('does not ask again for images a model already has', async () => {
    await open(report({ images: [{ file: 'Atlas.png', embedded: false }] }), { knownImages: ['atlas.png'], initialSettings: { normalize: false, targetSize: 2 }, confirmLabel: 'Apply' });
    expect(screen.queryByText(/Images not in the file/)).toBeNull();
  });

  it('starts from a model\'s own settings, not from what suits the file', async () => {
    await open(report({ boneNames: PERSON_BONES, boundsMin: [-195, 0, -36], boundsMax: [195, 378, 36] }), {
      initialSettings: { normalize: false, targetSize: 5 }, confirmLabel: 'Apply',
    });
    expect(screen.getByRole('radio', { name: 'As in the file' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText(/so it is set to/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy();
  });

  it('offers the rest of a batch the same settings', async () => {
    const { onConfirm } = await open(report(), { remaining: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'Import all 4' }));
    expect(onConfirm.mock.calls[0][0].applyToRest).toBe(true);
  });

  it('still imports a file it could not read ahead of time', async () => {
    const { onConfirm } = await open(null);
    expect(screen.getByText(/could not be read ahead of importing/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('closes on Escape without importing', async () => {
    const { onConfirm, onCancel } = await open(report());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('closes on Escape with the focus inside it, too', async () => {
    const { onCancel } = await open(report());
    fireEvent.keyDown(screen.getByRole('button', { name: 'Import' }), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('says why a file cannot be read, and does not offer to import it', async () => {
    const onConfirm = vi.fn();
    render(<ImportOptionsDialog name="thing.fbx" inspect={async () => { throw new Error('The file could not be read: Truncated file.'); }} onConfirm={onConfirm} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Truncated file/)).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not offer to import a file that holds nothing', async () => {
    await open(report({ meshes: 0, triangles: 0, vertices: 0, boundsMin: undefined, boundsMax: undefined, clips: [] }));
    expect(screen.getByText(/nothing to import/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps a model with no clips that way when only its size changes', async () => {
    const { onConfirm } = await open(report({ clips: [{ name: 'Walk', duration: 1, start: 0, layers: 1 }] }), { initialSettings: resolveImportSettings({ normalize: false, targetSize: 2, animation: false }), confirmLabel: 'Apply' });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onConfirm.mock.calls[0][0].settings.animation).toBe(false);
  });

  it('counts only the takes the file has as left out', async () => {
    await open(report({ clips: [{ name: 'Walk', duration: 1, start: 0, layers: 1 }, { name: 'Run', duration: 1, start: 0, layers: 1 }] }), { initialSettings: resolveImportSettings({ normalize: false, targetSize: 2, excludedClips: ['Walk', 'Old', 'Older'] }) });
    expect(screen.getByText(/Animation: 1 of 2 clips/)).toBeTruthy();
  });

  it('reads an OBJ\'s material file when it is found, and asks for the images that names', async () => {
    const inspect = vi.fn(async (beside?: readonly File[]) => (beside?.length
      ? report({ format: 'obj', materialFile: 'parts.mtl', images: [{ file: 'paint.png', embedded: false }] })
      : report({ format: 'obj', materialFile: 'parts.mtl', images: [{ file: 'parts.mtl', embedded: false }] })));
    const onConfirm = vi.fn<(choice: ImportChoice) => void>();
    const { container } = render(<ImportOptionsDialog name="thing.obj" inspect={inspect} onConfirm={onConfirm} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('parts.mtl')).toBeTruthy());
    const mtl = new File(['newmtl Paint'], 'parts.mtl');
    const image = new File(['png'], 'paint.png');
    // A folder holds both at once: the image is found once the material file has said it is wanted.
    const picker = container.querySelector('input[type="file"][multiple]') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [mtl, image] } });
    await waitFor(() => expect(screen.getByText('paint.png')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(onConfirm.mock.calls[0][0].images.map((file) => file.name).sort()).toEqual(['paint.png', 'parts.mtl']);
  });
});
