import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as THREE from 'three';
import { hostProviderService, type ProviderModel } from '../../services/HostProviderService';
import { estimateJobCost, formatCost } from '../../services/providerPricing';
import { isUtilityModel, modelSample, picksFor } from '../../services/providerPicks';
import { ModelPicker } from '../../components/Settings/ModelPicker';
import { listModelParts, partDisplayName, partOfHit, usedAreaOfPart } from '../../components/Tools/Retexture/parts';
import { libraryName, restyleInstruction, retextureSessions, viewsInstruction } from '../../components/Tools/Retexture/retextureSession';
import { OriginalDetail, ViewedDetail, type Pixels } from '../../components/Tools/Retexture/keepOriginal';
import { bindMaterialGraph } from '../../runtime/materials/graphMaterial';
import { NativeHostTransport } from '../../host/nativeTransport';
import { textureSourceFlipY } from '../../utils/textureCompression/compressTextures';

const model = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({ id, name: id, ...extra });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('working from the map on a part', () => {
  const SIZE = 64;
  /** A picture from a function of position, with its alpha optional. */
  const picture = (paint: (x: number, y: number) => [number, number, number, number?]): Pixels => {
    const data = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const [r, g, b, a = 255] = paint(x, y);
        data.set([r, g, b, a], (y * SIZE + x) * 4);
      }
    }
    return { width: SIZE, height: SIZE, data };
  };
  const mixed = async (original: Pixels, result: Pixels, keep: number) => {
    const into = new Uint8ClampedArray(original.data.length);
    (await OriginalDetail.prepare(original, result)).mix(keep, into);
    return into;
  };
  const at = (data: Uint8ClampedArray, x: number, y: number, channel = 0) => data[(y * SIZE + x) * 4 + channel];
  const weave = picture((x) => { const v = x % 4 < 2 ? 90 : 130; return [v, v, v]; });
  const red = picture(() => [200, 40, 30]);

  it('tells the model to edit what it is given', () => {
    const told = restyleInstruction('  worn red leather ');
    expect(told).toContain('worn red leather.');
    expect(told).toMatch(/same layout/);
    expect(told).toMatch(/No new elements/);
  });

  it('takes colour from the result and fine detail from the original', async () => {
    const out = await mixed(weave, red, 1);
    expect(at(out, 32, 32, 0)).toBeGreaterThan(at(out, 32, 32, 1));
    expect(at(out, 32, 32, 0)).toBeLessThan(at(out, 34, 32, 0));
    expect(at(out, 36, 32, 0)).toBe(at(out, 32, 32, 0));
  });

  it('stays on the weave of the original whatever the model invents', async () => {
    const invented = picture((x, y) => { const v = (x + y) % 7 < 3 ? 60 : 220; return [v, 20, 20]; });
    const out = await mixed(weave, invented, 1);
    expect(at(out, 32, 32, 0)).toBeLessThan(at(out, 34, 32, 0));
    expect(at(out, 36, 32, 0)).toBeLessThan(at(out, 38, 32, 0));
  });

  it('gives the result as it is with nothing kept', async () => {
    const out = await mixed(weave, red, 0);
    expect([at(out, 32, 32, 0), at(out, 32, 32, 1), at(out, 32, 32, 2)]).toEqual([200, 40, 30]);
  });

  it('gives back the original when the result is the original', async () => {
    const flat = picture(() => [120, 120, 120]);
    const out = await mixed(flat, flat, 1);
    expect(at(out, 10, 10)).toBe(120);
  });

  it('keeps what is cut out of the original cut out', async () => {
    const cards = picture((x) => [90, 90, 90, x < SIZE / 2 ? 0 : 255]);
    const out = await mixed(cards, red, 0.5);
    expect(at(out, 2, 2, 3)).toBe(0);
    expect(at(out, 60, 2, 3)).toBe(255);
  });

  it('leaves what the model does not use of the map exactly as it was', async () => {
    const used = new Uint8Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y += 1) for (let x = 0; x < SIZE / 2; x += 1) used[y * SIZE + x] = 255;
    const into = new Uint8ClampedArray(weave.data.length);
    (await OriginalDetail.prepare(weave, red, used)).mix(0, into);
    expect(at(into, 2, 2, 0)).toBe(200);
    expect([at(into, 40, 2, 0), at(into, 40, 2, 1)]).toEqual([at(weave.data, 40, 2, 0), at(weave.data, 40, 2, 1)]);
  });

  it('moves the map by what an edit of its views changed, keeping every pixel of its detail', () => {
    const pixel = (r: number, g: number, b: number, a = 255) => [r, g, b, a];
    const original = new Uint8ClampedArray([...pixel(100, 100, 100), ...pixel(140, 100, 60), ...pixel(10, 20, 30)]);
    const broad = new Uint8Array([...pixel(60, 120, 60), ...pixel(60, 120, 60), ...pixel(0, 0, 0, 0)]);
    const before = new Uint8Array([...pixel(100, 100, 100), ...pixel(100, 100, 100), ...pixel(0, 0, 0, 0)]);
    const painted = new Uint8Array([...pixel(1, 2, 3), ...pixel(4, 5, 6), ...pixel(0, 0, 0, 0)]);
    const into = new Uint8ClampedArray(original.length);
    new ViewedDetail(original, broad, before, painted, null).mix(1, into);
    expect([...into.slice(0, 3)]).toEqual([60, 120, 60]);
    expect([...into.slice(4, 7)]).toEqual([100, 120, 20]);
    // What no camera saw moves by the same on average.
    expect([...into.slice(8, 11)]).toEqual([0, 40, 0]);
    new ViewedDetail(original, broad, before, painted, null).mix(0, into);
    expect([...into.slice(0, 3)]).toEqual([1, 2, 3]);
  });

  it('leaves alone what the model does not use, and what is cut out, when working through views', () => {
    const original = new Uint8ClampedArray([50, 60, 70, 0, 50, 60, 70, 255]);
    const broad = new Uint8Array([200, 200, 200, 255, 200, 200, 200, 255]);
    const before = new Uint8Array([50, 60, 70, 255, 50, 60, 70, 255]);
    const into = new Uint8ClampedArray(8);
    new ViewedDetail(original, broad, before, broad, new Uint8Array([255, 0])).mix(1, into);
    expect(into[3]).toBe(0);
    expect(into[0]).toBe(200);
    expect([...into.slice(4, 8)]).toEqual([50, 60, 70, 255]);
  });

  it('tells a model shown views to keep the object as it is', () => {
    const told = viewsInstruction(' green steel ');
    expect(told).toContain('green steel, the same on every side');
    expect(told).toMatch(/exact shape/);
  });

  it('refuses a result of another size', async () => {
    await expect(OriginalDetail.prepare(weave, { width: 2, height: 2, data: new Uint8ClampedArray(16) })).rejects.toThrow(/size/);
  });
});

