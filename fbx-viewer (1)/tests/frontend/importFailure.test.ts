import { afterEach, describe, expect, it, vi } from 'vitest';
import { importFailureMessage } from '../../utils/modelLoader';
import { projectService, storedFileName } from '../../utils/projectService';

describe('saying why an import failed', () => {
  it('gives the reason where there is one', () => {
    expect(importFailureMessage('Failed to import "gun.fbx"', new Error('The disk is full.'))).toBe('Failed to import "gun.fbx": The disk is full.');
  });

  it('leaves out the name of a library\'s own loader', () => {
    expect(importFailureMessage('Failed to import "gun.fbx"', new Error('THREE.FBXLoader: Unknown format.'))).toBe('Failed to import "gun.fbx": Unknown format.');
  });

  it.each(['unexpected EOF', 'Offset is outside the bounds of the DataView', 'Cannot read properties of undefined (reading \'x\')'])('puts a parser tripping on a broken file in plain words: %s', (said) => {
    expect(importFailureMessage('Failed to import "gun.fbx"', new Error(said))).toBe('Failed to import "gun.fbx": The file could not be read. It may be damaged or cut short.');
  });

  it('says when the file on disk cannot be reached', () => {
    expect(importFailureMessage('Failed to import "gun.fbx"', new DOMException('A requested file or directory could not be found.', 'NotFoundError'))).toBe('Failed to import "gun.fbx": The file could not be found. It may have been moved or deleted.');
  });

  it('ends what it says as a sentence', () => {
    expect(importFailureMessage('Failed to import "gun.fbx"', new Error('FBX version not supported, FileVersion: 6100'))).toBe('Failed to import "gun.fbx": FBX version not supported, FileVersion: 6100.');
  });

  it('still says it failed where there is no reason to give', () => {
    expect(importFailureMessage('Failed to import "gun.fbx"', new Error('   '))).toBe('Failed to import "gun.fbx".');
    expect(importFailureMessage('Failed to import "gun.fbx"', 'nothing useful')).toBe('Failed to import "gun.fbx".');
  });
});

