
import { useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { LoadedModelData, AttachmentData, Blueprint, SocketData, TextureData, LevelObject, LevelData, AudioData } from '../types';
import { dbOperations } from '../utils/db';
import { loadFBXFile } from '../utils/modelLoader';
import { stripGeometry } from '../utils/processing/ModelTransforms';
import { generateThumbnail } from '../utils/thumbnailGenerator';
import { disposeModel } from '../utils/processing/ModelLifecycle';
import { projectService, ProjectSnapshot } from '../utils/projectService';

interface ScenePersistenceProps {
  setModels: (models: LoadedModelData[]) => void;
  setAttachments: (attachments: AttachmentData[]) => void;
  setSockets: (sockets: SocketData[]) => void;
  setBlueprints?: (blueprints: Blueprint[]) => void;
  setTextures?: (textures: TextureData[]) => void;
  setAudioAssets?: (audios: AudioData[]) => void; // Added
  setLevelObjects?: (objects: LevelObject[]) => void;
  setSelectedModelId: (id: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  defaultBlueprints?: Blueprint[];
  hydrateProjectState?: (levels: LevelData[], objects: LevelObject[], currentLevelId?: string | null) => void;
  hydrateGraphs?: (graphs: Record<string, import('../types').AnimationGraphData>) => void;
}

interface SnapshotHydrationTargets {
  setModels: (value: LoadedModelData[]) => void;
  setAttachments: (value: AttachmentData[]) => void;
  setSockets: (value: SocketData[]) => void;
  setBlueprints?: (value: Blueprint[]) => void;
  setTextures?: (value: TextureData[]) => void;
  setAudioAssets?: (value: AudioData[]) => void;
  setLevelObjects?: (value: LevelObject[]) => void;
  setSelectedModelId: (value: string | null) => void;
  hydrateProjectState?: (levels: LevelData[], objects: LevelObject[], currentLevelId?: string | null) => void;
  hydrateGraphs?: (graphs: Record<string, import('../types').AnimationGraphData>) => void;
}

/** Hydrate authored domains from a bounded native snapshot. Binary assets are
 * resolved only through opaque host tickets and never embedded in JSON. */
async function hydrateSnapshot(snapshot: ProjectSnapshot, targets: SnapshotHydrationTargets): Promise<boolean> {
  const source = snapshot.domains && typeof snapshot.domains === 'object'
    ? snapshot.domains
    : snapshot as Record<string, unknown>;
  const domainDocuments = (key: string): unknown[] => {
    const value = source[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && Array.isArray((value as { documents?: unknown[] }).documents)) {
      return (value as { documents: unknown[] }).documents;
    }
    return [];
  };
  const hasDomain = ['metadata', 'worlds', 'scenes', 'levels', 'objects', 'environment', 'models', 'animations', 'attachments', 'sockets', 'textures', 'audio', 'materials', 'blueprints', 'graphs', 'hud']
    .some((key) => domainDocuments(key).length > 0);
  const isNativePage = Array.isArray((snapshot as Record<string, unknown>).documents);
  const pageDocuments = Array.isArray((snapshot as Record<string, unknown>).documents)
    ? (snapshot as Record<string, unknown>).documents as unknown[] : [];
  if (!hasDomain && !isNativePage) return false;
  if (isNativePage) {
    targets.setModels([]);
    targets.setAttachments([]);
    targets.setSockets([]);
    targets.setBlueprints?.([]);
    targets.setTextures?.([]);
    targets.setAudioAssets?.([]);
    targets.setLevelObjects?.([]);
  }
  if (isNativePage && !hasDomain && pageDocuments.length === 0) {
    targets.setBlueprints?.([]);
    targets.setTextures?.([]);
    targets.setAudioAssets?.([]);
    targets.setLevelObjects?.([]);
    targets.hydrateProjectState?.([], [], null);
    targets.hydrateGraphs?.({});
    targets.setSelectedModelId(null);
    return true;
  }
  const records = Array.isArray((snapshot as Record<string, unknown>).documents)
    ? ((snapshot as Record<string, unknown>).documents as unknown[]).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : [];
  const docsByDomain: Record<string, unknown[]> = {};
  for (const item of records) {
    const domain = typeof item.domain === 'string' ? item.domain : '';
    const document = item.document && typeof item.document === 'object' ? item.document : item;
    if (domain) (docsByDomain[domain] ||= []).push(document);
  }
  const documents = (key: string): unknown[] => domainDocuments(key).length ? domainDocuments(key) : docsByDomain[key] || [];
  const textureAssetUrls = new Map<string, string>();
  if (targets.setBlueprints) targets.setBlueprints(documents('blueprints') as Blueprint[]);
  if (targets.setTextures) {
    const textures: TextureData[] = [];
    for (const value of documents('textures')) {
      const item = value as Partial<TextureData> & { assetId?: string };
      if (!item.id || !item.name || !item.assetId) continue;
      try {
        const url = await loadProjectAssetUrl(item.assetId);
        textureAssetUrls.set(item.id, url);
        textures.push({ id: item.id, name: item.name, dimensions: item.dimensions || { width: 0, height: 0 }, url });
      }
      catch (error) { console.warn(`[Persistence] Could not hydrate texture ${item.id}`, error); }
    }
    targets.setTextures(textures);
  }
  if (targets.setAudioAssets) {
    const audios: AudioData[] = [];
    for (const value of documents('audio')) {
      const item = value as Partial<AudioData> & { assetId?: string };
      if (!item.id || !item.name || !item.assetId) continue;
      try { audios.push({ id: item.id, name: item.name, type: item.type || 'application/octet-stream', duration: item.duration || 0, url: await loadProjectAssetUrl(item.assetId) }); }
      catch (error) { console.warn(`[Persistence] Could not hydrate audio ${item.id}`, error); }
    }
    targets.setAudioAssets(audios);
  }
  if (targets.setModels) {
    const models: LoadedModelData[] = [];
    const animationDocuments = documents('animations') as Array<{ assetId?: string; modelId?: string; name?: string }>;
    for (const value of documents('models')) {
      const item = value as Record<string, any>;
      if (!item.id || !item.name || !item.assetId) continue;
      try {
        const loaded = await loadFBXFile(await loadProjectAssetFile(item.assetId, item.name), { normalize: item.category !== 'Animation', manualId: item.id });
        loaded.category = item.category || 'Prop';
        loaded.isPlacedInScene = Boolean(item.isPlacedInScene);
        loaded.textureOverrides = item.textureOverrides;
        for (const [materialName, textureId] of Object.entries(item.textureOverrides || {}) as Array<[string, string]>) {
          const textureUrl = textureAssetUrls.get(textureId);
          if (!textureUrl) continue;
          const texture = await new THREE.TextureLoader().loadAsync(textureUrl);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.flipY = true;
          loaded.object.traverse((child) => {
            if (!(child as THREE.Mesh).isMesh) return;
            const material = (child as THREE.Mesh).material;
            const materials = Array.isArray(material) ? material : [material];
            for (const candidate of materials as any[]) {
              if (candidate.name !== materialName) continue;
              if (candidate.map) candidate.map.dispose();
              candidate.map = texture;
              candidate.transparent = true;
              candidate.alphaTest = 0.5;
              candidate.side = THREE.DoubleSide;
              candidate.needsUpdate = true;
            }
          });
        }
        if (loaded.category === 'Animation') stripGeometry(loaded.object);
        if (!item.thumbnail && loaded.category !== 'Animation') loaded.thumbnail = generateThumbnail(loaded.object);
        const animations = animationDocuments.filter((animation) => animation.modelId === item.id);
        for (const animation of animations) {
          if (!animation?.assetId) continue;
          try {
            const animationModel = await loadFBXFile(await loadProjectAssetFile(animation.assetId, animation.name || 'animation.fbx'), { normalize: false });
            loaded.animations.push(...animationModel.animations.map((clip) => { const copy = clip.clone(); copy.name = String(animation.name || copy.name); return copy; }));
            disposeModel(animationModel);
          } catch (error) { console.warn(`[Persistence] Could not hydrate animation ${animation.assetId}`, error); }
        }
        models.push(loaded);
      } catch (error) { console.warn(`[Persistence] Could not hydrate model ${item.id}`, error); }
    }
    targets.setModels(models);
  }
  if (targets.setAttachments) {
    const attachments: AttachmentData[] = [];
    for (const value of documents('attachments')) {
      const item = value as Record<string, any>;
      if (!item.id || !item.name || !item.assetId) continue;
      try {
        const loaded = await loadFBXFile(await loadProjectAssetFile(item.assetId, item.name), { normalize: false, manualId: item.id });
        attachments.push({ id: item.id, name: item.name, url: loaded.url, object: loaded.object, parentModelId: item.parentModelId || '', boneName: item.boneName || 'Hips', position: item.position || [0, 0, 0], rotation: item.rotation || [0, 0, 0], scale: item.scale || [1, 1, 1] });
      } catch (error) { console.warn(`[Persistence] Could not hydrate attachment ${item.id}`, error); }
    }
    targets.setAttachments(attachments);
  }
  if (targets.setSockets) targets.setSockets(documents('sockets') as SocketData[]);
  const levels = documents('levels') as LevelData[];
  const objects = documents('objects') as LevelObject[];
  if (targets.setLevelObjects) targets.setLevelObjects(objects);
  targets.hydrateProjectState?.(levels, objects, levels[0]?.id || null);
  const graphDocs = documents('graphs');
  if (targets.hydrateGraphs) {
    const graphs: Record<string, import('../types').AnimationGraphData> = {};
    graphDocs.forEach((doc) => { const value = doc as { modelId?: string; id?: string; graph?: import('../types').AnimationGraphData }; const key = value.modelId || value.id; if (key) graphs[key] = value.graph || value as unknown as import('../types').AnimationGraphData; });
    targets.hydrateGraphs(graphs);
  }
  targets.setSelectedModelId(null);
  return true;
}

async function loadProjectAssetFile(assetId: string, name: string): Promise<File> {
  const url = await projectService.resolveAsset(assetId);
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) throw new Error(`Asset download failed (${response.status})`);
  return new File([await response.blob()], name, { type: response.headers.get('Content-Type') || 'application/octet-stream' });
}

async function loadProjectAssetUrl(assetId: string): Promise<string> {
  const file = await loadProjectAssetFile(assetId, assetId);
  return URL.createObjectURL(file);
}

export const useScenePersistence = ({
  setModels,
  setAttachments,
  setSockets,
  setBlueprints,
  setTextures,
  setAudioAssets,
  setLevelObjects,
  setSelectedModelId,
  setIsLoading,
  defaultBlueprints,
  hydrateProjectState,
  hydrateGraphs,
}: ScenePersistenceProps) => {

  const restoreSession = useCallback(async () => {
      setIsLoading(true);
      try {
        // Project data is host-owned. A snapshot is intentionally attempted
        // before the legacy browser store; the latter is read-only and exists
        // only to keep older workspaces recoverable during migration.
        try {
          const nativeProject = projectService.getStatus().projectId;
          const snapshot = nativeProject ? await projectService.getSnapshotAll() : null;
          if (nativeProject && snapshot) {
            const hydrated = await hydrateSnapshot(snapshot, {
              setModels, setAttachments, setSockets,
              setBlueprints, setTextures, setAudioAssets, setLevelObjects,
              setSelectedModelId,
              hydrateProjectState, hydrateGraphs,
            });
            if (!hydrated) throw new Error('Native project snapshot did not contain a valid domain payload');
            return;
          }
        } catch (error) {
          if (projectService.getStatus().projectId) throw error;
          console.warn('[Persistence] Native project snapshot unavailable; reading legacy migration data.', error);
        }
        const [dbModels, dbAttachments, dbSockets, dbBlueprints, dbTextures, dbAudios] = await Promise.all([
          dbOperations.getAllModels(),
          dbOperations.getAllAttachments(),
          dbOperations.getAllSockets(),
          dbOperations.getAllBlueprints(),
          dbOperations.getAllTextures(),
          dbOperations.getAllAudio()
        ]);

        // 1. Restore Blueprints
        if (setBlueprints) {
            let finalBlueprints = dbBlueprints;
            if (dbBlueprints.length === 0 && defaultBlueprints && defaultBlueprints.length > 0) {
                finalBlueprints = defaultBlueprints;
            } 
            setBlueprints(finalBlueprints);
        }

        // 2. Restore Textures
        if (setTextures && dbTextures) {
            const loadedTextures: TextureData[] = [];
            for (const dbT of dbTextures) {
                const url = URL.createObjectURL(dbT.file);
                loadedTextures.push({
                    id: dbT.id,
                    name: dbT.name,
                    url,
                    dimensions: dbT.dimensions
                });
            }
            setTextures(loadedTextures);
        }

        // 3. Restore Audio
        if (setAudioAssets && dbAudios) {
            const loadedAudio: AudioData[] = [];
            for (const dbA of dbAudios) {
                const url = URL.createObjectURL(dbA.file);
                loadedAudio.push({
                    id: dbA.id,
                    name: dbA.name,
                    url,
                    type: dbA.type,
                    duration: dbA.duration
                });
            }
            setAudioAssets(loadedAudio);
        }

        // 4. Restore Models
        const loadedModels: LoadedModelData[] = [];
        for (const dbM of dbModels) {
          try {
            const file = new File([dbM.file], dbM.name, { type: 'application/octet-stream' });
            const loaded = await loadFBXFile(file, { normalize: dbM.category !== 'Animation', manualId: dbM.id });
            loaded.category = dbM.category || 'Prop';
            if (loaded.category === 'Animation') stripGeometry(loaded.object);
            loaded.thumbnail = dbM.thumbnail;
            loaded.isPlacedInScene = dbM.isPlacedInScene;
            loaded.textureOverrides = dbM.textureOverrides;
            
            if (loaded.textureOverrides && Object.keys(loaded.textureOverrides).length > 0 && loaded.object) {
                const loader = new THREE.TextureLoader();
                for (const [matName, base64] of Object.entries(loaded.textureOverrides)) {
                    loader.load(base64, (tex) => {
                        tex.colorSpace = THREE.SRGBColorSpace;
                        tex.flipY = true;
                        loaded.object.traverse((child) => {
                            if ((child as THREE.Mesh).isMesh) {
                                const mesh = child as THREE.Mesh;
                                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                                materials.forEach((m: any) => {
                                    if (m.name === matName) {
                                        if (m.map) m.map.dispose();
                                        m.map = tex;
                                        m.transparent = true;
                                        m.alphaTest = 0.5;
                                        m.side = THREE.DoubleSide;
                                        m.needsUpdate = true;
                                    }
                                });
                            }
                        });
                    });
                }
            }

            if (!loaded.thumbnail && loaded.object && loaded.category !== 'Animation') {
                loaded.thumbnail = generateThumbnail(loaded.object);
            }

            if (dbM.animationFiles && dbM.animationFiles.length > 0) {
              const animClips = [];
              for (const animFile of dbM.animationFiles) {
                 const aFile = new File([animFile.file], animFile.name, { type: 'application/octet-stream' });
                 const tempLoaded = await loadFBXFile(aFile, { normalize: false });
                 const newClips = tempLoaded.animations.map(clip => {
                    const cleanName = animFile.name.replace('.fbx', '').replace('.FBX', '');
                    const newClip = clip.clone();
                    newClip.name = cleanName;
                    return newClip;
                 });
                 animClips.push(...newClips);
                 disposeModel(tempLoaded);
              }
              loaded.animations = [...loaded.animations, ...animClips];
            }
            loadedModels.push(loaded);
            await new Promise(r => setTimeout(r, 50));
          } catch (e) {
            console.error(`Failed to restore model ${dbM.name}`, e);
          }
        }
        setModels(loadedModels);

        // 5. Restore Attachments
        const loadedAttachments: AttachmentData[] = [];
        for (const dbA of dbAttachments) {
            try {
                const file = new File([dbA.file], dbA.name, { type: 'application/octet-stream' });
                const loaded = await loadFBXFile(file, { normalize: false, manualId: dbA.id });
                loadedAttachments.push({
                    id: dbA.id,
                    name: dbA.name,
                    url: loaded.url,
                    object: loaded.object,
                    parentModelId: dbA.parentModelId,
                    boneName: dbA.boneName,
                    position: dbA.position,
                    rotation: dbA.rotation,
                    scale: dbA.scale
                });
            } catch (e) {
                console.error(`Failed to restore attachment ${dbA.name}`, e);
            }
        }
        setAttachments(loadedAttachments);

        // 6. Restore Sockets
        setSockets(dbSockets);

        // 7. Level Objects (Legacy Migration Handling)
        const levels = await dbOperations.getAllLevels();
        if (levels.length === 0) {
             const defaultLevel = { id: 'default_level', name: 'Main Level', createdAt: Date.now() };
             // Do not write defaults to the legacy database. The native host
             // creates the initial level in the canonical project repository.
             
             // Migrate orphans
             const allObjects = await dbOperations.getAllLevelObjects();
             let migratedCount = 0;
             for (const obj of allObjects) {
                 if (!obj.levelId) {
                     obj.levelId = defaultLevel.id;
                     // Legacy objects remain untouched; normalization is part
                     // of host-side migration, not browser persistence.
                     migratedCount++;
                 }
             }
             if (migratedCount > 0) console.log(`Migrated ${migratedCount} objects to default level.`);
        }

        // Selection
        const placedModels = loadedModels.filter(m => m.isPlacedInScene);
        if (placedModels.length > 0 && !dbBlueprints.length) {
            setSelectedModelId(placedModels[0].id);
        }

      } catch (err) {
        console.error("Database restore failed", err);
      } finally {
        setIsLoading(false);
      }
  }, [setModels, setAttachments, setSockets, setBlueprints, setTextures, setAudioAssets, setLevelObjects, setSelectedModelId, setIsLoading, defaultBlueprints, hydrateProjectState, hydrateGraphs]);
  
  useEffect(() => {
    restoreSession();
  }, []);

  return { restoreSession };
};
