
import React, { useMemo, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { Grid, Environment } from '@react-three/drei';
import { useScene } from '../../context/SceneContext';
import { ModelViewer } from './ModelViewer';
import { SceneCamera } from './SceneCamera';
import { ProjectileManager, ProjectileManagerHandle } from '../Sandbox/ProjectileManager';

interface ViewerSceneProps {
  activeClip: THREE.AnimationClip | null;
  isPlaying: boolean;
  timeScale: number;
  cameraMode: 'orbit' | 'free';
  resetTrigger: number;
}

export const ViewerScene: React.FC<ViewerSceneProps> = ({ 
  activeClip, 
  isPlaying, 
  timeScale,
  cameraMode,
  resetTrigger
}) => {
  const { models, selectedModelId, blueprints, debugProjectile } = useScene();
  const projectileRef = useRef<ProjectileManagerHandle>(null);

  // Trigger firing when debugProjectile changes
  useEffect(() => {
      if (debugProjectile.trigger > 0 && projectileRef.current) {
          const origin = new THREE.Vector3(...debugProjectile.origin);
          const direction = new THREE.Vector3(...debugProjectile.direction);
          // Pass team 'Player' and damage 0 for debug projectiles
          projectileRef.current.fire(origin, direction, 20, 'Player', 0); 
      }
  }, [debugProjectile]);

  // Safety Check: Ensure models are unique by ID AND placed in scene
  const uniqueVisibleModels = useMemo(() => {
      const seen = new Set<string>();
      return models.filter(m => {
          if (!m.isPlacedInScene) return false; // Only show if placed
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
      });
  }, [models]);

  return (
    <div className="w-full h-full bg-gray-950 relative">
        <Canvas
            shadows
            camera={{ position: [4, 4, 8], fov: 45 }}
            dpr={[1, 2]}
            gl={{ 
                preserveDrawingBuffer: true, 
                toneMapping: THREE.ACESFilmicToneMapping,
                toneMappingExposure: 1.0, 
                antialias: true
            }}
        >
            {/* Neutral background */}
            <color attach="background" args={['#0a0a0a']} />
            
            <fog attach="fog" args={['#0a0a0a', 10, 80]} />
            
            <Environment preset="city" background={false} blur={0.8} />

            <ambientLight intensity={0.5} />
            <directionalLight 
                position={[10, 10, 5]} 
                intensity={1.5} 
                castShadow 
                shadow-bias={-0.0001}
            />

            <group position={[0, -0.2, 0]}>
                <Grid 
                    infiniteGrid 
                    cellSize={1} 
                    sectionSize={5} 
                    fadeDistance={100} 
                    sectionColor="#666666" 
                    cellColor="#2a2a2a" 
                />
            </group>
                
            {uniqueVisibleModels.map((model) => {
                // Find if a blueprint controls this model
                const controllingBlueprint = blueprints.find(bp => bp.linkedModelId === model.id);
                const isVisible = selectedModelId === model.id || selectedModelId === null;

                // STRICT: Return null if not visible. 
                if (!isVisible) return null;
                
                return (
                    <group key={model.id}>
                            <ModelViewer 
                            data={model} 
                            isSelected={selectedModelId === model.id}
                            activeClip={selectedModelId === model.id ? activeClip : null}
                            isPlaying={selectedModelId === model.id ? isPlaying : false}
                            timeScale={timeScale}
                            blueprint={controllingBlueprint}
                            />
                    </group>
                );
            })}
            
            {/* Visual Projectiles for Testing */}
            <ProjectileManager ref={projectileRef} />

            <SceneCamera mode={cameraMode} resetTrigger={resetTrigger} />
        </Canvas>
    </div>
  );
};
