import { createComponent } from '../../runtime/components/registry';
import { PARTICLE_PRESETS, type ParticlePresetId } from '../../runtime/particleEffect';
import type { LevelComponent } from '../../types';

/** A placeable effect built from the same editable components as a hand-authored system. */
export const createIonVortexEmitters = (): LevelComponent[] => {
    const emitter = (emitterName: string, preset: ParticlePresetId): LevelComponent => {
        const component = createComponent('particles');
        return {
            ...component,
            props: { ...component.props, emitterName, preset, effect: structuredClone(PARTICLE_PRESETS[preset]) },
        };
    };
    return [emitter('Ion stream', 'ionVortex'), emitter('Counterflow sparks', 'vortexSparks')];
};
