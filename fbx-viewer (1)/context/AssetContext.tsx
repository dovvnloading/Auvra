
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
import { frontendDiagnostics } from '../diagnostics/runtime';
import { projectService } from '../utils/projectService';
import { emitDomainCascade, type DomainCascadeKind } from '../utils/domainCascade';

interface AssetContextType {
  // Models
  models: LoadedModelData[];
  addModel: (file: File, category: AssetCategory) => Promise<void>;
  removeModel: (id: string) => void;
  placeInScene: (id: string) => void; 
  removeFromScene: (id: string) => void; 
  addAnimations: (files: File[], modelId: string) => Promise<void>;
  retextureModel: (modelId: string, textureUrl: string, targetTextureUuid?: string) => Promise<void>;
  previewTexture: (modelId: string, textureUrl: string, targetTextureUuid?: string) => Promise<void>;
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
  const { selectModel, selectedModelId, selectBlueprint, selectedBlueprintId, clearModel, clearBlueprint } = useSelection();

  const emitCascade = useCallback((kind: DomainCascadeKind, id: string) => {
    const projectId = projectService.getStatus().projectId;
    if (projectId) emitDomainCascade({ kind, id, projectId });
  }, []);

  // --- Domain Managers ---
  const textureManager = useTextureManager(setIsLoading);
  const audioManager = useAudioManager(setIsLoading);
  const graphManager = useGraphManager();
  const blueprintManager = useBlueprintManager(selectedBlueprintId, selectBlueprint, clearBlueprint);
  
  // Model Manager (Handles cleanup of other domains on deletion)
  const modelManager = useModelManager(setIsLoading, (id) => {
    attachmentManager.removeAttachmentsByParentId(id);
    socketManager.removeSocketsByParentId(id, false);
    graphManager.removeGraphData(id, false);
    blueprintManager.unlinkModelFromBlueprints(id);
    emitCascade('model', id);
  }, selectedModelId, selectModel, clearModel);

  const attachmentManager = useAttachmentManager(modelManager.models, setIsLoading);
  const socketManager = useSocketManager();
  const debugTools = useDebugTools();

  const removeTexture = useCallback(async (id: string) => {
    if (!await textureManager.removeTexture(id)) return;
    modelManager.removeTextureReference(id);
    blueprintManager.removeTextureReference(id);
    socketManager.removeTextureReference(id);
    emitCascade('texture', id);
  }, [blueprintManager, emitCascade, modelManager, socketManager, textureManager]);

  const removeAudio = useCallback(async (id: string) => {
    if (!await audioManager.removeAudio(id)) return;
    blueprintManager.removeAudioReference(id);
    emitCascade('audio', id);
  }, [audioManager, blueprintManager, emitCascade]);

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
    placeInScene: modelManager.placeInScene,
    removeFromScene: modelManager.removeFromScene,
    addAnimations: modelManager.addAnimations,
    retextureModel: modelManager.retextureModel,
    previewTexture: modelManager.previewTexture,
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
    triggerSocketFlash: frontendDiagnostics.wrap('asset_context', 'trigger_socket_flash', triggerSocketFlash),
    flashTriggers,

    // Textures
    textures: textureManager.textures,
    addTexture: textureManager.addTexture,
    saveTextureToLibrary: textureManager.saveTextureToLibrary,
    removeTexture,
    setTextures: textureManager.setTextures,

    // Audio
    audioAssets: audioManager.audioAssets,
    addAudio: audioManager.addAudio,
    removeAudio,
    setAudioAssets: audioManager.setAudioAssets,

    // Blueprints
    blueprints: blueprintManager.blueprints,
    addBlueprint: blueprintManager.addBlueprint,
    updateBlueprint: blueprintManager.updateBlueprint,
    removeBlueprint: blueprintManager.removeBlueprint,
    setBlueprints: blueprintManager.setBlueprints,

    // Graphs
    graphData: graphManager.graphData,
    updateGraph: graphManager.updateGraph,
    hydrateGraphs: graphManager.hydrateGraphs,
    resetGraphs: graphManager.resetGraphs,

    // Runtime
    characterFireTriggers,
    triggerCharacterFire: frontendDiagnostics.wrap('asset_context', 'trigger_character_fire', triggerCharacterFire),

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
