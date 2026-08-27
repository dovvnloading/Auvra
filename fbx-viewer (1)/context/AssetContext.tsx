
import React, { createContext, useContext, ReactNode, useState, useCallback } from 'react';
import { 
    LoadedModelData, AttachmentData, SocketData, TextureData, AudioData, Blueprint, 
    AssetCategory, AnimationGraphData, DebugProjectile 
} from '../types';
import { useModelManager } from '../hooks/useModelManager';
import { useAttachmentManager } from '../hooks/useAttachmentManager';
import { useSocketManager } from '../hooks/useSocketManager';
import { useTextureManager } from '../hooks/useTextureManager';
import { useAudioManager } from '../hooks/useAudioManager';
import { useBlueprintManager } from '../hooks/useBlueprintManager';
import { useGraphManager } from '../hooks/useGraphManager';
import { useDebugTools } from '../hooks/useDebugTools';
import { useSelection } from './SelectionContext';

interface AssetContextType {
  // Models
  models: LoadedModelData[];
  addModel: (file: File, category: AssetCategory) => Promise<void>;
  removeModel: (id: string) => void;
  placeInScene: (id: string) => void; 
  removeFromScene: (id: string) => void; 
  addAnimations: (files: File[], modelId: string) => Promise<void>;
  retextureModel: (modelId: string, textureUrl: string, targetTextureUuid?: string) => Promise<void>;
  resetModelTexture: (modelId: string) => Promise<void>;
  setModels: (models: LoadedModelData[]) => void;

  // Attachments
  attachments: AttachmentData[];
  addAttachment: (file: File, parentModelId: string) => Promise<void>;
  addAttachmentFromLibrary: (sourceModelId: string, parentModelId: string) => Promise<void>;
  updateAttachment: (id: string, updates: Partial<AttachmentData>) => void;
  removeAttachment: (id: string) => void;
  setAttachments: (attachments: AttachmentData[]) => void;

  // Sockets
  sockets: SocketData[];
  addSocket: (parentModelId: string, name: string) => void;
  updateSocket: (id: string, updates: Partial<SocketData>) => void;
  removeSocket: (id: string) => void;
  setSockets: (sockets: SocketData[]) => void;
  triggerSocketFlash: (socketId: string) => void;
  flashTriggers: Record<string, number>;

  // Textures
  textures: TextureData[];
  addTexture: (file: File) => Promise<string | null>;
  saveTextureToLibrary: (base64: string, name: string) => Promise<string | null>;
  removeTexture: (id: string) => void;
  setTextures: (textures: TextureData[]) => void;

  // Audio
  audioAssets: AudioData[];
  addAudio: (file: File) => Promise<string | null>;
  removeAudio: (id: string) => void;
  setAudioAssets: (audios: AudioData[]) => void;

  // Blueprints
  blueprints: Blueprint[];
  addBlueprint: (type: any) => Promise<void>;
  updateBlueprint: (id: string, updates: Partial<Blueprint>) => void;
  removeBlueprint: (id: string) => void;
  setBlueprints: (blueprints: Blueprint[]) => void;

  // Graphs
  graphData: Record<string, AnimationGraphData>;
  updateGraph: (modelId: string, data: Partial<AnimationGraphData>) => void;
  hydrateGraphs: (graphs: Record<string, AnimationGraphData>) => void;
  resetGraphs: () => void;

  // Runtime Triggers
  characterFireTriggers: Record<string, number>;
  triggerCharacterFire: (modelId: string) => void;

  // Debug
  debugProjectile: DebugProjectile;
  triggerDebugProjectile: (origin: [number, number, number], direction: [number, number, number]) => void;
}

const AssetContext = createContext<AssetContextType | undefined>(undefined);

export const useAssets = () => {
  const context = useContext(AssetContext);
  if (!context) throw new Error('useAssets must be used within AssetProvider');
  return context;
};

interface AssetProviderProps {
  children: ReactNode;
  setIsLoading: (loading: boolean) => void;
}

