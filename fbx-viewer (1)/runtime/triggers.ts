import React, { createContext, useContext, useState } from 'react';
import { frontendDiagnostics } from '../diagnostics/runtime';

/**
 * Trigger overlap events for a play session. The physics world emits one 'enter' when another body
 * starts overlapping a trigger collider and one 'exit' when it stops; gameplay (the level blueprint,
 * components) subscribes. The player character reports as 'player', every other body by its LevelObject id.
 */
export type TriggerEventKind = 'enter' | 'exit';

export interface TriggerEvent {
    kind: TriggerEventKind;
    /** LevelObject id of the object whose trigger collider was overlapped. */
    triggerObjectId: string;
    otherObjectId: string | 'player';
}

export type TriggerEventListener = (event: TriggerEvent) => void;

export interface TriggerEvents {
    /** Returns the unsubscribe function. */
    subscribe(listener: TriggerEventListener): () => void;
    /** Delivers the event to every current listener, in subscription order. Throwing listeners are reported and skipped. */
    emit(event: TriggerEvent): void;
}

export const createTriggerEvents = (): TriggerEvents => {
    const listeners = new Set<TriggerEventListener>();
    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        emit(event) {
            // Copy so a listener that unsubscribes (or subscribes another) mid-delivery does not skip or repeat one.
            [...listeners].forEach(listener => {
                try {
                    listener(event);
                } catch (error) {
                    frontendDiagnostics.failure('runtime_trigger_event_listener_failed', error);
                }
            });
        },
    };
};

/** Outside a play session nothing emits; subscribing is harmless and emitting goes nowhere. */
const INERT_TRIGGER_EVENTS: TriggerEvents = {
    subscribe: () => () => undefined,
    emit: () => undefined,
};

const TriggerEventsContext = createContext<TriggerEvents | null>(null);

/** One event bus per play session. A remount (restart, level travel) starts a fresh bus with no listeners. */
export const TriggerEventsProvider: React.FC<{ children?: React.ReactNode; events?: TriggerEvents }> = ({ children, events }) => {
    const [ownEvents] = useState(createTriggerEvents);
    return React.createElement(TriggerEventsContext.Provider, { value: events ?? ownEvents }, children);
};

export const useTriggerEvents = (): TriggerEvents => useContext(TriggerEventsContext) ?? INERT_TRIGGER_EVENTS;
