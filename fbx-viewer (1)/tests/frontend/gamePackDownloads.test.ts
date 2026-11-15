import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadGamePack,
  MAX_GAME_PACK_ASSET_BYTES,
  MAX_GAME_PACK_IN_FLIGHT_BYTES,
} from '../../player/gamePack';

type Asset = { id: string; file: string; mime: string; size: number };
const asset = (id: string, size: number, mime = 'image/png'): Asset => ({ id, file: `${id}.bin`, mime, size });
const base = 'https://game.example/player/';

let assets: Asset[];
let downloads: Map<string, (signal: AbortSignal) => Response | Promise<Response>>;
let requested: string[];
let objectUrls: { url: string; blob: Blob }[];
let revoked: string[];
let nextUrl: number;

const bodyResponse = (chunks: Uint8Array[], contentLength?: string, onCancel?: () => void, onPull?: () => void): Response => {
  let position = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(stream) {
      onPull?.();
      if (position < chunks.length) stream.enqueue(chunks[position++]);
      if (position === chunks.length) stream.close();
    },
    cancel: () => { onCancel?.(); },
  });
  return new Response(body, { headers: contentLength === undefined ? undefined : { 'Content-Length': contentLength } });
};

const load = () => loadGamePack(base);

beforeEach(() => {
  assets = [];
  downloads = new Map();
  requested = [];
  objectUrls = [];
  revoked = [];
  nextUrl = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/game/game.json')) {
      return Response.json({ format: 'auvra.game', schema: 1, gameId: 'test', startupLevelId: 'main', domains: [], assets });
    }
    const file = url.split('/').at(-1)!;
    requested.push(file);
    const handler = downloads.get(file);
    return handler ? handler(init?.signal as AbortSignal) : new Response(null, { status: 404 });
  }));
  const OriginalURL = URL;
  vi.stubGlobal('URL', class extends OriginalURL {
    static createObjectURL(blob: Blob): string {
      const url = `blob:test-${nextUrl++}`;
      objectUrls.push({ url, blob });
      return url;
    }
    static revokeObjectURL(url: string): void { revoked.push(url); }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('game-pack asset download budgets', () => {
  it('rejects an oversized manifest declaration before fetching or buffering that asset', async () => {
    assets = [asset('too-large', MAX_GAME_PACK_ASSET_BYTES + 1)];
    const source = await load();
    const readAll = vi.spyOn(Response.prototype, 'arrayBuffer');
    await expect(source.resolveAssetUrl('too-large')).rejects.toThrow(/exceeds.*limit/);
    expect(requested).toEqual([]);
    expect(readAll).not.toHaveBeenCalled();
    expect(objectUrls).toEqual([]);
    source.dispose();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects malformed declared size %s before fetch', async size => {
    assets = [asset('invalid', size)];
    const source = await load();
    await expect(source.resolveAssetUrl('invalid')).rejects.toThrow(/Invalid game-pack asset size/);
    expect(requested).toEqual([]);
    source.dispose();
  });

  it('rejects an oversized Content-Length before consuming the response body', async () => {
    assets = [asset('declared', 2)];
    const signals: AbortSignal[] = [];
    downloads.set('declared.bin', incoming => {
      signals.push(incoming);
      return bodyResponse([new Uint8Array([1, 2])], String(MAX_GAME_PACK_ASSET_BYTES + 1));
    });
    const source = await load();
    await expect(source.resolveAssetUrl('declared')).rejects.toThrow(/response limit/);
    expect(signals[0].aborted).toBe(true);
    expect(objectUrls).toEqual([]);
    source.dispose();
  });

  it.each(['missing', 'dishonest'])('aborts a %s Content-Length response mid-stream at the manifest limit', async kind => {
    assets = [asset('overflow', 5)];
    let pulls = 0;
    let cancels = 0;
    downloads.set('overflow.bin', () => bodyResponse(
      Array.from({ length: 40 }, () => new Uint8Array([1, 2, 3, 4])),
      kind === 'missing' ? undefined : '1',
      () => { cancels++; },
      () => { pulls++; },
    ));
    const source = await load();
    await expect(source.resolveAssetUrl('overflow')).rejects.toThrow(/exceeds its declared size/);
    expect(pulls).toBeLessThan(40);
    await vi.waitFor(() => expect(cancels).toBe(1));
    expect(objectUrls).toEqual([]);
    source.dispose();
  });

  it('consumes a stream without response.arrayBuffer or a second full-sized JS Blob input', async () => {
    const bytes = Uint8Array.from([0, 255, 18, 0, 42, 128, 3, 1, 200]);
    assets = [asset('stream', bytes.length, 'audio/ogg')];
    downloads.set('stream.bin', () => bodyResponse([bytes.subarray(0, 2), bytes.subarray(2, 7), bytes.subarray(7)], '9'));
    const readAll = vi.spyOn(Response.prototype, 'arrayBuffer').mockImplementation(() => {
      throw new Error('Full response ArrayBuffer allocation is forbidden');
    });
    const OriginalBlob = Blob;
    vi.stubGlobal('Blob', class extends OriginalBlob {
      constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
        if (parts.some(part => part instanceof ArrayBuffer || ArrayBuffer.isView(part))) {
          throw new Error('A second full-size Blob copy is forbidden');
        }
        super(parts, options);
      }
    });
    const source = await load();
    const url = await source.resolveAssetUrl('stream');
    expect(url).toBe('blob:test-0');
    expect(readAll).not.toHaveBeenCalled();
    expect(objectUrls).toHaveLength(1);
    expect(objectUrls[0].blob.type).toBe('audio/ogg');
    expect(new Uint8Array(await objectUrls[0].blob.arrayBuffer())).toEqual(bytes);
    source.dispose();
    expect(revoked).toEqual([url]);
  });

  it('keeps in-limit assets byte-identical, deduplicates requests, and releases URLs', async () => {
    const bytes = Uint8Array.from([255, 0, 13, 10, 128, 250]);
    assets = [asset('image', bytes.length, 'image/png')];
    downloads.set('image.bin', () => bodyResponse([bytes.subarray(0, 1), bytes.subarray(1, 4), bytes.subarray(4)]));
    const source = await load();
    const [first, same] = await Promise.all([source.resolveAssetUrl('image'), source.resolveAssetUrl('image')]);
    expect(first).toBe(same);
    expect(requested).toEqual(['image.bin']);
    expect(objectUrls[0].blob.type).toBe('image/png');
    expect(new Uint8Array(await objectUrls[0].blob.arrayBuffer())).toEqual(bytes);
    source.releaseAssetUrl('image');
    await vi.waitFor(() => expect(revoked).toEqual([first]));
    const again = await source.resolveAssetUrl('image');
    expect(again).not.toBe(first);
    expect(requested).toEqual(['image.bin', 'image.bin']);
    source.dispose();
    expect(revoked).toEqual([first, again]);
  });

  it('reserves a shared aggregate byte budget across packs before starting queued fetches', async () => {
    expect(MAX_GAME_PACK_IN_FLIGHT_BYTES / MAX_GAME_PACK_ASSET_BYTES).toBe(2);
    // Large declarations exercise reservation without allocating huge test buffers.
    assets = [asset('a', MAX_GAME_PACK_ASSET_BYTES), asset('b', MAX_GAME_PACK_ASSET_BYTES), asset('c', MAX_GAME_PACK_ASSET_BYTES)];
    for (const item of assets) downloads.set(item.file, signal => new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    }));
    const first = await load();
    const second = await load();
    const a = first.resolveAssetUrl('a');
    const b = second.resolveAssetUrl('b');
    const c = second.resolveAssetUrl('c');
    await vi.waitFor(() => expect(requested).toEqual(['a.bin', 'b.bin']));
    first.releaseAssetUrl('a');
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(requested).toEqual(['a.bin', 'b.bin', 'c.bin']));
    second.releaseAssetUrl('b');
    second.releaseAssetUrl('c');
    await Promise.all([expect(b).rejects.toMatchObject({ name: 'AbortError' }), expect(c).rejects.toMatchObject({ name: 'AbortError' })]);
    first.dispose();
    second.dispose();
    expect(objectUrls).toEqual([]);
  });

  it('permits simultaneous small downloads without imposing a fixed two-request bottleneck', async () => {
    assets = [asset('a', 1), asset('b', 1), asset('c', 1)];
    const gates: (() => void)[] = [];
    for (const item of assets) downloads.set(item.file, () => {
      let release!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      gates.push(release);
      return new Response(new ReadableStream<Uint8Array>({
        async pull(stream) {
          await wait;
          stream.enqueue(new Uint8Array([item.id.charCodeAt(0)]));
          stream.close();
        },
      }));
    });
    const source = await load();
    const pending = assets.map(item => source.resolveAssetUrl(item.id));
    await vi.waitFor(() => expect(requested).toEqual(['a.bin', 'b.bin', 'c.bin']));
    gates.forEach(release => release());
    await Promise.all(pending);
    source.dispose();
    expect(revoked).toHaveLength(3);
  });

  it('cancels a queued download before fetch and a pending fetch on release', async () => {
    assets = [asset('a', MAX_GAME_PACK_ASSET_BYTES), asset('b', MAX_GAME_PACK_ASSET_BYTES), asset('c', MAX_GAME_PACK_ASSET_BYTES)];
    const controllers: AbortSignal[] = [];
    for (const item of assets) downloads.set(item.file, signal => new Promise<Response>((_resolve, reject) => {
      controllers.push(signal);
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    }));
    const source = await load();
    const a = source.resolveAssetUrl('a');
    const b = source.resolveAssetUrl('b');
    const c = source.resolveAssetUrl('c');
    await vi.waitFor(() => expect(requested).toEqual(['a.bin', 'b.bin']));
    source.releaseAssetUrl('c');
    await expect(c).rejects.toMatchObject({ name: 'AbortError' });
    expect(requested).not.toContain('c.bin');
    source.releaseAssetUrl('a');
    source.releaseAssetUrl('b');
    await Promise.all([expect(a).rejects.toMatchObject({ name: 'AbortError' }), expect(b).rejects.toMatchObject({ name: 'AbortError' })]);
    expect(controllers.every(signal => signal.aborted)).toBe(true);
    expect(objectUrls).toEqual([]);
    source.dispose();
  });

  it('cleans up failed streams, permits retry, and aborts active downloads when disposed', async () => {
    assets = [asset('broken', 2), asset('pending', 1)];
    let attempts = 0;
    downloads.set('broken.bin', () => {
      attempts++;
      if (attempts === 1) return new Response(new ReadableStream<Uint8Array>({ pull(stream) { stream.error(new Error('wire failed')); } }));
      return bodyResponse([new Uint8Array([3, 4])]);
    });
    const pendingSignals: AbortSignal[] = [];
    downloads.set('pending.bin', signal => new Promise<Response>((_resolve, reject) => {
      pendingSignals.push(signal);
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    }));
    const source = await load();
    await expect(source.resolveAssetUrl('broken')).rejects.toThrow('wire failed');
    const url = await source.resolveAssetUrl('broken');
    expect(attempts).toBe(2);
    const pending = source.resolveAssetUrl('pending');
    await vi.waitFor(() => expect(pendingSignals).toHaveLength(1));
    source.dispose();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(pendingSignals[0].aborted).toBe(true);
    expect(revoked).toEqual([url]);
    await expect(source.resolveAssetUrl('broken')).rejects.toMatchObject({ name: 'AbortError' });
  });
});
