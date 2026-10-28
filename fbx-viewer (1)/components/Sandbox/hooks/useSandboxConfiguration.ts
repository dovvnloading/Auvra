
import { useMemo } from 'react';
import { useGameContent } from '../../../runtime/GameContentContext';
import { Blueprint, LoadedModelData, AttachmentData, SocketData } from '../../../types';
import * as THREE from 'three';
import { cloneCharacterModel } from '../../../utils/mountedParts';

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

/** The requested player blueprint when it exists, otherwise the first 'Player Character'. */
export const selectPlayerBlueprint = (blueprints: Blueprint[], playerBlueprintId?: string): Blueprint | undefined =>
    (playerBlueprintId ? blueprints.find(bp => bp.id === playerBlueprintId) : undefined)
    ?? blueprints.find(bp => bp.type === 'Player Character');

/**
 * The enemy's model: its own copy when the enemy uses the player's model, since one object cannot
 * stand in two places or be animated by two characters at once.
 */
export const sandboxEnemyModel = (
    playerModel: LoadedModelData | undefined,
    enemyModel: LoadedModelData | undefined
): LoadedModelData | undefined => {
    if (!enemyModel || enemyModel !== playerModel) return enemyModel;
    return { ...enemyModel, object: cloneCharacterModel(enemyModel.object) };
};

export const useSandboxConfiguration = (playerBlueprintId?: string): SandboxConfiguration => {
    const { blueprints, models, attachments, sockets } = useGameContent();

    // 1. Blueprint Selection
    const playerBlueprint = useMemo(() => selectPlayerBlueprint(blueprints, playerBlueprintId), [blueprints, playerBlueprintId]);
    const enemyBlueprint = useMemo(() => blueprints.find(bp => bp.type === 'Enemy Controller'), [blueprints]);

    // 2. Model Resolution
    const playerModel = useMemo(() => models.find(m => m.id === playerBlueprint?.linkedModelId), [models, playerBlueprint]);
    const enemySource = useMemo(() => models.find(m => m.id === enemyBlueprint?.linkedModelId), [models, enemyBlueprint]);
    const enemyModel = useMemo(() => sandboxEnemyModel(playerModel, enemySource), [playerModel, enemySource]);

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
