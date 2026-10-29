import React, { useContext, useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { findBone, IKPoseGuard, isDescendantOf } from '../ik';
import { ProceduralRig, readRigConstraints, type RigTarget } from '../proceduralRig';
import { ComponentHostContext } from './builtins';
import { IKPlayerTargetContext, useRestoreBeforeAnimation } from './ikComponents';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/**
 * PROCEDURAL RIG
 *
 * The Procedural Rig component lays the constraints of runtime/proceduralRig.ts on its object's
 * bones after their animation each frame, in play: aims, copied and offset rotations, limits, lag and
 * twist. Like the IK components it starts again from the animated pose each frame, so nothing builds
 * up on bones the animation does not move.
 */

export const PROCEDURAL_RIG_COMPONENT_TYPE = 'proceduralRig';

/** Where the player's eyes are when an aim targets the player and its head bone is not found. */
const PLAYER_EYE_HEIGHT = 1.6;

const _target = new THREE.Vector3();

const ProceduralRigRuntime: React.FC<ComponentRenderProps> = ({ object, component }) => {
    const hostRef = useContext(ComponentHostContext);
    const playerRef = useContext(IKPlayerTargetContext);
    const constraints = useMemo(() => readRigConstraints(component.props), [component.props]);
    const [rig] = useState(() => new ProceduralRig(constraints));
    const [guard] = useState(() => new IKPoseGuard());
    const [bones] = useState(() => ({ host: null as THREE.Object3D | null, byName: new Map<string, THREE.Object3D | null>() }));
    const [objects] = useState(() => new Map<string, THREE.Object3D | null>());
    useEffect(() => {
        rig.constraints = constraints;
        rig.reset();
        bones.byName.clear();
    }, [rig, constraints, bones]);
    useEffect(() => () => guard.release(), [guard]);
    useRestoreBeforeAnimation(guard);

    useFrame((frame, delta) => {
        const host = hostRef?.current;
        if (!host) return;
        if (bones.host !== host) {
            bones.host = host;
            bones.byName.clear();
        }
        // Bones by name, found once (by loose name: 'Head' finds 'mixamorig:Head') and kept while they stay under the host.
        const find = (name: string): THREE.Object3D | null => {
            if (!name) return null;
            const known = bones.byName.get(name);
            if (known !== undefined && (known === null || isDescendantOf(known, host))) return known;
            const found = findBone(host, name, node => typeof node.userData?.levelObjectId === 'string' && node.userData.levelObjectId !== object.id);
            bones.byName.set(name, found);
            return found;
        };
        const used = constraints.flatMap(constraint => [find(constraint.bone), constraint.source ? find(constraint.source) : null])
            .filter((bone): bone is THREE.Object3D => bone !== null);
        guard.begin(used);
        const targetOf = (target: RigTarget): THREE.Vector3 | null => {
            if (target.kind === 'camera') return frame.camera.getWorldPosition(_target);
            if (target.kind === 'point') return _target.fromArray(target.point);
            if (target.kind === 'player') {
                const player = playerRef?.current;
                if (!player) return frame.camera.getWorldPosition(_target);
                const head = findBone(player, 'Head');
                return head ? head.getWorldPosition(_target) : player.getWorldPosition(_target).add(new THREE.Vector3(0, PLAYER_EYE_HEIGHT, 0));
            }
            let node = objects.get(target.id);
            if (node === undefined || (node && !node.parent)) {
                node = null;
                frame.scene.traverse(candidate => { if (!node && candidate.userData?.levelObjectId === target.id) node = candidate; });
                objects.set(target.id, node);
            }
            return node ? node.getWorldPosition(_target) : null;
        };
        rig.apply(find, targetOf, delta);
        guard.commit();
    });

    return null;
};

const ProceduralRigRender: React.FC<ComponentRenderProps> = (props) => (props.mode === 'runtime' ? <ProceduralRigRuntime {...props} /> : null);

export const PROCEDURAL_RIG_COMPONENT: ComponentDefinition = {
    type: PROCEDURAL_RIG_COMPONENT_TYPE,
    label: 'Procedural Rig',
    description: "Constraints on the object's bones after its animation, in order: aim a bone at the camera, the player, an object or a point; "
        + 'copy or offset rotations; limit them; make a bone lag like something loose; spread twist along a limb. Runs in play.',
    props: [],
    Render: ProceduralRigRender,
};