describe('a file the project would not take', () => {
  /** An upload whose request ends the given way. */
  const uploadEnding = (end: (request: FakeRequest) => void) => {
    class Request extends FakeRequest {
      send() { end(this); }
    }
    vi.stubGlobal('XMLHttpRequest', Request);
    vi.spyOn(projectService as unknown as { beginAssetUpload: () => Promise<unknown> }, 'beginAssetUpload')
      .mockResolvedValue({ url: 'https://assets.auvra.local/v1/put/x', method: 'PUT', mime: 'model/fbx' });
    return projectService.uploadAsset(new File(['bytes'], 'gun.fbx', { type: 'model/fbx' }));
  };

  class FakeRequest {
    status = 0;
    upload = {};
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open() {}
    setRequestHeader(_name: string, _value: string) {}
    getResponseHeader(): string | null { return null; }
    abort() {}
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    [409, 'The project was closed before the file finished sending.'],
    [413, 'The file is larger than the 2 GB a project can take.'],
    [415, 'The file\'s contents do not match its file type.'],
    [423, 'This project is read-only.'],
    [507, 'The disk is full.'],
    [500, 'The project could not store this file.'],
  ])('says what an answer of %i means', async (status, message) => {
    await expect(uploadEnding((request) => { request.status = status; request.onload?.(); })).rejects.toThrow(message);
  });

  it('says so when nothing came back at all', async () => {
    await expect(uploadEnding((request) => { request.onerror?.(); })).rejects.toThrow('The file could not be sent to the project.');
  });

  it('refuses what no project could store without asking the host', async () => {
    const asked = vi.spyOn(projectService as unknown as { beginAssetUpload: () => Promise<unknown> }, 'beginAssetUpload');
    await expect(projectService.uploadAsset(new File([], 'gun.fbx'))).rejects.toThrow('The file is empty.');
    const huge = new File(['x'], 'gun.fbx');
    Object.defineProperty(huge, 'size', { value: 2 * 1024 * 1024 * 1024 + 1 });
    await expect(projectService.uploadAsset(huge)).rejects.toThrow('2 GB');
    expect(asked).not.toHaveBeenCalled();
  });

  describe('sending a file in pieces', () => {
    const PIECE = 16 * 1024 * 1024;
    const HASH = 'a'.repeat(64);
    /** Answers every piece as the host would, noting what came. */
    const hostHearing = (answer?: (range: string, request: FakeRequest) => boolean) => {
      const ranges: string[] = [];
      class Request extends FakeRequest {
        range = '';
        answeredHash: string | null = null;
        setRequestHeader(name: string, value: string) { if (name === 'Content-Range') this.range = value; }
        getResponseHeader(): string | null { return this.answeredHash; }
        send() {
          ranges.push(this.range);
          if (answer?.(this.range, this)) return;
          this.status = 204;
          if (/\/(\d+)$/.exec(this.range)?.[1] === String(Number(/-(\d+)\//.exec(this.range)?.[1]) + 1)) this.answeredHash = HASH;
          this.onload?.();
        }
      }
      vi.stubGlobal('XMLHttpRequest', Request);
      vi.spyOn(projectService as unknown as { beginAssetUpload: () => Promise<unknown> }, 'beginAssetUpload')
        .mockResolvedValue({ url: 'https://assets.auvra.local/v1/put/x', method: 'PUT', mime: 'model/fbx' });
      return ranges;
    };
    const fileOf = (size: number) => new File([new Uint8Array(size)], 'gun.fbx', { type: 'model/fbx' });

    it('sends a small file as one piece', async () => {
      const ranges = hostHearing();
      await expect(projectService.uploadAsset(fileOf(5))).resolves.toBe(HASH);
      expect(ranges).toEqual(['bytes 0-4/5']);
    });

    it('sends a large file in order, with nothing missed', async () => {
      const ranges = hostHearing();
      const size = 2 * PIECE + 3;
      await expect(projectService.uploadAsset(fileOf(size))).resolves.toBe(HASH);
      expect(ranges).toEqual([`bytes 0-${PIECE - 1}/${size}`, `bytes ${PIECE}-${2 * PIECE - 1}/${size}`, `bytes ${2 * PIECE}-${size - 1}/${size}`]);
    });

    it('stops at the first piece the host refuses', async () => {
      const ranges = hostHearing((_, request) => { request.status = 507; request.onload?.(); return true; });
      await expect(projectService.uploadAsset(fileOf(2 * PIECE))).rejects.toThrow('The disk is full.');
      expect(ranges).toHaveLength(1);
    });

    it('stops between pieces when cancelled', async () => {
      const stop = new AbortController();
      const ranges = hostHearing(() => { stop.abort(); return false; });
      await expect(projectService.uploadAsset(fileOf(2 * PIECE), { signal: stop.signal })).rejects.toMatchObject({ name: 'AbortError' });
      expect(ranges).toHaveLength(1);
    });

    it('only reports all of it sent once the host has it', async () => {
      hostHearing();
      const reported: number[] = [];
      await projectService.uploadAsset(fileOf(2 * PIECE), { onProgress: (progress) => reported.push(progress) });
      expect(reported).toEqual([1]);
    });

    it('asks for no ticket for a file cancelled while it waited its turn', async () => {
      const stop = new AbortController();
      const ranges = hostHearing((_, request) => {
        stop.abort();
        request.status = 204;
        request.getResponseHeader = () => HASH;
        request.onload?.();
        return true;
      });
      const asked = vi.mocked((projectService as unknown as { beginAssetUpload: () => Promise<unknown> }).beginAssetUpload);
      const first = projectService.uploadAsset(fileOf(3));
      const second = projectService.uploadAsset(fileOf(4), { signal: stop.signal });
      await expect(first).resolves.toBe(HASH);
      await expect(second).rejects.toMatchObject({ name: 'AbortError' });
      expect(asked).toHaveBeenCalledTimes(1);
      expect(ranges).toHaveLength(1);
    });

    it('sends files one at a time, each finished before the next', async () => {
      const open: string[] = [];
      let most = 0;
      hostHearing((range, request) => {
        open.push(range);
        most = Math.max(most, open.length);
        setTimeout(() => { open.pop(); request.status = 204; request.getResponseHeader = () => HASH; request.onload?.(); }, 1);
        return true;
      });
      await Promise.all([projectService.uploadAsset(fileOf(3)), projectService.uploadAsset(fileOf(4)), projectService.uploadAsset(fileOf(5))]);
      expect(most).toBe(1);
    });
  });
});

describe('reading a stored file', () => {
  const PIECE = 16 * 1024 * 1024;
  const ID = 'a'.repeat(64);
  const URL_OF_TICKET = `https://assets.auvra.local/v1/get/${'b'.repeat(43)}`;
  const ticketOf = (size: number, mime = 'model/fbx') => vi
    .spyOn(projectService as unknown as { assetTicket: () => Promise<unknown> }, 'assetTicket')
    .mockResolvedValue({ url: URL_OF_TICKET, size, mime });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks for a small file whole', async () => {
    ticketOf(PIECE);
    const fetched = vi.fn(async () => new Response('whole'));
    vi.stubGlobal('fetch', fetched);
    await expect((await projectService.fetchAsset(ID)).text()).resolves.toBe('whole');
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched.mock.calls[0]).toEqual([URL_OF_TICKET, { method: 'GET', signal: undefined }]);
  });

  it('asks for a large file in pieces and puts them back together in order', async () => {
    ticketOf(2 * PIECE + 3);
    const ranges: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_: string, init: { headers: { Range: string } }) => {
      ranges.push(init.headers.Range);
      const piece = String(ranges.length);
      return { ok: true, status: 206, blob: async () => new Blob([piece]) };
    }));
    // The test environment's Response does not read a Blob, a browser's does.
    class Answer {
      ok = true;
      headers: Headers;
      constructor(public body: Blob, init: { headers: Record<string, string> }) { this.headers = new Headers(init.headers); }
    }
    vi.stubGlobal('Response', Answer);
    const response = await projectService.fetchAsset(ID) as unknown as Answer;
    expect(ranges).toEqual([`bytes=0-${PIECE - 1}`, `bytes=${PIECE}-${2 * PIECE - 1}`, `bytes=${2 * PIECE}-${2 * PIECE + 2}`]);
    expect(response.ok).toBe(true);
    expect(response.headers.get('Content-Type')).toBe('model/fbx');
    const read = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(response.body);
    });
    expect(read).toBe('123');
  });

  it('answers with the piece the host refused and asks for no more', async () => {
    ticketOf(3 * PIECE);
    const fetched = vi.fn(async () => new Response('', { status: fetched.mock.calls.length === 2 ? 410 : 206 }));
    vi.stubGlobal('fetch', fetched);
    const response = await projectService.fetchAsset(ID);
    expect(response.status).toBe(410);
    expect(fetched).toHaveBeenCalledTimes(2);
  });
});

describe('the name a project keeps for a file', () => {
  it('leaves an ordinary name alone', () => {
    expect(storedFileName("G\u00fcn (1) 'x' & #5.fbx")).toBe("G\u00fcn (1) 'x' & #5.fbx");
  });

  it('shortens a long one and keeps its extension', () => {
    const name = storedFileName(`${'n'.repeat(200)}.fbx`);
    expect(name).toHaveLength(128);
    expect(name.endsWith('n.fbx')).toBe(true);
  });

  it('never splits a character in two', () => {
    const name = storedFileName(`${'\u{1F52B}'.repeat(100)}.fbx`);
    expect(name.length).toBeLessThanOrEqual(128);
    expect(name).toBe(`${'\u{1F52B}'.repeat(62)}.fbx`);
  });

  it('replaces what the host protocol does not take', () => {
    expect(storedFileName('..\\a/b:c.fbx')).toBe('.._a_b_c.fbx');
    expect(storedFileName('')).toBe('file');
  });
});
