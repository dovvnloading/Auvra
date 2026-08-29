import { useState, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { GraphRuntimeAPI } from '../../AnimationGraph/GraphRuntime';
import { LoadedModelData } from '../../../types';
import { frontendDiagnostics } from '../../../diagnostics/runtime';

interface UseSandboxGameProps {
    playerModel: LoadedModelData | undefined;
    enemyModel: LoadedModelData | undefined;
}

export const useSandboxGame = ({ playerModel, enemyModel }: UseSandboxGameProps) => {
    const [isPlaying, setIsPlaying] = useState(false);
    
    // Runtime Refs
    const playerApiRef = useRef<GraphRuntimeAPI | undefined>(undefined);
    const enemyApiRef = useRef<GraphRuntimeAPI | undefined>(undefined);

    const resetPositions = useCallback(() => {
        if (playerModel?.object) {
            playerModel.object.position.set(-3, 0, 3);
            playerModel.object.rotation.set(0, Math.PI / 4, 0);
        }
        if (enemyModel?.object) {
            enemyModel.object.position.set(3, 0, -3);
            enemyModel.object.rotation.set(0, -Math.PI / 4, 0);
        }
    }, [playerModel, enemyModel]);

    const startGame = useCallback(() => {
        resetPositions();
        
        // Reset Variables
        if (playerApiRef.current) {
            playerApiRef.current.setVariable('Speed', 0);
            playerApiRef.current.setVariable('IsSprinting', false);
            playerApiRef.current.setVariable('IsJumping', false);
            playerApiRef.current.setVariable('IsFiring', false);
        }
        
        setIsPlaying(true);
    }, [resetPositions]);

    const stopGame = useCallback(() => {
        setIsPlaying(false);
        if (document.pointerLockElement) {
            document.exitPointerLock();
        }
        
        // Reset Inputs
        if (playerApiRef.current) playerApiRef.current.setVariable('Speed', 0);
        if (enemyApiRef.current) enemyApiRef.current.setVariable('Speed', 0);
    }, []);

    return {
        isPlaying,
        ...frontendDiagnostics.traceActions('sandbox', { startGame, stopGame, resetPositions }),
        playerApiRef,
        enemyApiRef
    };
};
