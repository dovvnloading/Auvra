import { frontendDiagnostics } from '../../diagnostics/runtime';

/**
 * Timeline events. A playing timeline component emits one event each time playback crosses a key of
 * one of its event tracks; gameplay (the level blueprint, scripts, components) subscribes.
 */
export interface TimelineEvent {
    /** LevelObject id of the object carrying the timeline component. */
    timelineObjectId: string;
    /** The event key's name. */
    name: string;
}

export type TimelineEventListener = (event: TimelineEvent) => void;

export interface TimelineEvents {
    /** Delivers the event to every current listener, in subscription order. A listener that throws is reported and skipped. */
    emit(event: TimelineEvent): void;
    /** Returns the unsubscribe function. */
    subscribe(listener: TimelineEventListener): () => void;
}

export const createTimelineEvents = (): TimelineEvents => {
    const listeners = new Set<TimelineEventListener>();
    return {
        emit(event) {
            // Copy so a listener that unsubscribes (or subscribes another) mid-delivery does not skip or repeat one.
            [...listeners].forEach(listener => {
                try {
                    listener(event);
                } catch (error) {
                    frontendDiagnostics.failure('runtime_timeline_event_listener_failed', error);
                }
            });
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
};

/** The app-wide bus every timeline component emits its events on. */
export const timelineEvents = createTimelineEvents();
