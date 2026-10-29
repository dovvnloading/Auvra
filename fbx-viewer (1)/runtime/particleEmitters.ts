/**
 * The running particle emitters, by object and component, so level scripts, gameplay scripts and
 * sub-emitters can start, stop and burst them. The editor's previews and the play session register
 * apart, so a script never reaches an editor preview.
 */

export type ParticleScope = 'editor' | 'runtime';

export interface ParticleEmitterHandle {
    objectId: string;
    componentId: string;
    /** Starts emitting from the top of its delay and cycle. */
    play(): void;
    /** Stops emitting; `clear` also removes the particles alive. */
    stop(clear?: boolean): void;
    /** A burst of `count` particles from its shape, where it is now. */
    emit(count: number): void;
    /** A burst of `count` particles from its shape placed at a world point, starting with a velocity. */
    emitAt(count: number, x: number, y: number, z: number, vx?: number, vy?: number, vz?: number): void;
    isPlaying(): boolean;
    /** Particles alive now. */
    alive(): number;
}

const scopes: Record<ParticleScope, Map<string, Map<string, ParticleEmitterHandle>>> = { editor: new Map(), runtime: new Map() };

export const particleEmitters = {
    /** Adds an emitter; returns its removal. */
    register(scope: ParticleScope, handle: ParticleEmitterHandle): () => void {
        const byObject = scopes[scope];
        const emitters = byObject.get(handle.objectId) ?? new Map<string, ParticleEmitterHandle>();
        emitters.set(handle.componentId, handle);
        byObject.set(handle.objectId, emitters);
        return () => {
            const current = byObject.get(handle.objectId);
            if (current?.get(handle.componentId) !== handle) return;
            current.delete(handle.componentId);
            if (current.size === 0) byObject.delete(handle.objectId);
        };
    },
    get(scope: ParticleScope, objectId: string, componentId: string): ParticleEmitterHandle | undefined {
        return scopes[scope].get(objectId)?.get(componentId);
    },
    /** Every emitter on an object. */
    forObject(scope: ParticleScope, objectId: string): ParticleEmitterHandle[] {
        return Array.from(scopes[scope].get(objectId)?.values() ?? []);
    },
};
