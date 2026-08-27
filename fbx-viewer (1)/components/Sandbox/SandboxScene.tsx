
import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { AuvraCanvas } from '../../renderer/AuvraCanvas';
import { AlertTriangle, User, Skull } from 'lucide-react';
import { SandboxUI } from './SandboxUI';
import { SandboxEntityHandle } from './SandboxEntity';
import { useSandboxGame } from './hooks/useSandboxGame';
import { ProjectileManagerHandle } from './ProjectileManager';
import { useSandboxConfiguration } from './hooks/useSandboxConfiguration';
import { SandboxWorld } from './SandboxWorld';

interface SandboxSceneProps {
    visible: boolean;
}

export const SandboxScene: React.FC<SandboxSceneProps> = ({ visible }) => {
    // 1. Data Preparation
    const config = useSandboxConfiguration();
    const { playerModel, enemyModel, playerBlueprint, enemyBlueprint } = config;

    // 2. Game State Management
    const { 
        isPlaying, 
        startGame, 
        stopGame, 
        resetPositions, 
        playerApiRef, 
        enemyApiRef 
    } = useSandboxGame({ playerModel, enemyModel });

    // 3. World References (Shared between UI, GameLogic, and Renderer)
    const playerEntityRef = useRef<SandboxEntityHandle>(null);
    const enemyEntityRef = useRef<SandboxEntityHandle>(null);
    const projectileManagerRef = useRef<ProjectileManagerHandle>(null);

    // 4. HUD State
    const [playerStats, setPlayerStats] = useState({ health: 100, maxHealth: 100, stamina: 100 });
    const BOUNDARY_SIZE = 10;

    // 5. Calibration State (Aim Offset) - Now derived from Blueprint
    const aimOffset = playerBlueprint?.aimOffset || [0.5, 4.5, 1.0] as [number, number, number];
    
    const [isAiming, setIsAiming] = useState(false);

    // 6. Session Management (Reset Logic)
    const [sessionId, setSessionId] = useState(0);
    const [enemyDespawned, setEnemyDespawned] = useState(false);

    const handleStartSession = () => {
        setSessionId(prev => prev + 1); // Triggers remount of entities to reset health/materials
        setEnemyDespawned(false);
        startGame();
    };

    // Lifecycle: Reset when tab becomes visible
    useEffect(() => {
        if (visible) {
            resetPositions();
            stopGame();
        }
    }, [visible, resetPositions, stopGame]);

    // 7. Fallback UI: Missing Configuration
    if (!config.isValid || !playerBlueprint || !enemyBlueprint) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center bg-gray-950 text-gray-500 p-8">
                <AlertTriangle size={48} className="text-amber-500 mb-4" />
                <h2 className="text-xl font-bold text-gray-200 mb-2">Sandbox Configuration Incomplete</h2>
                <p className="max-w-md text-center text-sm mb-6">
                    To use the Sandbox, you need at least one <strong>Player Character</strong> and one <strong>Enemy Controller</strong> blueprint, 
                    and both must have a linked mesh model.
                </p>
                <div className="grid grid-cols-2 gap-8 text-left text-xs bg-gray-900 p-6 rounded-lg border border-gray-800">
                    <div>
                        <div className="font-bold text-blue-400 mb-2 flex items-center gap-2"><User size={14}/> Player Status</div>
                        <div>Blueprint: {config.playerBlueprint ? <span className="text-green-400">Found</span> : <span className="text-red-400">Missing</span>}</div>
                        <div>Linked Mesh: {config.playerModel ? <span className="text-green-400">Found</span> : <span className="text-red-400">Missing</span>}</div>
                    </div>
                    <div>
                        <div className="font-bold text-red-400 mb-2 flex items-center gap-2"><Skull size={14}/> Enemy Status</div>
                         <div>Blueprint: {config.enemyBlueprint ? <span className="text-green-400">Found</span> : <span className="text-red-400">Missing</span>}</div>
                        <div>Linked Mesh: {config.enemyModel ? <span className="text-green-400">Found</span> : <span className="text-red-400">Missing</span>}</div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full h-full bg-black relative cursor-default select-none">
             {visible && (
                  <AuvraCanvas
                     surfaceId="runtime-sandbox"
                     role="runtime"
                    shadows
                    dpr={[1, 1.5]}
                    gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
                 >
                    <SandboxWorld 
                        key={sessionId} // Remount world on restart
                        config={config}
                        isPlaying={isPlaying}
                        boundarySize={BOUNDARY_SIZE}
                        playerApiRef={playerApiRef}
                        enemyApiRef={enemyApiRef}
                        playerEntityRef={playerEntityRef}
                        enemyEntityRef={enemyEntityRef}
                        projectileManagerRef={projectileManagerRef}
                        onPlayerHealthChange={(current, max) => setPlayerStats(prev => ({ ...prev, health: current, maxHealth: max }))}
                        onStaminaChange={(val) => setPlayerStats(prev => ({ ...prev, stamina: val }))}
                        aimOffset={aimOffset}
                        onAimStateChange={setIsAiming}
                    />
                  </AuvraCanvas>
             )}

             {/* UI Overlay */}
             <SandboxUI 
                isPlaying={isPlaying}
                onStart={handleStartSession}
                onStop={stopGame}
                playerBlueprint={playerBlueprint}
                enemyBlueprint={enemyBlueprint}
                playerModel={playerModel}
                enemyModel={enemyModel}
                playerStats={playerStats}
                isAiming={isAiming}
             />
        </div>
    );
};
