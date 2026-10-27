import { frontendDiagnostics } from '../diagnostics/runtime';

/**
 * Animation notify events. The animation graph emits one event each time playback of a state's clip
 * crosses one of its notifies (a footstep, a hit frame); gameplay (the level blueprint, audio,
 * components) subscribes.
 */
export interface AnimationEvent {
    /** LevelObject id of the animated object; null when it has none (e.g. the editor preview). */
    objectId: string | null;
    /** Name of the graph state whose clip raised the notify. */
    stateName: string;
    /** The notify's name. */
    name: string;
}

export type AnimationEventListener = (event: AnimationEvent) => void;

export interface AnimationEvents {
    /** Delivers the event to every current listener, in subscription order. A listener that throws is reported and skipped. */
    emit(event: AnimationEvent): void;
    /** Returns the unsubscribe function. */
    subscribe(listener: AnimationEventListener): () => void;
}

export const createAnimationEvents = (): AnimationEvents => {
    const listeners = new Set<AnimationEventListener>();
    return {
        emit(event) {
            // Copy so a listener that unsubscribes (or subscribes another) mid-delivery does not skip or repeat one.
            [...listeners].forEach(listener => {
                try {
                    listener(event);
                } catch (error) {
                    frontendDiagnostics.failure('runtime_animation_event_listener_failed', error);
                }
            });
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
};

/** The app-wide bus every animation graph emits notifies on. */
export const animationEvents = createAnimationEvents();
