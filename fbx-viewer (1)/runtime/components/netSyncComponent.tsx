import React, { useContext, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useNetChanges, useNetSession } from '../net/NetSessionContext';
import { applyEntityState, createInterpolationBuffer, DEFAULT_INTERPOLATION_DELAY_MS, entityStateOf, netSyncOutbox } from '../net/replication';
import { ComponentHostContext } from './builtins';
import type { ComponentDefinition, ComponentRenderProps } from './types';

const readDelay = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(1000, Math.max(0, value)) : DEFAULT_INTERPOLATION_DELAY_MS;

const NetSyncRuntime: React.FC<ComponentRenderProps> = ({ object, component }) => {
    const host = useContext(ComponentHostContext);
    const session = useNetSession();
    useNetChanges(session);
    const isHost = !session || session.isHost();
    const delay = readDelay(component.props.delay);
    const buffer = useMemo(() => createInterpolationBuffer(delay), [delay, session]);

    // The host sends this object's world transform with its player state.
    useEffect(() => {
        if (!session || !isHost) return undefined;
        netSyncOutbox.set(object.id, () => (host?.current ? entityStateOf(object.id, host.current) : null));
        return () => { netSyncOutbox.delete(object.id); };
    }, [host, isHost, object.id, session]);

    // Everyone else follows the host's states for it.
    useEffect(() => {
        if (!session || isHost) return undefined;
        return session.onState((from, frame) => {
            if (from !== session.hostId()) return;
            const state = frame.entities.find(entity => entity.id === object.id);
            if (state) buffer.push(frame.time, state);
        });
    }, [buffer, isHost, object.id, session]);

    useFrame(() => {
        if (!session || isHost || !host?.current) return;
        const state = buffer.sample(session.serverTime());
        if (state) applyEntityState(host.current, state);
    });

    return null;
};

const NetSyncRender: React.FC<ComponentRenderProps> = (props) => (props.mode === 'runtime' ? <NetSyncRuntime {...props} /> : null);

/**
 * Replicates an object in multiplayer games: the host sends its world position and rotation, and the
 * other players see it there, smoothed. Use it on objects only the host moves (movers, timelines,
 * scripted objects); on other players the object follows the host rather than its own components.
 */
export const NET_SYNC_COMPONENT: ComponentDefinition = {
    type: 'netSync',
    label: 'Network Sync',
    description: 'In multiplayer games the host sends this object\'s position and rotation and the other players follow it.',
    props: [
        { key: 'delay', label: 'Smoothing delay (ms)', type: 'number', default: DEFAULT_INTERPOLATION_DELAY_MS, min: 0, max: 1000, step: 10 },
    ],
    Render: NetSyncRender,
};
