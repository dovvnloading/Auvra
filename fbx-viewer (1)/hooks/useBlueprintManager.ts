
import { useState, useCallback } from 'react';
import { Blueprint, BlueprintType } from '../types';
import { dbOperations } from '../utils/db';
import { projectService } from '../utils/projectService';
import { DEFAULT_BLUEPRINTS, PLAYER_GRAPH, ENEMY_GRAPH } from '../data/blueprints';
import { frontendDiagnostics } from '../diagnostics/runtime';

export const useBlueprintManager = (
  selectedBlueprintId: string | null,
  selectBlueprint: (id: string | null) => void,
  clearSelectedBlueprint: (id: string) => void,
) => {
  const [blueprints, setBlueprints] = useState<Blueprint[]>(DEFAULT_BLUEPRINTS);

  const addBlueprint = useCallback(async (type: BlueprintType) => {
    projectService.assertWritable();
    const isPlayer = type === 'Player Character';
    
    // ENFORCE SINGLETON PLAYER CONSTRAINT
    if (isPlayer && blueprints.some(bp => bp.type === 'Player Character')) {
        frontendDiagnostics.warning('duplicate_player_blueprint_blocked');
        return; 
    }

    const graphTemplate = isPlayer ? PLAYER_GRAPH : ENEMY_GRAPH;

    const newBP: Blueprint = {
      id: crypto.randomUUID(),
      name: isPlayer ? 'New Player' : 'New Enemy',
      type: type,
      description: 'A new blueprint instance.',
      linkedModelId: null,
      stats: isPlayer
        ? [{ id: crypto.randomUUID(), name: 'Health', value: 100 }]
        : [{ id: crypto.randomUUID(), name: 'Health', value: 50 }],
      traits: [],
      variables: JSON.parse(JSON.stringify(graphTemplate.variables)),
      animationGraph: JSON.parse(JSON.stringify(graphTemplate)),
      meshScale: 1.0,
      aimOffset: isPlayer ? [0.5, 4.5, 1.0] : undefined // Initialize aimOffset for players
    };
    
    try {
        await dbOperations.saveBlueprint(newBP);
        setBlueprints(prev => [...prev, newBP]);
        selectBlueprint(newBP.id);
    } catch (err) {
        frontendDiagnostics.failure('blueprint_add_failed', err);
    }
  }, [blueprints, selectBlueprint]);

  const updateBlueprint = useCallback((id: string, updates: Partial<Blueprint>) => {
    projectService.assertWritable();
    setBlueprints(prev => prev.map(bp => {
        if (bp.id === id) {
            const updated = { ...bp, ...updates };
            // Save to DB asynchronously
            dbOperations.saveBlueprint(updated).catch((err) => frontendDiagnostics.failure('blueprint_save_failed', err));
            return updated;
        }
        return bp;
    }));
  }, []);

  const removeBlueprint = useCallback((id: string) => {
    projectService.assertWritable();
    // 1. Optimistic Update
    setBlueprints(prev => prev.filter(bp => bp.id !== id));
    
    // 2. Handle Selection
    clearSelectedBlueprint(id);

    // 3. Persist
    dbOperations.deleteBlueprint(id).catch(err => {
        frontendDiagnostics.failure('blueprint_delete_failed', err);
    });
  }, [clearSelectedBlueprint]);

  const unlinkModelFromBlueprints = useCallback((modelId: string) => {
    setBlueprints(prev => {
        const next = prev.map(bp => bp.linkedModelId === modelId ? { ...bp, linkedModelId: null } : bp);
        return next;
    });
  }, []);

  return frontendDiagnostics.traceActions('blueprint_manager', {
    blueprints,
    setBlueprints, // Exposed for persistence layer
    selectedBlueprintId,
    setSelectedBlueprintId: selectBlueprint,
    addBlueprint,
    updateBlueprint,
    removeBlueprint,
    unlinkModelFromBlueprints
  });
};
