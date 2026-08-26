
import JSZip from 'jszip';
import FileSaver from 'file-saver';
import { dbOperations, DBModel, DBAttachment, DBLevelObject, DBAudio, DBTexture } from './db';
import { CameraState } from '../types';

interface ProjectManifest {
  version: number;
  createdAt: string;
  appName: string;
  compatibility: {
      minVersion: number;
  };
}

interface SceneState {
  cameraState: CameraState;
  selectedModelId: string | null;
  selectedBlueprintId: string | null;
}

export type ProgressCallback = (message: string, percent: number) => void;

export class ProjectSerializer {
  
  /**
   * Packages the entire current state into a .forge file using memory-efficient streaming patterns.
   * Reports progress via callback.
   */
  async saveProject(
    cameraState: CameraState,
    selectedModelId: string | null,
    selectedBlueprintId: string | null,
    onProgress?: ProgressCallback
  ): Promise<void> {
    const zip = new JSZip();

    try {
        if(onProgress) onProgress("Preparing metadata...", 0);

        // 1. Create Manifest
        const manifest: ProjectManifest = {
            version: 7, // Version bump for Audio/Texture support
            createdAt: new Date().toISOString(),
            appName: "OmniRender Forge",
            compatibility: { minVersion: 1 }
        };
        zip.file("manifest.json", JSON.stringify(manifest, null, 2));

        // 2. Save Scene State
        const sceneState: SceneState = {
            cameraState,
            selectedModelId,
            selectedBlueprintId
        };
        zip.file("scene.json", JSON.stringify(sceneState, null, 2));

        // 3. Fetch Metadata (Lightweight)
        const [modelsMeta, attachmentsMeta, sockets, blueprints, levelObjects, levels, textures, audios] = await Promise.all([
            dbOperations.getAllModelMetadata(),
            dbOperations.getAllAttachmentMetadata(),
            dbOperations.getAllSockets(),
            dbOperations.getAllBlueprints(),
            dbOperations.getAllLevelObjects(),
            dbOperations.getAllLevels(),
            dbOperations.getAllTextures(),
            dbOperations.getAllAudio()
        ]);

        // 4. Save Metadata JSONs
        zip.file("blueprints.json", JSON.stringify(blueprints, null, 2));
        zip.file("sockets.json", JSON.stringify(sockets, null, 2));
        zip.file("levelObjects.json", JSON.stringify(levelObjects, null, 2));
        zip.file("levels.json", JSON.stringify(levels, null, 2));

        // 5. Setup Asset Streams
        const assetsFolder = zip.folder("assets");
        if (!assetsFolder) throw new Error("Failed to create assets folder in zip");

        // --- MODELS ---
        const finalModelMetadata: any[] = [];
        for (const m of modelsMeta) {
            const fullData = await dbOperations.getModelFiles(m.id);
            if (!fullData) continue;

            assetsFolder.file(`models/${m.id}.fbx`, fullData.file);

            const extraAnimsMeta = fullData.animationFiles.map((af, idx) => {
                assetsFolder.file(`models/${m.id}_anim_${idx}.fbx`, af.file);
                return { name: af.name, filename: `models/${m.id}_anim_${idx}.fbx` };
            });

            finalModelMetadata.push({
                ...m,
                assetFilename: `models/${m.id}.fbx`,
                extraAnimations: extraAnimsMeta
            });
        }
        zip.file("models.json", JSON.stringify(finalModelMetadata, null, 2));

        // --- ATTACHMENTS ---
        const finalAttachmentMetadata: any[] = [];
        for (const a of attachmentsMeta) {
            const blob = await dbOperations.getAttachmentFile(a.id);
            if (blob) {
                assetsFolder.file(`attachments/${a.id}.fbx`, blob);
                finalAttachmentMetadata.push({
                    ...a,
                    assetFilename: `attachments/${a.id}.fbx`
                });
            }
        }
        zip.file("attachments.json", JSON.stringify(finalAttachmentMetadata, null, 2));

        // --- TEXTURES ---
        const finalTextureMetadata: any[] = [];
        for (const t of textures) {
            // Save texture blob
            const ext = t.file.type === 'image/jpeg' ? 'jpg' : 'png';
            const filename = `textures/${t.id}.${ext}`;
            assetsFolder.file(filename, t.file);
            
            finalTextureMetadata.push({
                ...t,
                file: undefined, // Remove blob from JSON
                assetFilename: filename
            });
        }
        zip.file("textures.json", JSON.stringify(finalTextureMetadata, null, 2));

        // --- AUDIO ---
        const finalAudioMetadata: any[] = [];
        for (const a of audios) {
            // Infer extension from MIME type
            let ext = 'mp3';
            if (a.type.includes('wav')) ext = 'wav';
            else if (a.type.includes('ogg')) ext = 'ogg';
            else if (a.type.includes('mpeg')) ext = 'mp3';

            const filename = `audio/${a.id}.${ext}`;
            assetsFolder.file(filename, a.file);

            finalAudioMetadata.push({
                ...a,
                file: undefined, // Remove blob from JSON
                assetFilename: filename
            });
        }
        zip.file("audios.json", JSON.stringify(finalAudioMetadata, null, 2));

        // 7. Generate Zip
        if(onProgress) onProgress("Compressing assets...", 50);
        
        const content = await zip.generateAsync({ 
            type: "blob", 
            compression: "DEFLATE",
            compressionOptions: { level: 6 },
            streamFiles: true 
        }, (metadata) => {
            if (onProgress) {
                const percent = 50 + (metadata.percent * 0.5);
                onProgress(`Compressing: ${metadata.currentFile || 'data'}`, Math.round(percent));
            }
        });

        const dateStr = new Date().toISOString().slice(0, 10);
        const saveAs = (FileSaver as any).saveAs || FileSaver;
        saveAs(content, `Project_Forge_${dateStr}.forge`);
        
        if(onProgress) onProgress("Save Complete", 100);

    } catch (e) {
        console.error("Error in project serializer:", e);
        throw e;
    }
  }

