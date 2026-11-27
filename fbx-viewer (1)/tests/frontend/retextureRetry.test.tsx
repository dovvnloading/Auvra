import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as THREE from 'three';
import { RetextureEditor } from '../../components/Tools/RetextureEditor';
import { retextureSessions, surfaceInstruction, type ModelSession, type SessionPart, type Take } from '../../components/Tools/Retexture/retextureSession';
import { hostProviderService, type ProviderCapability } from '../../services/HostProviderService';
import { textureService } from '../../services/TextureGenerationService';

const { useScene } = vi.hoisted(() => ({ useScene: vi.fn() }));
vi.mock('../../context/SceneContext', () => ({ useScene }));
vi.mock('../../context/NotificationContext', () => ({ useNotification: () => ({ addNotification: vi.fn() }) }));
vi.mock('../../components/Tools/Retexture/AssetRail', () => ({ AssetRail: () => null }));
vi.mock('../../components/Tools/Retexture/RetextureStage', () => ({ RetextureStage: () => null }));

const scrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (scrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
});

const failed: Take = {
  id: 'failed-1', number: 1, partId: 'part-1', mode: 'restyle',
  prompt: 'worn leather', modelName: 'Earlier model', costMicroUsd: 10000,
  state: 'failed', error: 'Provider refused the request', keepOriginal: 0.5,
  startedAt: 1, maps: [], mapsState: 'none',
};

const part = (id: string, take?: Take, textured = true): SessionPart => ({
  id, name: id, rawName: id, materials: [], materialNames: [id],
  texture: textured ? new THREE.Texture() : null, baseline: [], baselineOverrides: {},
  baselineMaterialOverrides: {}, thumbnail: null, preview: null, size: null,
  takes: take ? [take] : [], worn: null, saved: null, followNext: false, nextNumber: 2, showRequest: 0,
});

const routeModelId = (capability: ProviderCapability) => `mock/${capability}`;

const openEditor = (take: Take = failed, textured = true) => {
  const active = part('part-1', { ...take }, textured);
  const other = part('part-2', undefined, textured);
  const object = new THREE.Group();
  const session: ModelSession = {
    modelId: 'model-1', modelName: 'Test model', object,
    parts: [active, other], activePartId: active.id, attached: false,
  };
  useScene.mockReturnValue({
    models: [{ id: session.modelId, name: session.modelName, object, textureOverrides: {}, materialOverrides: {} }],
    selectedModelId: session.modelId, projectStatus: { projectId: 'test-project' },
    setModelTextureOverrides: vi.fn(), updateModelMaterialOverrides: vi.fn(), adoptHostTexture: vi.fn(), isLoading: false,
  });
  vi.spyOn(retextureSessions, 'open').mockReturnValue(session);
  vi.spyOn(retextureSessions, 'previewOf').mockReturnValue(null);
  vi.spyOn(retextureSessions, 'chooseCapableModel').mockResolvedValue(undefined);
  vi.spyOn(retextureSessions, 'mapsModel').mockResolvedValue(null);
  vi.spyOn(retextureSessions, 'paintsOnObject').mockReturnValue(false);
  const generate = vi.spyOn(retextureSessions, 'generate').mockResolvedValue(undefined);
  vi.spyOn(hostProviderService, 'loadConfiguredRoute').mockImplementation(async (capability) => ({
    providerId: 'mock-provider', modelId: routeModelId(capability), route: 'cloud',
  }));
  vi.spyOn(hostProviderService, 'listModels').mockImplementation(async (_provider, capability) => capability ? [{
    id: routeModelId(capability), name: 'Reviewed model', priceMicroUsd: 20000, priceUnit: 'images',
  }] : []);
  // All generation is intercepted at the session boundary; no provider calls are made.
  const submit = vi.spyOn(hostProviderService, 'submitInference').mockRejectedValue(new Error('Unexpected real submission'));
  render(<RetextureEditor />);
  fireEvent.click(screen.getByRole('button', { name: 'Result 1, failed' }));
  return { session, active, other, generate, submit };
};

