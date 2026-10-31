import React, { useLayoutEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { captureLocalEnvironment } from './localEnvironmentCapture';

export interface LocalEnvironmentProps {
    /** Select the cooler, lower-energy night rig used by SkySystem. */
    night?: boolean;
    /** Scalar for the local reflection contribution. */
    intensity?: number;
}

/**
 * Deterministic editor lighting with no asset loaders: a small rig captured once into a map this component
 * owns, which never resolves an HDR URL or touches the network, and which goes when the component does.
 */
export const LocalEnvironment: React.FC<LocalEnvironmentProps> = ({ night = false, intensity = 0.8 }) => {
    const gl = useThree(state => state.gl);
    const scene = useThree(state => state.scene);

    useLayoutEffect(() => {
        const target = captureLocalEnvironment(gl, night);
        const before = scene.environment;
        scene.environment = target.texture;
        return () => {
            // Something else may have taken over since (the sky's own light): that is theirs to clear.
            if (scene.environment === target.texture) scene.environment = before;
            target.dispose();
        };
    }, [gl, scene, night]);

    useLayoutEffect(() => {
        const before = scene.environmentIntensity;
        scene.environmentIntensity = intensity;
        return () => { scene.environmentIntensity = before; };
    }, [scene, intensity]);

    return null;
};