export const AssetProvider: React.FC<AssetProviderProps> = ({ children, setIsLoading }) => {
  const { selectModel, selectedModelId } = useSelection();

  // --- Domain Managers ---
  const textureManager = useTextureManager(setIsLoading);
  const audioManager = useAudioManager(setIsLoading);
  const graphManager = useGraphManager();
  const blueprintManager = useBlueprintManager();
  
  // Model Manager (Handles cleanup of other domains on deletion)
  const modelManager = useModelManager(setIsLoading, (id) => {
    attachmentManager.removeAttachmentsByParentId(id);
    socketManager.removeSocketsByParentId(id, false);
    graphManager.removeGraphData(id, false);
    blueprintManager.unlinkModelFromBlueprints(id);
  });

  const attachmentManager = useAttachmentManager(modelManager.models, setIsLoading);
  const socketManager = useSocketManager();
  const debugTools = useDebugTools();

  // --- Flash & Animation Triggers ---
  const [flashTriggers, setFlashTriggers] = useState<Record<string, number>>({});
  const triggerSocketFlash = useCallback((socketId: string) => {
      setFlashTriggers(prev => ({ ...prev, [socketId]: Date.now() }));
  }, []);

  const [characterFireTriggers, setCharacterFireTriggers] = useState<Record<string, number>>({});
  const triggerCharacterFire = useCallback((modelId: string) => {
      setCharacterFireTriggers(prev => ({ ...prev, [modelId]: Date.now() }));
  }, []);

  const value: AssetContextType = {
    // Models
    models: modelManager.models,
    addModel: modelManager.addModel,
    removeModel: modelManager.removeModel,
    placeInScene: async (id) => {
        await modelManager.placeInScene(id);
        selectModel(id); // Sync selection
    },
    removeFromScene: async (id) => {
        await modelManager.removeFromScene(id);
        if (selectedModelId === id) selectModel(null); // Deselect
    },
    addAnimations: modelManager.addAnimations,
    retextureModel: modelManager.retextureModel,
    resetModelTexture: modelManager.resetModelTexture,
    setModels: modelManager.setModels,

    // Attachments
    attachments: attachmentManager.attachments,
    addAttachment: attachmentManager.addAttachment,
    addAttachmentFromLibrary: attachmentManager.addAttachmentFromLibrary,
    updateAttachment: attachmentManager.updateAttachment,
    removeAttachment: attachmentManager.removeAttachment,
    setAttachments: attachmentManager.setAttachments,

    // Sockets
    sockets: socketManager.sockets,
    addSocket: socketManager.addSocket,
    updateSocket: socketManager.updateSocket,
    removeSocket: socketManager.removeSocket,
    setSockets: socketManager.setSockets,
    triggerSocketFlash,
    flashTriggers,

    // Textures
    textures: textureManager.textures,
    addTexture: textureManager.addTexture,
    saveTextureToLibrary: textureManager.saveTextureToLibrary,
    removeTexture: textureManager.removeTexture,
    setTextures: textureManager.setTextures,

    // Audio
    audioAssets: audioManager.audioAssets,
    addAudio: audioManager.addAudio,
    removeAudio: audioManager.removeAudio,
    setAudioAssets: audioManager.setAudioAssets,

    // Blueprints
    blueprints: blueprintManager.blueprints,
    addBlueprint: blueprintManager.addBlueprint,
    updateBlueprint: blueprintManager.updateBlueprint,
    removeBlueprint: (id) => {
        blueprintManager.removeBlueprint(id);
    },
    setBlueprints: blueprintManager.setBlueprints,

    // Graphs
    graphData: graphManager.graphData,
    updateGraph: graphManager.updateGraph,
    hydrateGraphs: graphManager.hydrateGraphs,
    resetGraphs: graphManager.resetGraphs,

    // Runtime
    characterFireTriggers,
    triggerCharacterFire,

    // Debug
    debugProjectile: debugTools.debugProjectile,
    triggerDebugProjectile: debugTools.triggerDebugProjectile
  };

  return (
    <AssetContext.Provider value={value}>
      {children}
    </AssetContext.Provider>
  );
};
