
import { useState, useCallback } from 'react';
import { Blueprint, BlueprintType } from '../types';
import { dbOperations } from '../utils/db';
import { DEFAULT_BLUEPRINTS, PLAYER_GRAPH, ENEMY_GRAPH } from '../data/blueprints';

export const useBlueprintManager = () => {
  const [blueprints, setBlueprints] = useState<Blueprint[]>(DEFAULT_BLUEPRINTS);
  const [selectedBlueprintId, setSelectedBlueprintId] = useState<string | null>(null);

  const addBlueprint = useCallback(async (type: BlueprintType) => {
    const isPlayer = type === 'Player Character';
    
    // ENFORCE SINGLETON PLAYER CONSTRAINT
    if (isPlayer && blueprints.some(bp => bp.type === 'Player Character')) {
        console.warn("Attempted to create multiple Player Characters. Operation blocked.");
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
        setSelectedBlueprintId(newBP.id);
    } catch (err) {
        console.error("Failed to add blueprint:", err);
    }
  }, [blueprints]);

  const updateBlueprint = useCallback((id: string, updates: Partial<Blueprint>) => {
    setBlueprints(prev => prev.map(bp => {
        if (bp.id === id) {
            const updated = { ...bp, ...updates };
            // Save to DB asynchronously
            dbOperations.saveBlueprint(updated).catch(err => console.error("Failed to save blueprint", err));
            return updated;
        }
        return bp;
    }));
  }, []);

  const removeBlueprint = useCallback((id: string) => {
    // 1. Optimistic Update
    setBlueprints(prev => prev.filter(bp => bp.id !== id));
    
    // 2. Handle Selection
    if (selectedBlueprintId === id) {
        setSelectedBlueprintId(null);
    }

    // 3. Persist
    dbOperations.deleteBlueprint(id).catch(err => {
        console.error("Failed to delete blueprint", err);
    });
  }, [selectedBlueprintId]);

  const unlinkModelFromBlueprints = useCallback((modelId: string) => {
    setBlueprints(prev => {
        const next = prev.map(bp => bp.linkedModelId === modelId ? { ...bp, linkedModelId: null } : bp);
        return next;
    });
  }, []);

  return {
    blueprints,
    setBlueprints, // Exposed for persistence layer
    selectedBlueprintId,
    setSelectedBlueprintId,
    addBlueprint,
    updateBlueprint,
    removeBlueprint,
    unlinkModelFromBlueprints
  };
};