describe('what the model uses of a map', () => {
  const meshWithUvs = (uvs: number[], name = 'Wood') => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(uvs.length / 2 * 3), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    const root = new THREE.Group();
    root.userData.uvOriginTopLeft = true;
    root.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ name })));
    return { root, part: listModelParts(root)[0] };
  };

  it('fills what the triangles cover, and a little beyond', () => {
    const { root, part } = meshWithUvs([0, 0, 0.5, 0, 0, 0.5]);
    const used = usedAreaOfPart(root, part, 100, 100)!;
    expect(used[10 * 100 + 10]).toBe(255);
    expect(used[10 * 100 + 90]).toBe(0);
    expect(used[90 * 100 + 90]).toBe(0);
    expect(used[10 * 100 + 41]).toBe(255);
  });

  it('says which way up a plain texture is read', () => {
    expect(textureSourceFlipY(Object.assign(new THREE.Texture(), { flipY: true }))).toBe(true);
    expect(textureSourceFlipY(Object.assign(new THREE.Texture(), { flipY: false }))).toBe(false);
  });

  it('goes by the model for which way round a map is, as a compressed texture cannot say', () => {
    const { root, part } = meshWithUvs([0, 0, 0.2, 0, 0, 0.2]);
    root.userData.uvOriginTopLeft = false;
    part.texture = Object.assign(new THREE.Texture(), { flipY: false });
    const used = usedAreaOfPart(root, part, 100, 100)!;
    expect(used[95 * 100 + 5]).toBe(255);
    expect(used[5 * 100 + 5]).toBe(0);
  });

  it('cannot say for a map that repeats', () => {
    const { root, part } = meshWithUvs([0, 0, 2, 0, 0, 2]);
    expect(usedAreaOfPart(root, part, 64, 64)).toBeNull();
  });

  it('cannot say without UVs', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ name: 'Wood' })));
    expect(usedAreaOfPart(root, listModelParts(root)[0], 64, 64)).toBeNull();
  });

  it('copes with a very dense mesh', () => {
    const uvs: number[] = [];
    for (let at = 0; at < 300_000; at += 1) {
      const u = (at % 1000) / 1000;
      const v = Math.floor(at / 1000) / 300;
      uvs.push(u, v, u + 0.0005, v, u, v + 0.0005);
    }
    const { root, part } = meshWithUvs(uvs);
    const started = performance.now();
    expect(usedAreaOfPart(root, part, 1024, 1024)).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('before and after', () => {
  const opened = (id: string, material: THREE.MeshStandardMaterial) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    const root = new THREE.Group();
    root.add(mesh);
    const session = retextureSessions.open(id, 'Crate', root, undefined, undefined);
    return { mesh, session, part: session.parts[0] };
  };

  it('draws both sides every frame without making a material recompile', () => {
    const material = new THREE.MeshStandardMaterial({ name: 'Wood' });
    const { mesh, session, part } = opened('compare-recompile', material);
    material.map = new THREE.Texture();
    material.transparent = true;
    material.needsUpdate = true;
    const comparison = retextureSessions.comparison(session, part);
    const version = material.version;
    for (let frame = 0; frame < 60; frame += 1) { comparison.drawBefore(); comparison.drawAfter(); }
    expect(material.version).toBe(version);
    expect(mesh.material).toBe(material);
    comparison.end();
  });

  it('shows the part as it was on the before side', () => {
    const original = new THREE.Texture();
    const material = new THREE.MeshStandardMaterial({ name: 'Wood', map: original, roughness: 0.3 });
    const { mesh, session, part } = opened('compare-before', material);
    material.map = new THREE.Texture();
    material.roughness = 1;
    material.transparent = true;
    const comparison = retextureSessions.comparison(session, part);
    comparison.drawBefore();
    const drawn = mesh.material as THREE.MeshStandardMaterial;
    expect(drawn).not.toBe(material);
    expect(drawn.map).toBe(original);
    expect(drawn.roughness).toBe(0.3);
    expect(drawn.transparent).toBe(false);
    comparison.drawAfter();
    expect(mesh.material).toBe(material);
    comparison.end();
  });

  it('keeps the rest of a mesh with several materials as it is', () => {
    const first = new THREE.MeshStandardMaterial({ name: 'Wood' });
    const second = new THREE.MeshStandardMaterial({ name: 'Iron', map: new THREE.Texture() });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [first, second]);
    const root = new THREE.Group();
    root.add(mesh);
    const session = retextureSessions.open('compare-several', 'Crate', root, undefined, undefined);
    const comparison = retextureSessions.comparison(session, session.parts.find((part) => part.name === 'Wood')!);
    comparison.drawBefore();
    const drawn = mesh.material as THREE.Material[];
    expect(drawn[0]).not.toBe(first);
    expect(drawn[1]).toBe(second);
    comparison.drawAfter();
    expect(mesh.material).toEqual([first, second]);
    comparison.end();
  });

  it('leaves a part shaded by a material asset alone', () => {
    const material = new THREE.MeshStandardMaterial({ name: 'Wood' });
    const { mesh, session, part } = opened('compare-graph', material);
    bindMaterialGraph(material, {});
    const comparison = retextureSessions.comparison(session, part);
    comparison.drawBefore();
    expect(mesh.material).toBe(material);
    comparison.drawAfter();
    comparison.end();
  });
});

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
    model('google/nano-banana-2.1/edit', { name: 'Nano Banana 2.1 Edit', priceMicroUsd: 80000, priceUnit: 'images' }),
    model('blackforestlabs/flux-3/edit-image', { name: 'Flux 3 Image', priceMicroUsd: 48000, priceUnit: 'megapixels' }),
    model('fal-ai/flux-2/flash/edit', { name: 'FLUX 2 Flash Edit', priceMicroUsd: 5000, priceUnit: 'megapixels' }),
    model('fal-ai/post-processing/blur', { name: 'Post Processing Blur', priceMicroUsd: 1000, priceUnit: 'images' }),
    model('acme/painter', { name: 'Painter', priceMicroUsd: 20000, priceUnit: 'images' }),
  ];

  it('suggests only what the catalog has, by purpose', () => {
    const picks = picksFor('fal', 'media.edit', catalog);
    expect(picks.map((pick) => [pick.tier, pick.id])).toEqual([['Best quality', 'blackforestlabs/flux-3/edit-image'], ['Balanced', 'google/nano-banana-2.1/edit']]);
    expect(picksFor('other', 'media.edit', catalog)).toEqual([]);
  });

  it('has a sample for a suggested image model and none for an unknown one', () => {
    expect(modelSample('blackforestlabs/flux-3/edit-image')).toBeTruthy();
    expect(modelSample('bytedance/seedream/v5/pro/edit')).toBeTruthy();
    expect(modelSample('google/nano-banana-2.1/edit')).toBeTruthy();
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
    await screen.findByText('Balanced');
    expect(screen.queryByText('Painter')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'painter' } });
    await screen.findByText('Painter');
  });

  it('hides utilities from the full list until they are asked for', async () => {
    vi.spyOn(hostProviderService, 'listModels').mockResolvedValue(catalog);
    render(<ModelPicker providerId="fal" capability="media.edit" onChoose={vi.fn()} />);
    await screen.findByText('Balanced');
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
