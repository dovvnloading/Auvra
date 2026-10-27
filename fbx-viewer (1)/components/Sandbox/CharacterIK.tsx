import React, { useContext, useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { CharacterIKSettings } from '../../types';
import { findBone, IKPoseGuard } from '../../runtime/ik';
import { usePhysicsQueries } from '../../runtime/physics';
import {
    createFootIKState,
    createLookAtIKState,
    footIKBones,
    IKPlayerTargetContext,
    resolveFootIKRig,
    updateFootIK,
    updateLookAtIK,
} from '../../runtime/components/ikComponents';

const DEFAULT_FOOT_STEP = 0.5;
const DEFAULT_LOOK_BONE = 'Head';
const DEFAULT_LOOK_ANGLE = 70;
/** Mixamo heads look along their local +Z. */
const HEAD_FORWARD = new THREE.Vector3(0, 0, 1);
const PLAYER_EYE_HEIGHT = 1.6;

/** A blueprint's IK settings with defaults filled in and numbers clamped. */
export const resolveCharacterIK = (settings: CharacterIKSettings | undefined) => {
    const finite = (value: unknown, fallback: number, min: number, max: number) =>
        typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
    return {
        footIK: settings?.footIK === true,
        footMaxStep: finite(settings?.footMaxStep, DEFAULT_FOOT_STEP, 0, 10),
        lookAt: settings?.lookAt === 'camera' || settings?.lookAt === 'player' ? settings.lookAt : 'none' as const,
        lookAtBone: settings?.lookAtBone?.trim() || DEFAULT_LOOK_BONE,
        lookAtMaxAngle: THREE.MathUtils.degToRad(finite(settings?.lookAtMaxAngle, DEFAULT_LOOK_ANGLE, 0, 180)),
    };
};

interface CharacterIKProps {
    model: THREE.Object3D;
    settings?: CharacterIKSettings;
    /** The character's own physics id, so its capsule is not taken for ground. */
    physicsId?: string;
}

const _lookTarget = new THREE.Vector3();

/**
 * Applies a character blueprint's IK after its animation graph each frame (the graph animates at
 * priority -1, this runs at the default priority): foot planting on the ground under each foot and
 * a look-at toward the camera or the player.
 */
export const CharacterIK: React.FC<CharacterIKProps> = ({ model, settings, physicsId }) => {
    const resolved = resolveCharacterIK(settings);
    const physics = usePhysicsQueries();
    const playerRef = useContext(IKPlayerTargetContext);
    const [guard] = useState(() => new IKPoseGuard());
    const [footState] = useState(createFootIKState);
    const [lookState] = useState(createLookAtIKState);
    useEffect(() => () => guard.release(), [guard, model]);

    const rig = useMemo(() => (resolved.footIK ? resolveFootIKRig(model, ['LeftFoot', 'RightFoot']) : null), [model, resolved.footIK]);
    const lookBone = useMemo(() => (resolved.lookAt !== 'none' ? findBone(model, resolved.lookAtBone) : null), [model, resolved.lookAt, resolved.lookAtBone]);
    const bones = useMemo(() => [...(rig ? footIKBones(rig) : []), ...(lookBone ? [lookBone] : [])], [rig, lookBone]);

    useFrame(({ camera }, delta) => {
        if (!bones.length) return;
        guard.begin(bones);
        if (rig) {
            updateFootIK(model, rig, physics.raycast, { maxStep: resolved.footMaxStep, weight: 1, excludeObjectId: physicsId }, footState, delta);
        }
        if (lookBone) {
            const player = resolved.lookAt === 'player' ? playerRef?.current ?? null : null;
            if (player && player !== model) {
                player.getWorldPosition(_lookTarget);
                _lookTarget.y += PLAYER_EYE_HEIGHT;
            } else {
                camera.getWorldPosition(_lookTarget);
            }
            updateLookAtIK(lookBone, _lookTarget, { maxAngle: resolved.lookAtMaxAngle, weight: 1, forward: HEAD_FORWARD }, lookState, delta);
        }
        guard.commit();
    });

    return null;
};
