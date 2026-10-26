
import React, { createContext, useContext, ReactNode } from 'react';
import { LevelData, LevelObject, LevelObjectType } from '../types';
import { useLevelManager } from '../hooks/useLevelManager';
import { useAssets } from './AssetContext';

interface LevelContextType {
  levels: LevelData[];
  currentLevelId: string | null;
  getCurrentLevelId: () => string | null;
  levelObjects: LevelObject[];
  
  createLevel: (name: string) => Promise<void>;
  loadLevel: (id: string) => Promise<void>;
  deleteLevel: (id: string) => Promise<void>;
  
  addLevelObject: (
      modelId: string, 
      position: [number, number, number], 
      rotation: [number, number, number], 
      scale: [number, number, number],
      type?: LevelObjectType,
      extraData?: any
  ) => Promise<string | undefined>;
  /** Insert complete documents (ids, parents, components kept) as one undo step; resolves to the inserted ids. */
  addLevelObjects: (objects: LevelObject[]) => Promise<string[]>;
  /** Deletes the object and all of its descendants. */
  removeLevelObject: (id: string) => void;
  /** Deletes the objects and all of their descendants as one undo step. */
  removeLevelObjects: (ids: string[]) => void;
  updateLevelObject: (id: string, updates: Partial<LevelObject>) => void;
  /** Persist debounced level edits now; rejects (after notifying) if any write failed. */
  flushPendingLevelEdits: (options?: { notify?: boolean }) => Promise<void>;
  hydrateProjectState: (levels: LevelData[], objects: LevelObject[], currentLevelId?: string | null) => void;

  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  snapshotHistory: () => void;
  
  activeLevelBlueprint: any;
  updateLevelBlueprint: (data: any) => void;
}

const LevelContext = createContext<LevelContextType | undefined>(undefined);

export const useLevel = () => {
  const context = useContext(LevelContext);
  if (!context) throw new Error('useLevel must be used within LevelProvider');
  return context;
};

export const LevelProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { models } = useAssets();
  const levelManager = useLevelManager(models);

  return (
    <LevelContext.Provider value={levelManager}>
      {children}
    </LevelContext.Provider>
  );
};
