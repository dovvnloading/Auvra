
import { useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { LoadedModelData, AttachmentData, Blueprint, SocketData, TextureData, LevelObject, LevelData, AudioData } from '../types';
import { dbOperations } from '../utils/db';
import { loadFBXFile } from '../utils/modelLoader';
import { stripGeometry } from '../utils/processing/ModelTransforms';
import { generateThumbnail } from '../utils/thumbnailGenerator';
import { disposeModel } from '../utils/processing/ModelLifecycle';

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
  defaultBlueprints
}: ScenePersistenceProps) => {

  const restoreSession = useCallback(async () => {
      setIsLoading(true);
      try {
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
                console.log("Persistence: Seeding default blueprints.");
                await Promise.all(defaultBlueprints.map(bp => dbOperations.saveBlueprint(bp)));
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
             await dbOperations.addLevel(defaultLevel);
             
             // Migrate orphans
             const allObjects = await dbOperations.getAllLevelObjects();
             let migratedCount = 0;
             for (const obj of allObjects) {
                 if (!obj.levelId) {
                     obj.levelId = defaultLevel.id;
                     await dbOperations.updateLevelObject(obj.id, { levelId: defaultLevel.id });
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
  }, [setModels, setAttachments, setSockets, setBlueprints, setTextures, setAudioAssets, setLevelObjects, setSelectedModelId, setIsLoading, defaultBlueprints]);
  
  useEffect(() => {
    restoreSession();
  }, []);

  return { restoreSession };
};
