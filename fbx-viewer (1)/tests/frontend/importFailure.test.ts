import { afterEach, describe, expect, it, vi } from 'vitest';
import { importFailureMessage } from '../../utils/modelLoader';
import { projectService } from '../../utils/projectService';

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
    setRequestHeader() {}
    getResponseHeader(): string | null { return null; }
    abort() {}
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    [413, 'The file is larger than this project can take.'],
    [423, 'This project is read-only.'],
    [507, 'The disk is full.'],
    [500, 'The project could not store this file.'],
  ])('says what an answer of %i means', async (status, message) => {
    await expect(uploadEnding((request) => { request.status = status; request.onload?.(); })).rejects.toThrow(message);
  });

  it('says so when nothing came back at all', async () => {
    await expect(uploadEnding((request) => { request.onerror?.(); })).rejects.toThrow('The file could not be sent to the project.');
  });
});
