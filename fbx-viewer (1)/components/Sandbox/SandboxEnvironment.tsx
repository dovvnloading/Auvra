
import React, { useMemo } from 'react';
import { Grid } from '@react-three/drei';
import { NavMeshVisualizer } from './NavMeshVisualizer';
import { useScene } from '../../context/SceneContext';
import { LevelObjectRenderer } from '../Environment/LevelObjectRenderer';

interface SandboxEnvironmentProps {
    boundarySize: number;
}

export const SandboxEnvironment: React.FC<SandboxEnvironmentProps> = ({ boundarySize }) => {
    const { levelObjects, models } = useScene();

    // Optimize lookups
    const modelMap = useMemo(() => {
        const map = new Map();
        models.forEach(m => map.set(m.id, m));
        return map;
    }, [models]);

    return (
        <group>
            <color attach="background" args={['#050505']} />
            <fog attach="fog" args={['#050505', 10, 40]} />
            
            <ambientLight intensity={0.4} />
            <directionalLight 
                position={[5, 10, 5]} 
                intensity={1.2} 
                castShadow 
                shadow-bias={-0.0001} 
            />

            <Grid 
                position={[0, -0.2, 0]}
                infiniteGrid 
                cellSize={1} 
                sectionSize={5} 
                fadeDistance={25} 
                sectionColor="#333" 
                cellColor="#111" 
            />
            
            <NavMeshVisualizer boundarySize={boundarySize} />

            {/* RENDER PLACED ENVIRONMENT OBJECTS */}
            {levelObjects.map(obj => {
                const model = modelMap.get(obj.modelId);
                if (!model) return null;
                
                return (
                    <LevelObjectRenderer 
                        key={obj.id}
                        model={model}
                        data={obj}
                        castShadow
                        receiveShadow
                    />
                );
            })}
        </group>
    );
};
