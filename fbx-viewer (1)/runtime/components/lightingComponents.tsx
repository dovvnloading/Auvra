import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { LIGHT_BAKE_VOLUME_COMPONENT_TYPE } from '../lighting/bakedLighting';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/**
 * LIGHT BAKE VOLUME
 *
 * A box, centred on its object, where baked lighting places its light probes. With none in the
 * level the probes cover all of its static geometry, so a large terrain spreads them thin; boxes
 * around the places players go keep them close there. Probes go in the smallest box around all
 * of a level's volumes. Only drawn in the editor.
 */

const VOLUME_COLOR = '#f59e0b';
const VOLUME_MARK = { lightBakeVolume: true };

const size = (value: unknown): [number, number, number] =>
    Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)
        ? [value[0], value[1], value[2]]
        : [20, 8, 20];

/** The box's edges, marked so the baker reads its world bounds (see LightBaker). */
const LightBakeVolumeRender: React.FC<ComponentRenderProps> = ({ component, mode }) => {
    const [x, y, z] = size(component.props.size);
    const edges = useMemo(() => {
        const box = new THREE.BoxGeometry(x, y, z);
        const outline = new THREE.EdgesGeometry(box);
        box.dispose();
        return outline;
    }, [x, y, z]);
    useEffect(() => () => edges.dispose(), [edges]);
    if (mode !== 'editor') return null;
    return (
        <lineSegments geometry={edges} userData={VOLUME_MARK} raycast={() => undefined}>
            <lineBasicMaterial color={VOLUME_COLOR} transparent opacity={0.8} depthWrite={false} toneMapped={false} />
        </lineSegments>
    );
};

export const LIGHTING_COMPONENTS: ComponentDefinition[] = [
    {
        type: LIGHT_BAKE_VOLUME_COMPONENT_TYPE,
        label: 'Light Bake Volume',
        description: 'Where baked lighting puts its light probes. Without one the probes cover the whole level; boxes around where players go keep them close together there.',
        props: [
            { key: 'size', label: 'Size (m)', type: 'vector3', default: [20, 8, 20] },
        ],
        Render: LightBakeVolumeRender,
    },
];
