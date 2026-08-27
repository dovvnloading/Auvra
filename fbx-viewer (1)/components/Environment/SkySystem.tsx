
import React, { useMemo } from 'react';
import * as THREE from 'three';
import { Sky } from '@react-three/drei';
import { LevelObject, SkyConfig } from '../../types';
import { LocalEnvironment } from '../Scene/LocalEnvironment';

interface SkySystemProps {
    levelObjects: LevelObject[];
}

export const DEFAULT_SKY_CONFIG: SkyConfig = {
    timeOfDay: 14, // 2 PM
    sunIntensity: 1.5,
    ambienceIntensity: 0.5,
    sunColor: '#ffffff',
    fogColor: '#050505',
    fogDensity: 0.02,
    turbidity: 8,
    rayleigh: 1, // Changed default from 3 to 1 for better blue sky
    mieCoefficient: 0.005,
    mieDirectionalG: 0.7,
    inclination: 0.49, // 0.49 ensures sun goes overhead properly
    azimuth: 0.25
};

export const SkySystem: React.FC<SkySystemProps> = ({ levelObjects }) => {
    // 1. Find the Sky Sphere object (First one wins)
    const skyObject = useMemo(() => {
        return levelObjects.find(obj => obj.type === 'sky_sphere');
    }, [levelObjects]);

    // 2. Resolve Configuration
    const config: SkyConfig = skyObject?.skyConfig || DEFAULT_SKY_CONFIG;

    // 3. Calculate Sun Position based on Time of Day (0-24)
    const sunPosition = useMemo(() => {
        const time = config.timeOfDay;
        // 6AM = 0, 12PM = PI/2, 6PM = PI, 12AM = 3PI/2
        // Map 0..24 to 0..2PI relative to sunrise at 6
        const theta = ((time - 6) / 24) * Math.PI * 2;
        
        const r = 100;
        const x = r * Math.cos(theta);
        const y = r * Math.sin(theta);
        const z = 0; // Keeping it simple on XY plane for Day/Night arc

        // Apply azimuth rotation
        const pos = new THREE.Vector3(x, y, z);
        pos.applyAxisAngle(new THREE.Vector3(0, 1, 0), config.azimuth * Math.PI * 2);
        
        return pos;
    }, [config.timeOfDay, config.azimuth]);

    const isNight = config.timeOfDay < 6 || config.timeOfDay > 18;

    // Default Fallback if no sky object exists (Standard Editor Lighting)
    if (!skyObject) {
        return (
            <>
                <color attach="background" args={['#050505']} />
                <fog attach="fog" args={['#050505', 10, 60]} />
                <ambientLight intensity={0.4} />
                <directionalLight position={[10, 20, 10]} intensity={1.2} castShadow shadow-bias={-0.0001} />
                <LocalEnvironment />
            </>
        );
    }

    return (
        <>
            {/* Background Color Sync for Fog */}
            <color attach="background" args={[config.fogColor]} />

            {/* Atmosphere */}
            <Sky 
                distance={450000} 
                sunPosition={sunPosition} 
                inclination={config.inclination} 
                azimuth={config.azimuth} 
                turbidity={config.turbidity}
                rayleigh={config.rayleigh}
                mieCoefficient={config.mieCoefficient}
                mieDirectionalG={config.mieDirectionalG}
            />

            {/* Main Sun Light */}
            <directionalLight 
                position={sunPosition} 
                intensity={config.sunIntensity} 
                color={config.sunColor}
                castShadow 
                shadow-bias={-0.0001}
                shadow-mapSize={[2048, 2048]}
            />

            {/* Ambient Light (Fill) */}
            <ambientLight intensity={config.ambienceIntensity} />

            {/* Environment Reflections (Synced roughly to time) */}
            <LocalEnvironment night={isNight} />

            {/* Scene Fog */}
            <fog attach="fog" args={[config.fogColor, 0, 1 / Math.max(0.0001, config.fogDensity * 0.5)]} />
        </>
    );
};
