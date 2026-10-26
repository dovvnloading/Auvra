export type AudioBus = 'master' | 'music' | 'sfx' | 'ui';

export const AUDIO_BUSES: AudioBus[] = ['master', 'music', 'sfx', 'ui'];

export type AudioBusVolumes = Record<AudioBus, number>;

export const DEFAULT_BUS_VOLUMES: AudioBusVolumes = { master: 1, music: 0.8, sfx: 1, ui: 1 };

const clampVolume = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

export const normalizeBusVolumes = (value: unknown): AudioBusVolumes => {
    const stored = (value && typeof value === 'object' ? value : {}) as Partial<AudioBusVolumes>;
    return {
        master: clampVolume(stored.master, DEFAULT_BUS_VOLUMES.master),
        music: clampVolume(stored.music, DEFAULT_BUS_VOLUMES.music),
        sfx: clampVolume(stored.sfx, DEFAULT_BUS_VOLUMES.sfx),
        ui: clampVolume(stored.ui, DEFAULT_BUS_VOLUMES.ui),
    };
};

/**
 * Routes sounds through per-bus gain nodes into one master gain on a shared AudioContext
 * (the THREE.AudioListener's context in play). Sources connect to `input(bus)`.
 */
export class AudioMixer {
    private readonly master: GainNode;
    private readonly buses: Map<Exclude<AudioBus, 'master'>, GainNode> = new Map();
    private volumes: AudioBusVolumes;

    constructor(private readonly context: BaseAudioContext, destination: AudioNode = context.destination, volumes: AudioBusVolumes = DEFAULT_BUS_VOLUMES) {
        this.volumes = { ...volumes };
        this.master = context.createGain();
        this.master.connect(destination);
        for (const bus of ['music', 'sfx', 'ui'] as const) {
            const gain = context.createGain();
            gain.connect(this.master);
            this.buses.set(bus, gain);
        }
        this.apply();
    }

    /** The node a source on this bus should connect to. 'master' bypasses the sub-buses. */
    input(bus: AudioBus): AudioNode {
        return bus === 'master' ? this.master : this.buses.get(bus)!;
    }

    setVolumes(volumes: Partial<AudioBusVolumes>) {
        this.volumes = normalizeBusVolumes({ ...this.volumes, ...volumes });
        this.apply();
    }

    getVolumes(): AudioBusVolumes { return { ...this.volumes }; }

    /** Effective gain a source on `bus` plays at (bus x master), e.g. for HTMLAudio fallbacks. */
    effectiveGain(bus: AudioBus): number {
        return bus === 'master' ? this.volumes.master : this.volumes[bus] * this.volumes.master;
    }

    private apply() {
        const now = this.context.currentTime;
        this.master.gain.setTargetAtTime(this.volumes.master, now, 0.01);
        for (const [bus, gain] of this.buses) gain.gain.setTargetAtTime(this.volumes[bus], now, 0.01);
    }

    dispose() {
        for (const gain of this.buses.values()) gain.disconnect();
        this.master.disconnect();
    }
}
