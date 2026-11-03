import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useRapier } from '@react-three/rapier';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { usePhysicsAvailable } from '../../runtime/physicsQueries';
import { buildRagdollPlan, createRagdoll, type Ragdoll } from '../../runtime/ragdoll';

const RagdollBody: React.FC<{ model: THREE.Object3D; onUnavailable?: () => void }> = ({ model, onUnavailable }) => {
    const { world, rapier } = useRapier();
    const ragdoll = useRef<Ragdoll | null>(null);
    const unavailable = useRef(onUnavailable);
    unavailable.current = onUnavailable;

    useEffect(() => {
        const plan = buildRagdollPlan(model);
        if (!plan) {
            unavailable.current?.();
            return undefined;
        }
        try {
            ragdoll.current = createRagdoll(world, rapier, plan);
        } catch (error) {
            frontendDiagnostics.failure('ragdoll_create_failed', error);
            unavailable.current?.();
            return undefined;
        }
        return () => {
            ragdoll.current?.dispose();
            ragdoll.current = null;
        };
    }, [model, rapier, world]);

    // Default priority: after the animation graph (priority -1), so the ragdoll's pose wins.
    useFrame(() => ragdoll.current?.step());
    return null;
};

/**
 * While mounted, the character's skeleton is driven by a ragdoll in the play session's physics world.
 * `onUnavailable` runs when there is no physics world or the model is not a humanoid skeleton, so the
 * caller can fall back to the death animation.
 */
export const CharacterRagdoll: React.FC<{ model: THREE.Object3D; onUnavailable?: () => void }> = ({ model, onUnavailable }) => {
    const available = usePhysicsAvailable();
    useEffect(() => {
        if (!available) onUnavailable?.();
    }, [available, onUnavailable]);
    return available ? <RagdollBody model={model} onUnavailable={onUnavailable} /> : null;
};
