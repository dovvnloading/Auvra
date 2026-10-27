import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { SkeletonUtils } from 'three-stdlib';
import type { GraphRuntimeAPI } from '../../components/AnimationGraph/GraphRuntime';
import { SandboxEntity } from '../../components/Sandbox/SandboxEntity';
import type { AttachmentData, Blueprint, LoadedModelData, SocketData } from '../../types';
import { useNetChanges, useNetSession } from './NetSessionContext';
import { playerEntityId, type NetEntityState, type NetVec3 } from './protocol';
import { applyEntityState, createInterpolationBuffer, entityStateOf, netSyncOutbox, type InterpolationBuffer } from './replication';

/** Animation graph inputs a player avatar carries over the network. */
export const REPLICATED_PLAYER_VARS = ['Speed', 'InputX', 'InputY', 'IsJumping', 'IsGrounded', 'IsFalling', 'VerticalSpeed', 'IsSprinting', 'IsAiming', 'IsFiring', 'IsDead'] as const;

/** The player's replicated animation inputs, read from its graph. */
export const playerVars = (api: Pick<GraphRuntimeAPI, 'getVariable'> | undefined): Record<string, number | boolean> => {
    const vars: Record<string, number | boolean> = {};
    if (!api) return vars;
    for (const name of REPLICATED_PLAYER_VARS) {
        const value = api.getVariable(name);
        if (typeof value === 'number' ? Number.isFinite(value) : typeof value === 'boolean') vars[name] = value as number | boolean;
    }
    return vars;
};

/**
 * Sends this peer's player (and, on the host, every netSync object) to the others each frame; the
 * session throttles the rate. Renders nothing; does nothing without a connected session.
 */
export const LocalPlayerReplicator: React.FC<{ playerObject: THREE.Object3D; playerApiRef: React.MutableRefObject<GraphRuntimeAPI | undefined> }> = ({ playerObject, playerApiRef }) => {
    const session = useNetSession();
    const last = useRef<THREE.Vector3 | null>(null);
    useFrame((_state, delta) => {
        if (!session || session.status() !== 'connected') return;
        const selfId = session.selfId();
        if (!selfId) return;
        const position = playerObject.getWorldPosition(new THREE.Vector3());
        const step = Math.max(delta, 1e-3);
        const velocity: NetVec3 | undefined = last.current
            ? [(position.x - last.current.x) / step, (position.y - last.current.y) / step, (position.z - last.current.z) / step]
            : undefined;
        last.current = position;
        const entities: NetEntityState[] = [{ ...entityStateOf(playerEntityId(selfId), playerObject, velocity), vars: playerVars(playerApiRef.current) }];
        if (session.isHost()) {
            for (const read of netSyncOutbox.values()) {
                const state = read();
                if (state) entities.push(state);
            }
        }
        session.sendState(entities);
    });
    return null;
};

interface PlayerAssets {
    model: LoadedModelData;
    blueprint: Blueprint;
    attachments: AttachmentData[];
    sockets: SocketData[];
}

const RemoteAvatar: React.FC<{ buffer: InterpolationBuffer; player: PlayerAssets; allClips: THREE.AnimationClip[] }> = ({ buffer, player, allClips }) => {
    const session = useNetSession();
    const model = useMemo(() => {
        const object = SkeletonUtils.clone(player.model.object) as THREE.Group;
        return { ...player.model, object, id: `remote_${object.uuid}` };
    }, [player.model]);
    const api = useRef<GraphRuntimeAPI | undefined>(undefined);

    useFrame(() => {
        if (!session) return;
        const state = buffer.sample(session.serverTime());
        if (!state) return;
        applyEntityState(model.object, state);
        if (state.vars && api.current) for (const [name, value] of Object.entries(state.vars)) api.current.setVariable(name, value);
    });

    return (
        <SandboxEntity
            model={model}
            blueprint={player.blueprint}
            attachments={player.attachments}
            sockets={player.sockets}
            allClips={allClips}
            startPosition={[0, 0, 0]}
            startRotation={[0, 0, 0]}
            team="Player"
            color="#22c55e"
            remote
            onApiReady={(ready) => { api.current = ready; }}
        />
    );
};

/** Draws every other peer's player avatar from the states they send, animated by their graph inputs. */
export const RemotePlayers: React.FC<{ player: PlayerAssets; allClips: THREE.AnimationClip[] }> = ({ player, allClips }) => {
    const session = useNetSession();
    useNetChanges(session);
    const buffers = useRef(new Map<string, InterpolationBuffer>());
    const [, setVersion] = useState(0);

    useEffect(() => {
        if (!session) return undefined;
        buffers.current.clear();
        return session.onState((from, frame) => {
            const own = frame.entities.find(entity => entity.id === playerEntityId(from));
            if (!own) return;
            let buffer = buffers.current.get(from);
            if (!buffer) {
                buffer = createInterpolationBuffer();
                buffers.current.set(from, buffer);
                setVersion(version => version + 1);
            }
            buffer.push(frame.time, own);
        });
    }, [session]);

    if (!session) return null;
    // Peers that left are dropped; their buffers go with them.
    const present = new Set(session.peers().map(peer => peer.id));
    for (const id of [...buffers.current.keys()]) if (!present.has(id)) buffers.current.delete(id);
    return (
        <>
            {[...buffers.current].map(([peerId, buffer]) => (
                <RemoteAvatar key={peerId} buffer={buffer} player={player} allClips={allClips} />
            ))}
        </>
    );
};
