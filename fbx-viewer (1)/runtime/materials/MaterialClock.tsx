import React from 'react';
import { useFrame } from '@react-three/fiber';
import { MATERIAL_TIME } from './graphMaterial';

/** When material time starts. Shared by every canvas, so views open at once agree on the time. */
const MATERIAL_EPOCH = performance.now();

/** Advances the time material graphs' Time nodes read. AuvraCanvas mounts one in every canvas. */
export const MaterialClock: React.FC = () => {
    useFrame(() => {
        MATERIAL_TIME.value = (performance.now() - MATERIAL_EPOCH) / 1000;
    });
    return null;
};