  /**
   * Unpacks a .forge file safely with validation and progress tracking.
   */
  async loadProject(file: File, onProgress?: ProgressCallback): Promise<SceneState> {
    try {
        if(onProgress) onProgress("Reading file...", 0);
        
        const zip = await JSZip.loadAsync(file);

        // 1. Validate Structure
        if (!zip.file("manifest.json")) throw new Error("Invalid project: Missing manifest.json");
        if (!zip.file("scene.json")) throw new Error("Invalid project: Missing scene.json");

        // 2. Clear Database (Only after validation passes)
        if(onProgress) onProgress("Clearing previous session...", 5);
        await dbOperations.clearDatabase();

        // 3. Restore Metadata
        if(onProgress) onProgress("Restoring metadata...", 10);
        
        const blueprintsStr = await zip.file("blueprints.json")?.async("string");
        if (blueprintsStr) {
            const blueprints = JSON.parse(blueprintsStr);
            await Promise.all(blueprints.map((bp: any) => dbOperations.saveBlueprint(bp)));
        }

        const socketsStr = await zip.file("sockets.json")?.async("string");
        if (socketsStr) {
            const sockets = JSON.parse(socketsStr);
            await Promise.all(sockets.map((s: any) => dbOperations.addSocket(s)));
        }

        const levelsStr = await zip.file("levels.json")?.async("string");
        const levelObjsStr = await zip.file("levelObjects.json")?.async("string");
        
        if (levelsStr) {
            const levels = JSON.parse(levelsStr);
            await Promise.all(levels.map((l: any) => dbOperations.addLevel(l)));
        }

        if (levelObjsStr) {
            const levelObjs = JSON.parse(levelObjsStr);
            const hasLevels = levelsStr && JSON.parse(levelsStr).length > 0;
            const defaultLevelId = hasLevels ? JSON.parse(levelsStr)[0].id : 'default_level';
            
            if (!hasLevels) {
                await dbOperations.addLevel({ id: defaultLevelId, name: 'Main Level', createdAt: Date.now() });
            }

            await Promise.all(levelObjs.map((o: any) => {
                if (!o.levelId) o.levelId = defaultLevelId;
                return dbOperations.addLevelObject(o);
            }));
        }

        // 4. Restore Models
        const modelsMetaStr = await zip.file("models.json")?.async("string");
        if (modelsMetaStr) {
            const modelsMeta = JSON.parse(modelsMetaStr);
            const total = modelsMeta.length;
            
            for (let i = 0; i < total; i++) {
                const m = modelsMeta[i];
                if(onProgress) onProgress(`Restoring models (${i+1}/${total})...`, 15 + Math.round((i/total) * 20)); 

                const modelBlob = await zip.file(`assets/${m.assetFilename}`)?.async("blob");
                if (!modelBlob) continue;

                const animationFiles: Array<{ name: string, file: Blob }> = [];
                if (m.extraAnimations) {
                    for (const animRef of m.extraAnimations) {
                        const animBlob = await zip.file(`assets/${animRef.filename}`)?.async("blob");
                        if (animBlob) {
                            animationFiles.push({ name: animRef.name, file: animBlob });
                        }
                    }
                }

                const dbModel: DBModel = {
                    id: m.id,
                    name: m.name,
                    category: m.category,
                    thumbnail: m.thumbnail,
                    file: modelBlob,
                    animationFiles: animationFiles,
                    isPlacedInScene: m.isPlacedInScene ?? false
                };
                await dbOperations.addModel(dbModel);
            }
        }

        // 5. Restore Attachments
        const attachmentsMetaStr = await zip.file("attachments.json")?.async("string");
        if (attachmentsMetaStr) {
            const attachmentsMeta = JSON.parse(attachmentsMetaStr);
            const total = attachmentsMeta.length;

            for (let i = 0; i < total; i++) {
                const a = attachmentsMeta[i];
                if(onProgress) onProgress(`Restoring attachments (${i+1}/${total})...`, 35 + Math.round((i/total) * 10));

                const attBlob = await zip.file(`assets/${a.assetFilename}`)?.async("blob");
                if (!attBlob) continue;

                const dbAtt: DBAttachment = {
                    id: a.id,
                    name: a.name,
                    parentModelId: a.parentModelId,
                    boneName: a.boneName,
                    position: a.position,
                    rotation: a.rotation,
                    scale: a.scale,
                    file: attBlob
                };
                await dbOperations.addAttachment(dbAtt);
            }
        }

        // 6. Restore Textures
        const texturesMetaStr = await zip.file("textures.json")?.async("string");
        if (texturesMetaStr) {
            const texturesMeta = JSON.parse(texturesMetaStr);
            const total = texturesMeta.length;

            for (let i = 0; i < total; i++) {
                const t = texturesMeta[i];
                if(onProgress) onProgress(`Restoring textures (${i+1}/${total})...`, 45 + Math.round((i/total) * 10));

                const texBlob = await zip.file(`assets/${t.assetFilename}`)?.async("blob");
                if (!texBlob) continue;

                const dbTex: DBTexture = {
                    id: t.id,
                    name: t.name,
                    dimensions: t.dimensions,
                    file: texBlob
                };
                await dbOperations.addTexture(dbTex);
            }
        }

        // 7. Restore Audio
        const audiosMetaStr = await zip.file("audios.json")?.async("string");
        if (audiosMetaStr) {
            const audiosMeta = JSON.parse(audiosMetaStr);
            const total = audiosMeta.length;

            for (let i = 0; i < total; i++) {
                const a = audiosMeta[i];
                if(onProgress) onProgress(`Restoring audio (${i+1}/${total})...`, 55 + Math.round((i/total) * 10));

                const audioBlob = await zip.file(`assets/${a.assetFilename}`)?.async("blob");
                if (!audioBlob) continue;

                const dbAudio: DBAudio = {
                    id: a.id,
                    name: a.name,
                    type: a.type,
                    duration: a.duration,
                    file: audioBlob
                };
                await dbOperations.addAudio(dbAudio);
            }
        }

        // 8. Return Scene State
        if(onProgress) onProgress("Finalizing...", 100);
        const sceneStr = await zip.file("scene.json")?.async("string");
        if (!sceneStr) throw new Error("Missing scene definition");
        
        return JSON.parse(sceneStr) as SceneState;

    } catch (e) {
        console.error("Error unpacking project:", e);
        throw e;
    }
  }
}

export const projectSerializer = new ProjectSerializer();
