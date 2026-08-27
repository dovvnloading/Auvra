import React from 'react';
import { Environment, Lightformer } from '@react-three/drei';

export interface LocalEnvironmentProps {
    /** Select the cooler, lower-energy night rig used by SkySystem. */
    night?: boolean;
    /** Scalar for the local reflection contribution. */
    intensity?: number;
}

/**
 * Deterministic editor lighting with no asset loaders. Environment's children
 * are rendered into a local cube render target; unlike an asset-based path this
 * never resolves a Drei HDR URL or touches the network.
 */
export const LocalEnvironment: React.FC<LocalEnvironmentProps> = ({ night = false, intensity = 0.8 }) => {
    const keyColor = night ? '#5271a8' : '#fff4dc';
    const fillColor = night ? '#172a4d' : '#b9d7ff';
    const sunIntensity = night ? 0.6 : 1.4;

    return (
        <Environment background={false} resolution={64} frames={1} environmentIntensity={intensity}>
            <Lightformer form="rect" intensity={sunIntensity} color={keyColor} position={[4, 6, 3]} scale={[5, 5, 1]} />
            <Lightformer form="rect" intensity={0.8} color={fillColor} position={[-4, 2, 2]} scale={[4, 3, 1]} />
            <Lightformer form="rect" intensity={0.35} color={night ? '#0b1630' : '#526b86'} position={[0, 1, -4]} scale={[3, 3, 1]} />
        </Environment>
    );
};
