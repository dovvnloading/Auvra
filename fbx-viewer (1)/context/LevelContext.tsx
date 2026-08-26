
import React, { createContext, useContext, ReactNode } from 'react';
import { LevelData, LevelObject, LevelObjectType } from '../types';
import { useLevelManager } from '../hooks/useLevelManager';
import { useAssets } from './AssetContext';

interface LevelContextType {
  levels: LevelData[];
  currentLevelId: string | null;
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
  removeLevelObject: (id: string) => void;
  removeLevelObjects: (ids: string[]) => void;
  updateLevelObject: (id: string, updates: Partial<LevelObject>) => void;
  setLevelObjects: (objects: LevelObject[]) => void;

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
