import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { LevelObject } from '../../types';
import { resolveParticleEffect, type ParticleForceField, type ParticleSpace } from '../../runtime/particleEffect';

const FIELD_COLORS = { radial: '#fbbf24', vortex: '#c084fc', directional: '#38bdf8' };
const NO_PICK = () => undefined;
const SEGMENTS = 64;

/** Three great circles outline a unit sphere. */
const sphereLines = new Float32Array(3 * SEGMENTS * 6);
for (let plane = 0; plane < 3; plane++) {
    for (let i = 0; i < SEGMENTS; i++) {
        for (let end = 0; end < 2; end++) {
            const angle = 2 * Math.PI * (i + end) / SEGMENTS;
            const offset = ((plane * SEGMENTS + i) * 2 + end) * 3;
            sphereLines[offset + plane] = Math.cos(angle);
            sphereLines[offset + (plane + 1) % 3] = Math.sin(angle);
        }
    }
}

const FieldBounds: React.FC<{ node: THREE.Object3D; field: ParticleForceField; space: ParticleSpace }> = ({ node, field, space }) => {
    const lines = useRef<THREE.LineSegments>(null);
    const center = useMemo(() => new THREE.Vector3(), []);
    const radius = useMemo(() => new THREE.Vector3().setScalar(field.radius), [field.radius]);
    useFrame(() => {
        const bounds = lines.current;
        if (!bounds) return;
        node.updateWorldMatrix(true, false);
        center.set(...field.center).applyMatrix4(node.matrixWorld);
        // World simulation keeps a spherical radius even on a scaled host.
        if (space === 'local') bounds.matrix.copy(node.matrixWorld);
        else bounds.matrix.identity();
        bounds.matrix.scale(radius).setPosition(center);
        bounds.matrixWorldNeedsUpdate = true;
    });
    return (
        <lineSegments ref={lines} matrixAutoUpdate={false} raycast={NO_PICK} userData={{ ignorePlacement: true }}>
            <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[sphereLines, 3]} />
            </bufferGeometry>
            <lineBasicMaterial color={FIELD_COLORS[field.kind]} transparent opacity={0.7} depthWrite={false} toneMapped={false} />
        </lineSegments>
    );
};

/** Editor-only guides for the selected object's enabled particle components. */
export const ParticleForceFieldOverlay: React.FC<{ object: LevelObject; node: THREE.Object3D }> = ({ object, node }) => {
    const fields = useMemo(() => (object.components ?? []).flatMap(component => {
        if (component.type !== 'particles' || !component.enabled) return [];
        const effect = resolveParticleEffect(component.props);
        return effect.forceFields.flatMap((field, index) => field.enabled && field.radius > 0
            ? [{ field, space: effect.space, key: `${component.id}/${index}` }]
            : []);
    }), [object.components]);
    return <>{fields.map(({ field, space, key }) => <FieldBounds key={key} field={field} space={space} node={node} />)}</>;
};
