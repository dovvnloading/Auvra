import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { LIGHT_BAKE_VOLUME_COMPONENT_TYPE } from '../lighting/bakedLighting';
import { DYNAMIC_GI_COMPONENT_TYPE } from '../lighting/dynamicGi/LevelDynamicGi';
import { DEFAULT_DYNAMIC_GI_SETTINGS } from '../lighting/dynamicGi/probeGrid';
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

/** Nothing of its own to draw: it lights the whole level, from LevelDynamicGi, which reads these settings. */
const DynamicGiRender: React.FC<ComponentRenderProps> = () => null;

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
    {
        type: DYNAMIC_GI_COMPONENT_TYPE,
        label: 'Dynamic Global Illumination',
        description: 'Light that bounces around the level as it plays, gathered by rays from probes around the camera: off-screen surfaces count, and it follows moving lights, objects and the time of day, with no bake.',
        props: [
            {
                key: 'quality', label: 'Quality', type: 'select', default: DEFAULT_DYNAMIC_GI_SETTINGS.quality,
                options: [{ label: 'Low', value: 'low' }, { label: 'Medium', value: 'medium' }, { label: 'High', value: 'high' }],
            },
            { key: 'spacing', label: 'Probe spacing (m)', type: 'number', default: DEFAULT_DYNAMIC_GI_SETTINGS.spacing, min: 0.5, max: 8, step: 0.25 },
            { key: 'intensity', label: 'Intensity', type: 'number', default: DEFAULT_DYNAMIC_GI_SETTINGS.intensity, min: 0, max: 8, step: 0.05 },
            { key: 'bounce', label: 'Later bounces', type: 'number', default: DEFAULT_DYNAMIC_GI_SETTINGS.bounce, min: 0, max: 1, step: 0.05 },
            {
                key: 'view', label: 'Show', type: 'select', default: DEFAULT_DYNAMIC_GI_SETTINGS.view,
                options: [
                    { label: 'The level', value: 'lit' },
                    { label: 'Indirect light only', value: 'lighting' },
                    { label: 'Light probes', value: 'probes' },
                    { label: 'What rays see', value: 'rays' },
                ],
            },
        ],
        Render: DynamicGiRender,
    },
];
