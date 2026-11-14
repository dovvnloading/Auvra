import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { LevelObject } from '../../types';
import { resolveParticleEffect, type ParticleForceField, type ParticleSpace } from '../../runtime/particleEffect';
import { applyParticleForceFields, PARTICLE_FORCE_FIELD_FLOATS, prepareParticleForceFields } from '../../runtime/particleForceFields';

const FIELD_COLORS = { radial: '#fbbf24', vortex: '#c084fc', directional: '#38bdf8', curl: '#34d399' };
const NO_PICK = () => undefined;
const SEGMENTS = 64;
// A fixed time makes changes to the seed, scale and evolution comparable even while preview is paused.
const FLOW_PREVIEW_SECONDS = 1;

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

const curlSamples: number[] = [];
for (const x of [-0.66, -0.22, 0.22, 0.66]) {
    for (const y of [-0.66, -0.22, 0.22, 0.66]) {
        for (const z of [-0.66, -0.22, 0.22, 0.66]) {
            if (x * x + y * y + z * z < 1) curlSamples.push(x, y, z);
        }
    }
}

/** Samples one field alone, then draws the directions and relative strengths at those locations in a unit sphere. */
function curlArrows(field: ParticleForceField): Float32Array {
    const count = curlSamples.length / 3;
    const packed = new Float32Array(PARTICLE_FORCE_FIELD_FLOATS);
    // The bounds' scene transform later supplies the emitter and field center.
    const active = prepareParticleForceFields([{ ...field, center: [0, 0, 0] }], null, packed, FLOW_PREVIEW_SECONDS);
    if (!active) return new Float32Array();
    const positions = Float32Array.from(curlSamples, n => n * field.radius);
    const acceleration = new Float32Array(positions.length);
    const ages = new Float32Array(count), lifetimes = new Float32Array(count).fill(Infinity);
    applyParticleForceFields(packed, active, 1, count, positions, acceleration, ages, lifetimes);

    const direction = new THREE.Vector3(), side = new THREE.Vector3();
    const base = new THREE.Vector3(), tip = new THREE.Vector3(), wing = new THREE.Vector3();
    let peak = 0;
    for (let i = 0; i < acceleration.length; i += 3) peak = Math.max(peak, direction.fromArray(acceleration, i).length());
    const segments: number[] = [];
    for (let i = 0; i < acceleration.length; i += 3) {
        direction.fromArray(acceleration, i);
        const magnitude = direction.length();
        if (magnitude <= peak * 0.015) continue;
        direction.multiplyScalar(1 / magnitude);
        // Normalize the displayed length against the strongest sample so a weak field remains legible.
        const length = 0.28 * Math.sqrt(magnitude / peak);
        base.fromArray(curlSamples, i);
        tip.copy(base).addScaledVector(direction, length);
        side.set(0, 1, 0);
        if (Math.abs(direction.y) > 0.85) side.set(1, 0, 0);
        side.cross(direction).normalize();
        segments.push(base.x, base.y, base.z, tip.x, tip.y, tip.z);
        for (const sign of [-1, 1]) {
            wing.copy(tip).addScaledVector(direction, -0.27 * length).addScaledVector(side, sign * 0.12 * length);
            segments.push(tip.x, tip.y, tip.z, wing.x, wing.y, wing.z);
        }
    }
    return Float32Array.from(segments);
}

const FieldBounds: React.FC<{ node: THREE.Object3D; field: ParticleForceField; space: ParticleSpace }> = ({ node, field, space }) => {
    const group = useRef<THREE.Group>(null);
    const center = useMemo(() => new THREE.Vector3(), []);
    const radius = useMemo(() => new THREE.Vector3().setScalar(field.radius), [field.radius]);
    const arrows = useMemo(() => {
        if (field.kind !== 'curl') return null;
        const positions = curlArrows(field);
        if (!positions.length) return null;
        const geometry = new THREE.BufferGeometry();
        return geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    }, [field]);
    useEffect(() => () => arrows?.dispose(), [arrows]);
    useFrame(() => {
        const bounds = group.current;
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
        <group ref={group} matrixAutoUpdate={false} userData={{ ignorePlacement: true }}>
            <lineSegments raycast={NO_PICK}>
                <bufferGeometry><bufferAttribute attach="attributes-position" args={[sphereLines, 3]} /></bufferGeometry>
                <lineBasicMaterial color={FIELD_COLORS[field.kind]} transparent opacity={0.7} depthWrite={false} toneMapped={false} />
            </lineSegments>
            {arrows && <lineSegments geometry={arrows} raycast={NO_PICK}>
                <lineBasicMaterial color={FIELD_COLORS.curl} transparent opacity={0.85} depthWrite={false} toneMapped={false} />
            </lineSegments>}
        </group>
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
