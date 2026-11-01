import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as THREE from 'three';
import { hostProviderService, type ProviderModel } from '../../services/HostProviderService';
import { estimateJobCost, formatCost } from '../../services/providerPricing';
import { isUtilityModel, modelSample, picksFor } from '../../services/providerPicks';
import { ModelPicker } from '../../components/Settings/ModelPicker';
import { listModelParts, partDisplayName, partOfHit } from '../../components/Tools/Retexture/parts';
import { libraryName } from '../../components/Tools/Retexture/retextureSession';
import { NativeHostTransport } from '../../host/nativeTransport';

const model = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({ id, name: id, ...extra });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('what a part is called', () => {
  it('says a material name as a person would', () => {
    expect(partDisplayName('Shoesmat')).toBe('Shoes');
    expect(partDisplayName('Bottommat')).toBe('Bottom');
    expect(partDisplayName('Body_mat')).toBe('Body');
    expect(partDisplayName('M_Hair')).toBe('Hair');
    expect(partDisplayName('leatherJacket.001')).toBe('Leather Jacket');
    expect(partDisplayName('barrel_metal')).toBe('Barrel metal');
  });

  it('keeps a name that would otherwise come out empty', () => {
    expect(partDisplayName('Material_0')).toBe('Material 0');
    expect(partDisplayName('')).toBe('Surface');
  });
});

describe('the parts of a model', () => {
  const textureWith = (name: string) => {
    const texture = new THREE.Texture(document.createElement('canvas'));
    texture.name = name;
    return texture;
  };
  const material = (name: string, map: THREE.Texture | null) => {
    const value = new THREE.MeshStandardMaterial({ map });
    value.name = name;
    return value;
  };
  const meshOf = (materials: THREE.Material | THREE.Material[]) => new THREE.Mesh(new THREE.BufferGeometry(), materials);

  it('makes one part of the materials sharing a map, and one of each without', () => {
    const shared = textureWith('shared');
    const root = new THREE.Group();
    root.add(meshOf(material('Armsmat', shared)), meshOf(material('Legsmat', shared)), meshOf(material('Wood', null)));
    const parts = listModelParts(root);
    expect(parts.map((part) => part.name)).toEqual(['Arms', 'Wood']);
    expect(parts[0].materialNames).toEqual(['Armsmat', 'Legsmat']);
    expect(parts[1].texture).toBeNull();
  });

  it('numbers names that come out the same', () => {
    const root = new THREE.Group();
    root.add(meshOf(material('Wood', null)), meshOf(material('Wood_mat', null)));
    expect(listModelParts(root).map((part) => part.name)).toEqual(['Wood', 'Wood 2']);
  });

  it('finds the part a click landed on, through a mesh with several materials', () => {
    const first = material('A', null);
    const second = material('B', null);
    const mesh = meshOf([first, second]);
    const root = new THREE.Group();
    root.add(mesh);
    const parts = listModelParts(root);
    expect(partOfHit(parts, mesh, 1)?.name).toBe('B');
    expect(partOfHit(parts, mesh, 0)?.name).toBe('A');
  });
});

