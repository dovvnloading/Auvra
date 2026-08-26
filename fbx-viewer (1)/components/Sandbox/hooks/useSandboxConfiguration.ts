
import { useMemo } from 'react';
import { useScene } from '../../../context/SceneContext';
import { Blueprint, LoadedModelData, AttachmentData, SocketData } from '../../../types';
import * as THREE from 'three';

export interface SandboxConfiguration {
    isValid: boolean;
    playerBlueprint: Blueprint | undefined;
    enemyBlueprint: Blueprint | undefined;
    playerModel: LoadedModelData | undefined;
    enemyModel: LoadedModelData | undefined;
    playerAttachments: AttachmentData[];
    enemyAttachments: AttachmentData[];
    playerSockets: SocketData[];
    enemySockets: SocketData[];
    allClips: THREE.AnimationClip[];
}

export const useSandboxConfiguration = (): SandboxConfiguration => {
    const { blueprints, models, attachments, sockets } = useScene();

    // 1. Blueprint Selection
    const playerBlueprint = useMemo(() => blueprints.find(bp => bp.type === 'Player Character'), [blueprints]);
    const enemyBlueprint = useMemo(() => blueprints.find(bp => bp.type === 'Enemy Controller'), [blueprints]);

    // 2. Model Resolution
    const playerModel = useMemo(() => models.find(m => m.id === playerBlueprint?.linkedModelId), [models, playerBlueprint]);
    const enemyModel = useMemo(() => models.find(m => m.id === enemyBlueprint?.linkedModelId), [models, enemyBlueprint]);

    // 3. Asset Aggregation
    const allClips = useMemo(() => models.flatMap(m => m.animations || []), [models]);

    const playerAttachments = useMemo(() => 
        playerModel ? attachments.filter(a => a.parentModelId === playerModel.id) : [], 
    [playerModel, attachments]);
    
    const enemyAttachments = useMemo(() => 
        enemyModel ? attachments.filter(a => a.parentModelId === enemyModel.id) : [], 
    [enemyModel, attachments]);

    const playerSockets = useMemo(() => 
        playerModel ? sockets.filter(s => s.parentModelId === playerModel.id) : [], 
    [playerModel, sockets]);

    const enemySockets = useMemo(() => 
        enemyModel ? sockets.filter(s => s.parentModelId === enemyModel.id) : [], 
    [enemyModel, sockets]);

    const isValid = !!(playerBlueprint && enemyBlueprint && playerModel && enemyModel);

    return {
        isValid,
        playerBlueprint,
        enemyBlueprint,
        playerModel,
        enemyModel,
        playerAttachments,
        enemyAttachments,
        playerSockets,
        enemySockets,
        allClips
    };
};
