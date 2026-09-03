
import { useState, useCallback, useEffect, useRef } from 'react';
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
  const blueprintsRef = useRef(blueprints);
  const playerCreationInFlightRef = useRef(false);
  const [isCreatingPlayer, setIsCreatingPlayer] = useState(false);
  useEffect(() => { blueprintsRef.current = blueprints; }, [blueprints]);

  const addBlueprint = useCallback(async (type: BlueprintType) => {
    projectService.assertWritable();
    const isPlayer = type === 'Player Character';
    
    // ENFORCE SINGLETON PLAYER CONSTRAINT
    if (isPlayer && (playerCreationInFlightRef.current || blueprintsRef.current.some(bp => bp.type === 'Player Character'))) {
        frontendDiagnostics.warning('duplicate_player_blueprint_blocked');
        return; 
    }

    if (isPlayer) {
        playerCreationInFlightRef.current = true;
        setIsCreatingPlayer(true);
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
        setBlueprints(prev => {
          const next = [...prev, newBP];
          blueprintsRef.current = next;
          return next;
        });
        selectBlueprint(newBP.id);
    } catch (err) {
        frontendDiagnostics.failure('blueprint_add_failed', err);
    } finally {
        if (isPlayer) {
            playerCreationInFlightRef.current = false;
            setIsCreatingPlayer(false);
        }
    }
  }, [selectBlueprint]);

  const updateBlueprint = useCallback(async (id: string, updates: Partial<Blueprint>) => {
    projectService.assertWritable();
    const previous = blueprintsRef.current.find((blueprint) => blueprint.id === id);
    if (!previous) return;
    const updated = { ...previous, ...updates };
    blueprintsRef.current = blueprintsRef.current.map(blueprint => blueprint.id === id ? updated : blueprint);
    setBlueprints(current => current.map(blueprint => blueprint.id === id ? updated : blueprint));
    try {
      await dbOperations.saveBlueprint(updated);
    } catch (error) {
      if (blueprintsRef.current.find((blueprint) => blueprint.id === id) === updated) {
        blueprintsRef.current = blueprintsRef.current.map(blueprint => blueprint.id === id ? previous : blueprint);
        setBlueprints(blueprintsRef.current);
      }
      frontendDiagnostics.failure('blueprint_save_failed', error);
    }
  }, [blueprints]);

  const removeBlueprint = useCallback(async (id: string) => {
    projectService.assertWritable();
    try {
      await dbOperations.deleteBlueprint(id);
      setBlueprints(prev => {
        const next = prev.filter(bp => bp.id !== id);
        blueprintsRef.current = next;
        return next;
      });
      clearSelectedBlueprint(id);
    } catch (err) {
        frontendDiagnostics.failure('blueprint_delete_failed', err);
    }
  }, [clearSelectedBlueprint]);

  const unlinkModelFromBlueprints = useCallback((modelId: string) => {
    setBlueprints(prev => {
        const next = prev.map(bp => bp.linkedModelId === modelId ? { ...bp, linkedModelId: null } : bp);
        blueprintsRef.current = next;
        return next;
    });
  }, []);

  const removeTextureReference = useCallback((textureId: string) => {
    setBlueprints(prev => prev.map(blueprint => blueprint.textureId === textureId
      ? { ...blueprint, textureId: null }
      : blueprint));
  }, []);

  const removeAudioReference = useCallback((audioId: string) => {
    setBlueprints(prev => prev.map(blueprint => {
      const weaponSounds = blueprint.weaponSounds;
      if (!weaponSounds?.includes(audioId)) return blueprint;
      return { ...blueprint, weaponSounds: weaponSounds.filter(id => id !== audioId) };
    }));
  }, []);

  return frontendDiagnostics.traceActions('blueprint_manager', {
    blueprints,
    setBlueprints, // Exposed for persistence layer
    selectedBlueprintId,
    isCreatingPlayer,
    setSelectedBlueprintId: selectBlueprint,
    addBlueprint,
    updateBlueprint,
    removeBlueprint,
    unlinkModelFromBlueprints,
    removeTextureReference,
    removeAudioReference,
  });
};