describe('a kept texture\'s name', () => {
  it('holds nothing a project name may not', () => {
    const name = libraryName('Remy.fbx', 'Bottom', 'Faded: "blue" denim / worn?');
    expect(name).toBe('Remy.fbx Bottom - Faded blue denim worn');
    expect(name).toMatch(/^[^\\/:*?"<>|\r\n]+$/);
  });

  it('stays within what a project name may be', () => {
    expect(libraryName('M', 'P', 'x'.repeat(400)).length).toBeLessThanOrEqual(128);
  });
});

describe('what a run comes to', () => {
  it('goes by the size of the picture for a price per megapixel', () => {
    const perMegapixel = model('a', { priceMicroUsd: 5000, priceUnit: 'processed megapixels' });
    expect(estimateJobCost(perMegapixel, 4)).toBe(20000);
    expect(formatCost(estimateJobCost(perMegapixel, 1.048576)!)).toBe('$0.0052');
  });

  it('ignores the size for a flat price, and has nothing to say without a price', () => {
    expect(estimateJobCost(model('a', { priceMicroUsd: 10000, priceUnit: 'units' }), 4)).toBe(10000);
    expect(estimateJobCost(model('a'))).toBeNull();
    expect(estimateJobCost(model('a', { priceMicroUsd: 1, outputPriceMicroUsd: 2 }))).toBeNull();
  });
});

describe('choosing a model', () => {
  const catalog = [
    model('fal-ai/flux-2/flash/edit', { name: 'FLUX 2 Flash Edit', priceMicroUsd: 5000, priceUnit: 'megapixels' }),
    model('fal-ai/flux-2-pro/edit', { name: 'FLUX 2 Pro Edit', priceMicroUsd: 30000, priceUnit: 'megapixels' }),
    model('fal-ai/post-processing/blur', { name: 'Post Processing Blur', priceMicroUsd: 1000, priceUnit: 'images' }),
    model('acme/painter', { name: 'Painter', priceMicroUsd: 20000, priceUnit: 'images' }),
  ];

  it('suggests only what the catalog has, by purpose', () => {
    const picks = picksFor('fal', 'media.edit', catalog);
    expect(picks.map((pick) => [pick.tier, pick.id])).toEqual([['Fast', 'fal-ai/flux-2/flash/edit'], ['Best quality', 'fal-ai/flux-2-pro/edit']]);
    expect(picksFor('other', 'media.edit', catalog)).toEqual([]);
  });

  it('has a sample for a suggested image model and none for an unknown one', () => {
    expect(modelSample('fal-ai/flux-2/flash/edit')).toBeTruthy();
    expect(modelSample('acme/painter')).toBeUndefined();
  });

  it('tells models that cut out or measure from ones that paint', () => {
    expect(isUtilityModel(model('fal-ai/birefnet/v2'))).toBe(true);
    expect(isUtilityModel(model('fal-ai/bria/background/remove'))).toBe(true);
    expect(isUtilityModel(model('fal-ai/flux-2/edit'))).toBe(false);
    // "image" holds "age", and must not be taken for an age filter.
    expect(isUtilityModel(model('openai/gpt-image-2/edit'))).toBe(false);
  });

  it('opens on the suggestions, and searching reaches everything', async () => {
    vi.spyOn(hostProviderService, 'listModels').mockResolvedValue(catalog);
    render(<ModelPicker providerId="fal" capability="media.edit" onChoose={vi.fn()} />);
    await screen.findByText('Fast');
    expect(screen.queryByText('Painter')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'painter' } });
    await screen.findByText('Painter');
  });

  it('hides utilities from the full list until they are asked for', async () => {
    vi.spyOn(hostProviderService, 'listModels').mockResolvedValue(catalog);
    render(<ModelPicker providerId="fal" capability="media.edit" onChoose={vi.fn()} />);
    await screen.findByText('Fast');
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    await screen.findByText('Painter');
    expect(screen.queryByText('Post Processing Blur')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByText('Post Processing Blur')).toBeTruthy());
  });
});

describe('the host transport', () => {
  const session = { protocol: 'auvra.host/1', type: 'session', session: 'test-session', revision: 4, status: 'active' };
  const request = (revision: number) => ({ protocol: 'auvra.host/1', type: 'request', id: 'r-1', session: 'test-session', revision, method: 'provider.list', payload: {} });
  const refused = (revision: number, message: string) => ({
    protocol: 'auvra.host/1', type: 'response', id: 'r-1', session: 'test-session', revision, ok: false, error: { code: 'revision_conflict', message },
  });

  const open = () => {
    const posted: { revision: number; id: string }[] = [];
    let listener: (event: { data: unknown }) => void = () => undefined;
    const webview = {
      postMessage: (message: { revision: number; id: string }) => { posted.push(message); },
      addEventListener: (_type: string, handler: (event: { data: unknown }) => void) => { listener = handler; },
      removeEventListener: () => undefined,
    };
    const transport = new NativeHostTransport(webview as never);
    listener({ data: session });
    return { transport, posted, deliver: (data: unknown) => listener({ data }) };
  };

  it('sends a request again when it only crossed another on the way', async () => {
    const { transport, posted, deliver } = open();
    const answer = transport.request(request(4) as never);
    deliver(refused(5, 'Host revision does not match'));
    expect(posted.map((message) => message.revision)).toEqual([4, 5]);
    deliver({ protocol: 'auvra.host/1', type: 'response', id: 'r-1', session: 'test-session', revision: 5, ok: true, result: { pong: true } });
    await expect(answer).resolves.toMatchObject({ ok: true });
    transport.close();
  });

  it('leaves a project\'s own conflict to its caller', async () => {
    const { transport, posted, deliver } = open();
    const answer = transport.request(request(4) as never);
    deliver(refused(4, 'Project revision does not match'));
    await expect(answer).resolves.toMatchObject({ ok: false, error: { message: 'Project revision does not match' } });
    expect(posted).toHaveLength(1);
    transport.close();
  });
});