describe('retrying a selected failed Retexture result', () => {
  it.each([
    { draft: 'fresh draft', allParts: false },
    { draft: '   ', allParts: true },
    { draft: 'different draft', allParts: true },
  ])('uses the failed description instead of draft "$draft" (all parts: $allParts)', async ({ draft, allParts }) => {
    const { session, active, generate, submit } = openEditor();
    const description = screen.getByRole('textbox', { name: 'Description' });
    fireEvent.change(description, { target: { value: draft } });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'How many results' })).getByRole('radio', { name: '4' }));
    if (allParts) fireEvent.click(within(screen.getByRole('radiogroup', { name: 'What to change' })).getByRole('radio', { name: 'All parts' }));
    const retry = screen.getByRole('button', { name: 'Try again' });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(retry).toHaveAccessibleDescription(/1 result · this part, from its current map · mock-provider \/ mock\/media.edit/);
    fireEvent.click(retry);
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(generate).toHaveBeenCalledWith(session, active, {
      mode: 'restyle', prompt: failed.prompt, count: 1,
      model: expect.objectContaining({ id: 'mock/media.edit', providerId: 'mock-provider' }),
      expectedRoute: { providerId: 'mock-provider', modelId: 'mock/media.edit' },
    });
    expect(description).toHaveValue(draft);
    expect(submit).not.toHaveBeenCalled();
  });

  it('sends exactly one provider request with the failed description through the real session and media service', async () => {
    const { active, generate, submit } = openEditor({ ...failed, mode: 'new' }, false);
    generate.mockRestore();
    submit.mockResolvedValue({ jobId: 'mock-job', status: 'queued' });
    vi.spyOn(textureService, 'follow').mockRejectedValue(new Error('Mock provider failure'));
    const description = screen.getByRole('textbox', { name: 'Description' });
    fireEvent.change(description, { target: { value: 'unrelated draft' } });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'How many results' })).getByRole('radio', { name: '4' }));
    const retry = screen.getByRole('button', { name: 'Try again' });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await screen.findByRole('button', { name: 'Result 2, failed' });
    expect(submit).toHaveBeenCalledExactlyOnceWith({
      capability: 'media.generate', input: surfaceInstruction(failed.prompt), consent: 'explicit',
    }, { providerId: 'mock-provider', modelId: 'mock/media.generate' });
    expect(active.takes).toHaveLength(2);
    expect(active.takes[1]).toMatchObject({ prompt: failed.prompt, modelName: 'Reviewed model', state: 'failed' });
    expect(description).toHaveValue('unrelated draft');
  });

  it('does not start another retry while the first is preparing its source', async () => {
    const { generate } = openEditor();
    let finish!: () => void;
    generate.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const retry = screen.getByRole('button', { name: 'Try again' });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(generate).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect(retry).toBeEnabled();
  });

  it('requires the original generation mode and shows the route for that mode before retrying', async () => {
    const { session, active, generate } = openEditor({ ...failed, mode: 'whole' }, false);
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry).toBeDisabled();
    expect(retry).toHaveAccessibleDescription(/select Whole model again/);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'How to paint it' })).getByRole('radio', { name: 'Whole model' }));
    await waitFor(() => expect(retry).toBeEnabled());
    expect(retry).toHaveAccessibleDescription(/1 result · whole model · mock-provider \/ mock\/media.mesh/);
    fireEvent.click(retry);
    expect(generate).toHaveBeenCalledWith(session, active, expect.objectContaining({
      mode: 'whole', prompt: failed.prompt, count: 1,
      expectedRoute: { providerId: 'mock-provider', modelId: 'mock/media.mesh' },
    }));
  });

  it('keeps manual description reuse and ordinary multi-part generation independent', async () => {
    const { session, active, other, generate } = openEditor();
    const description = screen.getByRole('textbox', { name: 'Description' });
    fireEvent.change(description, { target: { value: 'new material' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this description' }));
    expect(description).toHaveValue(failed.prompt);
    expect(generate).not.toHaveBeenCalled();
    fireEvent.change(description, { target: { value: 'new material' } });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'What to change' })).getByRole('radio', { name: 'All parts' }));
    const generateButton = screen.getByRole('button', { name: /Generate Ctrl Enter/ });
    await waitFor(() => expect(generateButton).toBeEnabled());
    fireEvent.click(generateButton);
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(generate).toHaveBeenNthCalledWith(1, session, active, expect.objectContaining({ prompt: 'new material', count: 1 }));
    expect(generate).toHaveBeenNthCalledWith(2, session, other, expect.objectContaining({ prompt: 'new material', count: 1 }));
  });
});
