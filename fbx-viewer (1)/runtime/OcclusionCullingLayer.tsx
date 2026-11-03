import React, { createContext, useEffect, useMemo } from 'react';
import type * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { OCCLUSION_RENDER_ORDER, OcclusionQueries, type OcclusionContext } from './occlusionCulling';

/** The queries instanced sets below ask through (the game's Occlusion culling quality setting); none in the editor. */
export const OcclusionCullingContext = createContext<OcclusionQueries | null>(null);

const queryContextOf = (gl: THREE.WebGLRenderer): OcclusionContext | null => {
    const context = gl.getContext?.() as WebGL2RenderingContext | undefined;
    return context && typeof context.createQuery === 'function' ? context : null;
};

const OcclusionDriver: React.FC<{ queries: OcclusionQueries }> = ({ queries }) => {
    const gl = useThree(state => state.gl);
    // Mounted after what it covers: their sorts for the frame, and the camera's move, come first.
    useFrame(({ camera }) => queries.beginFrame(camera));
    useEffect(() => {
        const canvas = gl.domElement;
        const onLost = () => queries.forget();
        canvas.addEventListener('webglcontextlost', onLost);
        return () => canvas.removeEventListener('webglcontextlost', onLost);
    }, [gl, queries]);
    // Its own group: a group's order sorts ahead of what is inside it, so this comes after any other group's.
    return <group renderOrder={OCCLUSION_RENDER_ORDER}><primitive object={queries.driver} /></group>;
};

/** Has instanced props and foliage below skip the camera's draw while nearer surfaces hide them (occlusionCulling.ts). */
export const OcclusionCullingLayer: React.FC<{ enabled: boolean; children: React.ReactNode }> = ({ enabled, children }) => {
    const gl = useThree(state => state.gl);
    const queries = useMemo(() => {
        const context = enabled ? queryContextOf(gl) : null;
        return context ? new OcclusionQueries(context) : null;
    }, [enabled, gl]);
    useEffect(() => () => queries?.dispose(), [queries]);
    return (
        <OcclusionCullingContext.Provider value={queries}>
            {children}
            {queries && <OcclusionDriver queries={queries} />}
        </OcclusionCullingContext.Provider>
    );
};
