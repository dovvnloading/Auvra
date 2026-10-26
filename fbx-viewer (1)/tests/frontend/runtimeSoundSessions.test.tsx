import { act, render } from '@testing-library/react';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { GameContentProvider } from '../../runtime/GameContentContext';
import { RuntimeServicesProvider, RuntimeSpawnerProvider, useRuntimeServices, type RuntimeServices } from '../../runtime/RuntimeServicesContext';
import { DEFAULT_GAME_SETTINGS, type GameContent } from '../../runtime/types';

/** Fake Web Audio: just enough for the mixer attachment and one-shot buffer sources. */
const audio = vi.hoisted(() => {
  const node = () => ({ connect: () => undefined, disconnect: () => undefined });
  type Source = ReturnType<typeof node> & { buffer: unknown; onended: (() => void) | null; start: () => void; stop: () => void; started: boolean; stopped: boolean };
  const sources: Source[] = [];
  const context = {
    destination: node(),
    createBufferSource: (): Source => {
      const source: Source = {
        ...node(), buffer: null, onended: null, started: false, stopped: false,
        start() { source.started = true; },
        stop() { source.stopped = true; },
      };
      sources.push(source);
      return source;
    },
  };
  const listener = { type: 'AudioListener', context, getInput: node };
  const camera = { children: [listener], add: () => undefined, remove: () => undefined };
  return { sources, camera };
});

vi.mock('@react-three/fiber', () => ({
  useThree: (selector: (state: { camera: unknown }) => unknown) => selector({ camera: audio.camera }),
  useFrame: () => undefined,
  addAfterEffect: () => () => undefined,
}));

vi.mock('../../runtime/audioMixer', async importOriginal => ({
  ...(await importOriginal<typeof import('../../runtime/audioMixer')>()),
  AudioMixer: class {
    input() { return { connect: () => undefined }; }
    setVolumes() {}
    dispose() {}
  },
}));

const content: GameContent = {
  models: [], blueprints: [], attachments: [], sockets: [], textures: [],
  audioAssets: [{ id: 'music', url: 'music.ogg' }, { id: 'sting', url: 'sting.ogg' }] as GameContent['audioAssets'],
};

const sessions: RuntimeServices[] = [];
const Probe = () => {
  sessions.push(useRuntimeServices());
  return null;
};

/** A level runtime whose play session remounts on each restart, as LevelRuntime keys it by session. */
const Runtime: React.FC<{ session: number }> = ({ session }) => (
  <GameContentProvider value={content}>
    <RuntimeServicesProvider settings={DEFAULT_GAME_SETTINGS} inputEnabled>
      <RuntimeSpawnerProvider key={session} spawnPrefab={() => []}>
        <Probe />
      </RuntimeSpawnerProvider>
    </RuntimeServicesProvider>
  </GameContentProvider>
);

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('Play Sound voices belong to the play session', () => {
  it('a restart stops the old session sounds and drops ones still loading', async () => {
    let finishSting: (buffer: AudioBuffer) => void = () => undefined;
    vi.spyOn(THREE.AudioLoader.prototype, 'loadAsync').mockImplementation(url => (
      url === 'sting.ogg'
        ? new Promise<AudioBuffer>(resolve => { finishSting = resolve; })
        : Promise.resolve({} as AudioBuffer)
    ));

    const { rerender } = render(<Runtime session={1} />);
    const first = sessions.at(-1)!;
    first.playSound('music', 'music');
    first.playSound('sting');
    await flush();
    expect(audio.sources).toHaveLength(1);
    const oldTrack = audio.sources[0];
    expect(oldTrack.started).toBe(true);

    // Retry: same runtime, new session.
    rerender(<Runtime session={2} />);
    expect(oldTrack.stopped).toBe(true);

    // The old session's sting finishes decoding after the restart, and a stale timer asks for more.
    finishSting({} as AudioBuffer);
    first.playSound('music');
    await flush();
    expect(audio.sources).toHaveLength(1);

    // The new session plays normally, and its sound outlives nothing but itself.
    const second = sessions.at(-1)!;
    expect(second).not.toBe(first);
    second.playSound('music', 'music');
    await flush();
    expect(audio.sources).toHaveLength(2);
    expect(audio.sources[1].started).toBe(true);
    expect(audio.sources[1].stopped).toBe(false);
  });
});
