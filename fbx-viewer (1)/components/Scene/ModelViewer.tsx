
import React, { useEffect, useRef, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { LoadedModelData, Blueprint } from '../../types';
import { useScene } from '../../context/SceneContext';
import { GraphRuntime, GraphRuntimeAPI } from '../AnimationGraph/GraphRuntime';
import { AttachmentController } from './AttachmentController';
import { SocketController } from './SocketController';

interface ModelViewerProps {
  data: LoadedModelData;
  isSelected: boolean;
  activeClip: THREE.AnimationClip | null;
  isPlaying: boolean;
  timeScale: number;
  blueprint?: Blueprint | null;
}

export const ModelViewer: React.FC<ModelViewerProps> = ({ 
  data, 
  isSelected, 
  activeClip, 
  isPlaying, 
  timeScale, 
  blueprint
}) => {
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const runtimeApiRef = useRef<GraphRuntimeAPI | undefined>(undefined);
  const { attachments, sockets, models, characterFireTriggers } = useScene();
  
  // Filter attachments for this model
  const myAttachments = useMemo(() => 
    attachments.filter(a => a.parentModelId === data.id),
  [attachments, data.id]);

  // Filter sockets for this model
  const mySockets = useMemo(() => 
    sockets.filter(s => s.parentModelId === data.id),
  [sockets, data.id]);

  // Aggregate all scene clips for the Runtime (so blueprints can use shared animations)
  const allSceneClips = useMemo(() => {
    return models.flatMap(m => m.animations || []);
  }, [models]);

  // --- MODE A: Blueprint Controlled ---
  // If a blueprint is active, it takes over animation control.
  // EXCEPTION: If activeClip is explicitly set (e.g. for Socket Preview), we override the blueprint
  // to allow the user to see the specific animation they selected.
  const isBlueprintActive = !!blueprint && !activeClip;

  // --- Watch for External Fire Triggers (From Socket Panel Test) ---
  const lastFireTrigger = characterFireTriggers[data.id];
  useEffect(() => {
      if (lastFireTrigger && runtimeApiRef.current) {
          // Set IsFiring to true
          runtimeApiRef.current.setVariable('IsFiring', true);
          
          // Reset after a short delay (simulating a button press)
          const timer = setTimeout(() => {
              runtimeApiRef.current?.setVariable('IsFiring', false);
          }, 100);
          
          return () => clearTimeout(timer);
      }
  }, [lastFireTrigger]);

  // --- MODE B: Manual Control ---
  // If no blueprint (or overridden), we use standard mixer logic

  useEffect(() => {
    if (isBlueprintActive) {
        // If switching to blueprint mode, ensure manual mixer is stopped/cleared if it exists
        if (mixerRef.current) {
            mixerRef.current.stopAllAction();
            mixerRef.current = null;
        }
        return;
    }

    // Initialize mixer if needed
    if (!mixerRef.current && data.object) {
      mixerRef.current = new THREE.AnimationMixer(data.object);
    }

    const mixer = mixerRef.current;
    if (mixer) {
      mixer.stopAllAction();
      
      if (activeClip) {
        const action = mixer.clipAction(activeClip);
        action.reset().fadeIn(0.2).play();
      }
    }

    return () => {
        // Cleanup on unmount or mode switch
        if (mixerRef.current) {
             mixerRef.current.stopAllAction();
        }
    };
  }, [data.object, isBlueprintActive, activeClip]);

  useFrame((_, delta) => {
    // Update Manual Mixer
    if (!isBlueprintActive && mixerRef.current && isPlaying) {
        mixerRef.current.timeScale = timeScale;
        mixerRef.current.update(delta);
    }
  });

  const finalScale = useMemo(() => {
      const base = data.initialScale || [1, 1, 1];
      const mult = blueprint?.meshScale || 1.0;
      return [base[0] * mult, base[1] * mult, base[2] * mult] as [number, number, number];
  }, [data.initialScale, blueprint?.meshScale]);

  return (
    <group>
         <primitive object={data.object} scale={finalScale} />

         {/* Attachments */}
         {myAttachments.map(att => (
             <AttachmentController 
                key={att.id} 
                data={att} 
                parentObject={data.object} 
             />
         ))}

         {/* Sockets (Visible when selected) */}
         {isSelected && mySockets.map(sock => (
             <SocketController
                key={sock.id}
                data={sock}
                parentObject={data.object}
             />
         ))}

         {/* Blueprint Runtime Engine */}
         {isBlueprintActive && blueprint && (
             <GraphRuntime 
                modelObject={data.object}
                graph={blueprint.animationGraph}
                allClips={allSceneClips}
                enableInputs={false} // Main scene viewer is passive
                apiRef={runtimeApiRef}
             />
         )}
    </group>
  );
};