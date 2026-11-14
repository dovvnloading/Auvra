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
    /** Editor cues control this emitter until the audition ends, including its one-shot replay policy. */
    setAuditioning?(active: boolean): void;
}

// Runtime has one handle per component. Each open editor viewport has its own handle.
const scopes: Record<ParticleScope, Map<string, Map<string, Set<ParticleEmitterHandle>>>> = { editor: new Map(), runtime: new Map() };

export const particleEmitters = {
    /** Adds an emitter; returns its removal. */
    register(scope: ParticleScope, handle: ParticleEmitterHandle): () => void {
        const byObject = scopes[scope];
        const emitters = byObject.get(handle.objectId) ?? new Map<string, Set<ParticleEmitterHandle>>();
        const views = emitters.get(handle.componentId) ?? new Set<ParticleEmitterHandle>();
        if (scope === 'runtime') views.clear();
        views.add(handle);
        emitters.set(handle.componentId, views);
        byObject.set(handle.objectId, emitters);
        return () => {
            if (!views.delete(handle) || views.size > 0) return;
            emitters.delete(handle.componentId);
            if (!emitters.size) byObject.delete(handle.objectId);
        };
    },
    get(scope: ParticleScope, objectId: string, componentId: string): ParticleEmitterHandle | undefined {
        return scopes[scope].get(objectId)?.get(componentId)?.values().next().value;
    },
    /** The same authored emitter may be previewed in several editor viewports. */
    editorViews(objectId: string, componentId: string): Iterable<ParticleEmitterHandle> {
        return scopes.editor.get(objectId)?.get(componentId) ?? [];
    },
    /** Every emitter on an object. */
    forObject(scope: ParticleScope, objectId: string): ParticleEmitterHandle[] {
        const components = scopes[scope].get(objectId);
        return components ? Array.from(components.values()).flatMap(views => [...views]) : [];
    },
};
