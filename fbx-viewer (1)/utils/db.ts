
import { AssetCategory, AssetInfoUpdate, Blueprint, SocketData, LevelObject, LevelData, TerrainData, PrefabData } from '../types';
import { AssetTransferOptions, projectService } from './projectService';
import { externalizeTerrainData } from './terrainHeightfieldEditor';
import { externalizeTerrainSplat } from '../components/Environment/Terrain/terrainSplatEditor';
import { terrainLayersReferenceTexture, withoutTerrainLayerTexture } from '../components/Environment/Terrain/terrainSplatCodec';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { editorSession, type EditorSessionLease } from './editorSession';
import { sortByHierarchy } from './sceneGraph';
import { normalizeMaterialOverrides, setMaterialOverrideField, type MaterialOverrides } from './materialOverrides';

const DB_NAME = 'OmniRenderDB';

const assertTransferActive = (transfer: AssetTransferOptions): void => {
  if (transfer.signal?.aborted) throw new DOMException('Asset import was cancelled.', 'AbortError');
};

export interface DBModel {
  id: string;
  name: string;
  file: Blob;
  animationFiles: Array<{ name: string, file: Blob }>;
  category: AssetCategory;
  thumbnail?: string;
  isPlacedInScene: boolean;
  textureOverrides?: Record<string, string>; // MaterialName -> logical texture id
  /** The names given to the clips in the model's own file. */
  clipNames?: string[];
}

export interface DBAttachment {
  id: string;
  name: string;
  file: Blob;
  parentModelId: string;
  boneName: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface DBTexture {
  id: string;
  name: string;
  file: Blob;
  dimensions: { width: number; height: number };
}

export interface DBAudio {
    id: string;
    name: string;
    file: Blob;
    type: string;
    duration: number;
}

export interface DBLevelObject extends LevelObject {}

export interface DBSocket extends SocketData {}

export type DBModelMetadata = Omit<DBModel, 'file' | 'animationFiles'>;
export type DBAttachmentMetadata = Omit<DBAttachment, 'file'>;

class DBOperations {
  /** Legacy browser storage, or null where there never was any (the usual case). */
  private dbPromise: Promise<IDBDatabase | null>;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.dbPromise = new Promise((resolve, reject) => {
      // Legacy storage is a read-only migration source. Opening without a
      // version prevents upgrades; a new database is aborted immediately,
      // which fails the request: that means "nothing to migrate", not an error.
      const request = indexedDB.open(DB_NAME);
      let missing = false;

      request.onerror = (event) => {
        if (missing) {
          event.preventDefault();
          resolve(null);
          return;
        }
        frontendDiagnostics.failure('legacy_database_request_failed', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onupgradeneeded = () => {
        missing = true;
        request.transaction?.abort();
      };
    });
  }

  private async getDB(): Promise<IDBDatabase | null> {
    return this.dbPromise;
  }

  /** Read one bounded legacy page through a readonly cursor. */
  private async readOnlyStorePage<T>(storeName: string, offset: number, pageSize = 64): Promise<{ values: T[]; nextOffset: number | null }> {
    const db = await this.getDB();
    if (!db) return { values: [], nextOffset: null };
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const cursorRequest = transaction.objectStore(storeName).openCursor();
      const values: T[] = [];
      let index = 0;
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) { resolve({ values, nextOffset: null }); return; }
        if (index++ < offset) { cursor.continue(); return; }
        if (values.length >= pageSize) { resolve({ values, nextOffset: offset + values.length }); return; }
        values.push(cursor.value as T);
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });
  }

  /** Read all legacy records as bounded pages. The compatibility result is
   * assembled only for callers that explicitly request the legacy fallback. */
  private async readOnlyStoreAll<T>(storeName: string): Promise<T[]> {
    const values: T[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.readOnlyStorePage<T>(storeName, offset);
      values.push(...page.values);
      if (page.nextOffset === null) return values;
      offset = page.nextOffset;
    }
  }

  private async *readOnlyStorePages<T>(storeName: string): AsyncGenerator<T[]> {
    const db = await this.getDB();
    if (!db || !db.objectStoreNames.contains(storeName)) return;
    let offset = 0;
    for (;;) {
      const page = await this.readOnlyStorePage<T>(storeName, offset);
      if (page.values.length) yield page.values;
      if (page.nextOffset === null) return;
      offset = page.nextOffset;
    }
  }

  private requireEditorLease(lease?: EditorSessionLease): void {
    if (!lease) return;
    editorSession.requireWritable(lease, projectService.getStatus());
  }

  /** Route authored JSON mutations to the native repository once a project is
   * open. IndexedDB remains a read-only migration source; binary uploads are
   * handled by the host asset transport and are therefore not sent here. */
  private async canonicalChange(domain: string, operation: 'upsert' | 'remove', value: unknown, id?: string, lease?: EditorSessionLease, prepare?: DocumentPreparation): Promise<boolean> {
    return this.enqueueMutation(() => this.performCanonicalChange(domain, operation, value, id, lease, prepare));
  }

  /** Run `run` after every earlier queued mutation has settled. */
  private enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(run, run);
    this.mutationQueue = result.catch(() => undefined);
    return result;
  }

  private async performCanonicalChange(domain: string, operation: 'upsert' | 'remove', value: unknown, id?: string, lease?: EditorSessionLease, prepare?: DocumentPreparation): Promise<boolean> {
    this.requireEditorLease(lease);
    if (!projectService.getStatus().projectId) throw new Error('Open a native project before editing');
    if (projectService.getStatus().readOnly) throw new Error('Project is read-only');
    const upsertsDocument = operation === 'upsert' && Boolean(value && typeof value === 'object' && id);
    const readStored = async (): Promise<Record<string, unknown> | undefined> => {
      const snapshot = await projectService.getSnapshotAll(domain);
      const rawDomain = snapshot?.domains?.[domain];
      const records = Array.isArray(rawDomain)
        ? rawDomain
        : rawDomain && typeof rawDomain === 'object' && Array.isArray((rawDomain as { documents?: unknown[] }).documents)
          ? (rawDomain as { documents: unknown[] }).documents : snapshot?.documents || [];
      const current = records.find((record) => record && typeof record === 'object' && (record as { id?: unknown }).id === id);
      this.requireEditorLease(lease);
      return current && typeof current === 'object' ? current as Record<string, unknown> : undefined;
    };
    let afterCommit: (() => void) | undefined;
    if (prepare) {
      // Runs inside the mutation queue so binary side data (terrain
      // heightfields) is uploaded in the same order as the documents.
      const prepared = await prepare(value, upsertsDocument ? readStored : undefined);
      value = prepared.value;
      afterCommit = prepared.afterCommit;
      this.requireEditorLease(lease);
    }
    let completeValue = value;
    if (upsertsDocument && value && typeof value === 'object') {
      const current = await readStored();
      if (current) completeValue = { ...current, ...(value as Record<string, unknown>) };
    }
    this.requireEditorLease(lease);
    await projectService.applyChanges([{ domain, operation, id, value: completeValue }]);
    afterCommit?.();
    return true;
  }

  private requireNativeProject(): void {
    if (!projectService.getStatus().projectId) throw new Error('Open a native project before editing');
    if (projectService.getStatus().readOnly) throw new Error('Project is read-only');
  }

  // --- LEVELS ---

  async addLevel(level: LevelData, lease?: EditorSessionLease): Promise<void> {
      await this.canonicalChange('levels', 'upsert', level, level.id, lease);
  }

  async getAllLevels(): Promise<LevelData[]> {
      return this.readOnlyStoreAll<LevelData>('levels');
  }

  async deleteLevel(id: string, lease?: EditorSessionLease): Promise<void> {
      this.requireEditorLease(lease);
      this.requireNativeProject();
      const snapshot = await projectService.getSnapshotAll();
      this.requireEditorLease(lease);
      const changes: Array<{ domain: string; operation: 'remove' | 'upsert'; id: string; value?: unknown }> = [
        { domain: 'levels', operation: 'remove', id },
      ];
      for (const record of nativeDomainRecords(snapshot, 'objects')) {
        if (record.levelId === id) changes.push({ domain: 'objects', operation: 'remove', id: record.id });
      }
      for (const record of nativeDomainRecords(snapshot, 'scenes')) {
        if (record.levelId === id) changes.push({ domain: 'scenes', operation: 'remove', id: record.id });
      }
      for (const record of nativeDomainRecords(snapshot, 'worlds')) {
        const levels = Array.isArray(record.levels) ? record.levels.filter((levelId: unknown) => levelId !== id) : [];
        if (levels.length !== (record.levels || []).length) {
          changes.push({ domain: 'worlds', operation: 'upsert', id: record.id, value: { ...record, levels } });
        }
      }
      this.requireEditorLease(lease);
      await projectService.applyChanges(changes);
  }

  // --- MODELS ---

  async addModel(model: DBModel, transfer: AssetTransferOptions = {}): Promise<void> {
    this.requireNativeProject();
    const modelAssetId = await projectService.uploadAsset(new File([model.file], model.name), transfer);
    assertTransferActive(transfer);
    const animationAssets: Array<{ id: string; name: string; assetId: string; modelId: string }> = [];
    for (const animation of (model.animationFiles || [])) {
      const assetId = await projectService.uploadAsset(new File([animation.file], animation.name), transfer);
      assertTransferActive(transfer);
      animationAssets.push({ id: assetId, name: animation.name, assetId, modelId: model.id });
    }
    assertTransferActive(transfer);
    transfer.onPhase?.('project_record_commit');
    await projectService.applyChanges([{ domain: 'models', operation: 'upsert', id: model.id, value: {
      id: model.id, name: model.name, assetId: modelAssetId,
      category: model.category, isPlacedInScene: model.isPlacedInScene,
      ...(model.clipNames?.length ? { clipNames: model.clipNames } : {}),
    } }, ...animationAssets.map((animation) => ({
      domain: 'animations', operation: 'upsert' as const, id: animation.id, value: animation,
    }))], transfer.diagnostics);
  }

  async getAllModels(): Promise<DBModel[]> {
    return this.readOnlyStoreAll<DBModel>('models');
  }

  async getAllModelMetadata(): Promise<DBModelMetadata[]> {
    const db = await this.getDB();
    if (!db) return [];
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['models'], 'readonly');
      const store = transaction.objectStore('models');
      const request = store.openCursor();
      const results: DBModelMetadata[] = [];

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result as IDBCursorWithValue;
        if (cursor) {
          const { file, animationFiles, ...metadata } = cursor.value as DBModel;
          results.push(metadata);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getModelFiles(id: string): Promise<{ file: Blob, animationFiles: Array<{ name: string, file: Blob }> } | null> {
    const db = await this.getDB();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['models'], 'readonly');
      const store = transaction.objectStore('models');
      const request = store.get(id);

      request.onsuccess = () => {
        const result = request.result as DBModel;
        if (result) {
            resolve({ file: result.file, animationFiles: result.animationFiles });
        } else {
            resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async updateModelPlacement(id: string, isPlacedInScene: boolean): Promise<void> {
      await this.canonicalChange('models', 'upsert', { id, isPlacedInScene }, id);
  }

  async updateModelTextureOverrides(id: string, overrides: Record<string, string>): Promise<void> {
      await this.canonicalChange('models', 'upsert', { id, textureOverrides: overrides }, id);
  }

  /** Replace a model's per-material overrides (normalized; `{}` clears them all). */
  async updateModelMaterialOverrides(id: string, overrides: MaterialOverrides): Promise<void> {
      await this.canonicalChange('models', 'upsert', { id, materialOverrides: normalizeMaterialOverrides(overrides) }, id);
  }

  async updateModelMirroredClips(id: string, mirroredClips: string[]): Promise<void> {
      await this.canonicalChange('models', 'upsert', { id, mirroredClips }, id);
  }

  /** Rename and/or move a model in the content browser; folder '' is the library root. */
  /** `clipNames` keeps the model's clip names when it is renamed (they would follow the new name). */
  async updateModelInfo(id: string, updates: AssetInfoUpdate, clipNames?: string[]): Promise<void> {
      await this.canonicalChange('models', 'upsert', { ...assetInfoDocument(id, updates), ...(clipNames?.length ? { clipNames } : {}) }, id);
  }

  async addModelTextureOverride(modelId: string, materialNames: string[], file: File, dimensions: { width: number; height: number }): Promise<string> {
    this.requireNativeProject();
    const assetId = await projectService.uploadAsset(file);
    const snapshot = await projectService.getSnapshotAll('models');
    const model = nativeDomainRecords(snapshot, 'models').find((record) => record.id === modelId);
    if (!model) throw new Error('Model does not exist in the active project');
    const textureId = assetId;
    const textureOverrides = { ...(model.textureOverrides || {}) } as Record<string, string>;
    for (const materialName of materialNames) textureOverrides[materialName] = textureId;
    await projectService.applyChanges([
      { domain: 'textures', operation: 'upsert', id: textureId, value: { id: textureId, name: file.name, assetId, dimensions } },
      { domain: 'models', operation: 'upsert', id: modelId, value: { ...model, textureOverrides } },
    ]);
    return textureId;
  }

  async deleteModel(id: string): Promise<void> {
    this.requireNativeProject();
    const snapshot = await projectService.getSnapshotAll();
    const changes: Array<{ domain: string; operation: 'remove' | 'upsert'; id: string; value?: unknown }> = [
      { domain: 'models', operation: 'remove', id },
    ];
    for (const domain of ['animations', 'attachments', 'sockets', 'graphs']) {
      for (const record of nativeDomainRecords(snapshot, domain)) {
        if (record.modelId === id || record.parentModelId === id) changes.push({ domain, operation: 'remove', id: record.id });
      }
    }
    // An object's children go with it: the project rejects an object whose parent is missing.
    const removedObjects = new Set<string>();
    for (const record of sortByHierarchy(nativeDomainRecords(snapshot, 'objects') as LevelObject[])) {
      if (record.modelId !== id && !(record.parentId && removedObjects.has(record.parentId))) continue;
      removedObjects.add(record.id);
      changes.push({ domain: 'objects', operation: 'remove', id: record.id });
    }
    for (const record of nativeDomainRecords(snapshot, 'blueprints')) {
      if (record.linkedModelId === id) changes.push({ domain: 'blueprints', operation: 'upsert', id: record.id, value: { ...record, linkedModelId: null } });
    }
    await projectService.applyChanges(changes);
  }

  /** `clipNames[i]` names the clips of `files[i]`; they are stored so the clips keep those names. */
  async addAnimations(modelId: string, files: File[], transfer: AssetTransferOptions = {}, clipNames: string[][] = []): Promise<void> {
    this.requireNativeProject();
    const animationAssets: Array<{ id: string; name: string; assetId: string; modelId: string; clipNames?: string[] }> = [];
    for (const [index, file] of files.entries()) {
      const assetId = await projectService.uploadAsset(file, {
        ...transfer,
        onProgress: (progress) => transfer.onProgress?.((index + progress) / Math.max(1, files.length)),
      });
      assertTransferActive(transfer);
      // Its own id, not the file's hash: the same file on two models is two documents.
      animationAssets.push({
        id: crypto.randomUUID(), name: file.name, assetId, modelId,
        ...(clipNames[index]?.length ? { clipNames: clipNames[index] } : {}),
      });
    }
    assertTransferActive(transfer);
    transfer.onPhase?.('project_record_commit');
    await projectService.applyChanges(animationAssets.map((animation) => ({
      domain: 'animations', operation: 'upsert' as const, id: animation.id, value: animation,
    })), transfer.diagnostics);
  }

  // --- ATTACHMENTS ---

  async addAttachment(
    attachment: DBAttachment,
    transfer: AssetTransferOptions = {},
    lease?: EditorSessionLease,
  ): Promise<void> {
    this.requireEditorLease(lease);
    this.requireNativeProject();
    const assetId = await projectService.uploadAsset(new File([attachment.file], attachment.name), transfer);
    assertTransferActive(transfer);
    this.requireEditorLease(lease);
    transfer.onPhase?.('project_record_commit');
    await projectService.applyChanges([{ domain: 'attachments', operation: 'upsert', id: attachment.id, value: {
      id: attachment.id, name: attachment.name, assetId,
      parentModelId: attachment.parentModelId, boneName: attachment.boneName,
      position: attachment.position, rotation: attachment.rotation, scale: attachment.scale,
    } }], transfer.diagnostics);
  }

  async getAllAttachments(): Promise<DBAttachment[]> {
      return this.readOnlyStoreAll<DBAttachment>('attachments');
  }

  async getAllAttachmentMetadata(): Promise<DBAttachmentMetadata[]> {
    const db = await this.getDB();
    if (!db) return [];
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['attachments'], 'readonly');
      const store = transaction.objectStore('attachments');
      const request = store.openCursor();
      const results: DBAttachmentMetadata[] = [];

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result as IDBCursorWithValue;
        if (cursor) {
          const { file, ...metadata } = cursor.value as DBAttachment;
          results.push(metadata);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getAttachmentFile(id: string): Promise<Blob | null> {
    const db = await this.getDB();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['attachments'], 'readonly');
      const store = transaction.objectStore('attachments');
      const request = store.get(id);

      request.onsuccess = () => {
        const result = request.result as DBAttachment;
        resolve(result ? result.file : null);
      };
      request.onerror = () => reject(request.error);
    });
  }


  async updateAttachment(id: string, updates: Partial<DBAttachment>, lease?: EditorSessionLease): Promise<void> {
      await this.canonicalChange('attachments', 'upsert', { id, ...updates }, id, lease);
  }

  async deleteAttachment(id: string, lease?: EditorSessionLease): Promise<void> {
      await this.canonicalChange('attachments', 'remove', undefined, id, lease);
  }

  // --- SOCKETS (MUZZLES) ---

  async addSocket(socket: DBSocket, lease?: EditorSessionLease): Promise<void> {
    await this.canonicalChange('sockets', 'upsert', socket, socket.id, lease);
  }

  async getAllSockets(): Promise<DBSocket[]> {
      return this.readOnlyStoreAll<DBSocket>('sockets');
  }

  async updateSocket(id: string, updates: Partial<DBSocket>, lease?: EditorSessionLease): Promise<void> {
      await this.canonicalChange('sockets', 'upsert', { id, ...updates }, id, lease);
  }

  async deleteSocket(id: string, lease?: EditorSessionLease): Promise<void> {
      await this.canonicalChange('sockets', 'remove', undefined, id, lease);
  }

  // --- LEVEL OBJECTS ---

  async addLevelObject(obj: DBLevelObject, lease?: EditorSessionLease): Promise<void> {
    await this.canonicalChange('objects', 'upsert', obj, obj.id, lease, prepareLevelObjectDocument);
  }

  /**
   * Fetch all level objects indiscriminately (for export).
   */
  async getAllLevelObjects(): Promise<DBLevelObject[]> {
      return this.readOnlyStoreAll<DBLevelObject>('levelObjects');
  }

  /**
   * Fetch level objects strictly for a specific level ID.
   */
  async getLevelObjects(levelId: string): Promise<DBLevelObject[]> {
      const db = await this.getDB();
      if (!db) return [];
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['levelObjects'], 'readonly');
          const store = transaction.objectStore('levelObjects');
          const index = store.index('levelId');
          const request = index.getAll(levelId);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
      });
  }

  /**
   * Read the complete authoritative level-object domain for the open native
   * project. The legacy IndexedDB store is deliberately not consulted here:
   * it may describe an unrelated browser project and is only a migration
   * source.
   */
  async getAllNativeLevelObjects(): Promise<DBLevelObject[]> {
    this.requireNativeProject();
    const snapshot = await projectService.getSnapshotAll('objects');
    return nativeDomainRecords(snapshot, 'objects') as DBLevelObject[];
  }

  async updateLevelObject(id: string, updates: Partial<DBLevelObject>, lease?: EditorSessionLease): Promise<void> {
    await this.canonicalChange('objects', 'upsert', { id, ...updates }, id, lease, prepareLevelObjectDocument);
  }

  async deleteLevelObject(id: string, lease?: EditorSessionLease): Promise<void> {
    await this.canonicalChange('objects', 'remove', undefined, id, lease);
  }

  // --- PREFABS ---

  /** Every prefab in the open native project ([] when no project is open). */
  async getAllPrefabs(): Promise<PrefabData[]> {
    if (!projectService.getStatus().projectId) return [];
    const snapshot = await projectService.getSnapshotAll('prefabs');
    return nativeDomainRecords(snapshot, 'prefabs') as PrefabData[];
  }

  async upsertPrefab(prefab: PrefabData, lease?: EditorSessionLease): Promise<void> {
    await this.canonicalChange('prefabs', 'upsert', prefab, prefab.id, lease);
  }

  /** Instances stay in their levels as plain objects: their prefabId must
   * resolve, so it (and the prefab object link) is cleared in the same
   * transaction. Queued behind earlier writes so a pending instance write
   * cannot re-add it. */
  async deletePrefab(id: string, lease?: EditorSessionLease): Promise<void> {
    await this.enqueueMutation(async () => {
      this.requireEditorLease(lease);
      this.requireNativeProject();
      const snapshot = await projectService.getSnapshotAll('objects');
      this.requireEditorLease(lease);
      const changes: Array<{ domain: string; operation: 'remove' | 'upsert'; id: string; value?: unknown }> = [
        { domain: 'prefabs', operation: 'remove', id },
      ];
      for (const record of nativeDomainRecords(snapshot, 'objects')) {
        if (record.prefabId !== id) continue;
        const { prefabId: _unlinked, prefabObjectId: _unlinkedObject, ...object } = record;
        changes.push({ domain: 'objects', operation: 'upsert', id: record.id, value: object });
      }
      await projectService.applyChanges(changes);
    });
  }

  /**
   * Saves a changed prefab together with the edits that bring its instances in other levels up to
   * date (utils/prefabSync.ts), as one transaction. `removals` are deleted in the order given
   * (children before parents).
   */
  async updatePrefabAndInstances(prefab: PrefabData, upserts: DBLevelObject[], removals: string[], lease?: EditorSessionLease): Promise<void> {
    await this.enqueueMutation(async () => {
      this.requireEditorLease(lease);
      this.requireNativeProject();
      const changes: Array<{ domain: string; operation: 'remove' | 'upsert'; id: string; value?: unknown }> = [
        { domain: 'prefabs', operation: 'upsert', id: prefab.id, value: prefab },
        ...removals.map(id => ({ domain: 'objects', operation: 'remove' as const, id })),
        ...upserts.map(object => ({ domain: 'objects', operation: 'upsert' as const, id: object.id, value: object })),
      ];
      await projectService.applyChanges(changes);
    });
  }

  // --- TEXTURES ---

  async addTexture(texture: DBTexture, transfer: AssetTransferOptions = {}): Promise<void> {
    this.requireNativeProject();
    const assetId = await projectService.uploadAsset(new File([texture.file], texture.name), transfer);
    assertTransferActive(transfer);
    transfer.onPhase?.('project_record_commit');
    await projectService.applyChanges([{ domain: 'textures', operation: 'upsert', id: texture.id, value: {
      id: texture.id, name: texture.name, assetId, dimensions: texture.dimensions,
    } }], transfer.diagnostics);
  }

  async getAllTextures(): Promise<DBTexture[]> {
      return this.readOnlyStoreAll<DBTexture>('textures');
  }

  /** Rename and/or move a texture in the content browser; folder '' is the library root. */
  async updateTextureInfo(id: string, updates: AssetInfoUpdate): Promise<void> {
      await this.canonicalChange('textures', 'upsert', assetInfoDocument(id, updates), id);
  }

  async deleteTexture(id: string): Promise<void> {
    this.requireNativeProject();
    const snapshot = await projectService.getSnapshotAll();
    const changes: Array<{ domain: string; operation: 'remove' | 'upsert'; id: string; value?: unknown }> = [
      { domain: 'textures', operation: 'remove', id },
    ];
    for (const record of nativeDomainRecords(snapshot, 'models')) {
      const textureOverrides = Object.fromEntries(Object.entries(record.textureOverrides || {}).filter(([, textureId]) => textureId !== id));
      const materialOverrides = record.materialOverrides ? withoutMaterialOverrideTexture(record.materialOverrides, id) : undefined;
      const texturesChanged = Object.keys(textureOverrides).length !== Object.keys(record.textureOverrides || {}).length;
      const materialsChanged = materialOverrides !== undefined && materialOverrides !== record.materialOverrides;
      if (texturesChanged || materialsChanged) {
        changes.push({ domain: 'models', operation: 'upsert', id: record.id, value: {
          ...record,
          ...(texturesChanged ? { textureOverrides } : {}),
          ...(materialsChanged ? { materialOverrides } : {}),
        } });
      }
    }
    for (const record of nativeDomainRecords(snapshot, 'blueprints')) {
      if (record.textureId === id) changes.push({ domain: 'blueprints', operation: 'upsert', id: record.id, value: { ...record, textureId: null } });
    }
    for (const record of nativeDomainRecords(snapshot, 'sockets')) {
      if (record.flashConfig?.textureId === id) changes.push({ domain: 'sockets', operation: 'upsert', id: record.id, value: { ...record, flashConfig: null } });
    }
    for (const record of nativeDomainRecords(snapshot, 'materials')) {
      const textureIds = Array.isArray(record.textureIds) ? record.textureIds.filter((textureId: unknown) => textureId !== id) : [];
      if (textureIds.length !== (record.textureIds || []).length) changes.push({ domain: 'materials', operation: 'upsert', id: record.id, value: { ...record, textureIds } });
    }
    for (const record of nativeDomainRecords(snapshot, 'objects')) {
      const stored = record.terrainData;
      if (stored?.textureId === id || terrainLayersReferenceTexture(stored, id)) {
        const { textureId: _removed, ...withoutTexture } = stored;
        // Layers keep their slot (splat channel N weights layer N); only the texture goes.
        const terrainData = withoutTerrainLayerTexture(stored.textureId === id ? withoutTexture : stored, id);
        changes.push({ domain: 'objects', operation: 'upsert', id: record.id, value: { ...record, terrainData } });
      }
    }
    await projectService.applyChanges(changes);
  }

  // --- AUDIO ---

  async addAudio(audio: DBAudio, transfer: AssetTransferOptions = {}): Promise<void> {
    this.requireNativeProject();
    const assetId = await projectService.uploadAsset(new File([audio.file], audio.name), transfer);
    assertTransferActive(transfer);
    transfer.onPhase?.('project_record_commit');
    await projectService.applyChanges([{ domain: 'audio', operation: 'upsert', id: audio.id, value: {
      id: audio.id, name: audio.name, assetId, type: audio.type, duration: audio.duration,
    } }], transfer.diagnostics);
  }

  async getAllAudio(): Promise<DBAudio[]> {
      return this.readOnlyStoreAll<DBAudio>('audios');
  }

  /** Rename and/or move an audio asset in the content browser; folder '' is the library root. */
  async updateAudioInfo(id: string, updates: AssetInfoUpdate): Promise<void> {
      await this.canonicalChange('audio', 'upsert', assetInfoDocument(id, updates), id);
  }

  async deleteAudio(id: string): Promise<void> {
    this.requireNativeProject();
    const snapshot = await projectService.getSnapshotAll();
    const changes: Array<{ domain: string; operation: 'remove' | 'upsert'; id: string; value?: unknown }> = [
      { domain: 'audio', operation: 'remove', id },
    ];
    for (const record of nativeDomainRecords(snapshot, 'objects')) {
      if (record.audioConfig?.audioId === id) changes.push({ domain: 'objects', operation: 'upsert', id: record.id, value: { ...record, audioConfig: null } });
    }
    for (const record of nativeDomainRecords(snapshot, 'blueprints')) {
      const weaponSounds = Array.isArray(record.weaponSounds) ? record.weaponSounds.filter((audioId: unknown) => audioId !== id) : [];
      if (weaponSounds.length !== (record.weaponSounds || []).length) changes.push({ domain: 'blueprints', operation: 'upsert', id: record.id, value: { ...record, weaponSounds } });
    }
    await projectService.applyChanges(changes);
  }

  // --- BLUEPRINTS ---

  async saveBlueprint(blueprint: Blueprint): Promise<void> {
    await this.canonicalChange('blueprints', 'upsert', blueprint, blueprint.id);
  }

  async getAllBlueprints(): Promise<Blueprint[]> {
    return this.readOnlyStoreAll<Blueprint>('blueprints');
  }

  async deleteBlueprint(id: string): Promise<void> {
      this.requireNativeProject();
      const snapshot = await projectService.getSnapshotAll();
      const changes: Array<{ domain: string; operation: 'remove' | 'upsert'; id: string; value?: unknown }> = [
        { domain: 'blueprints', operation: 'remove', id },
      ];
      for (const record of nativeDomainRecords(snapshot, 'objects')) {
        if (record.spawnConfig?.blueprintId === id) {
          changes.push({ domain: 'objects', operation: 'upsert', id: record.id, value: { ...record, spawnConfig: null } });
        }
      }
      await projectService.applyChanges(changes);
  }

  // --- SYSTEM ---

  /** Copy the legacy browser database into an empty native project. The old
   * database is opened read-only, blobs are streamed through host upload
   * tickets, and authored documents are committed together only after every
   * legacy page has been converted. */
  async migrateLegacyDatabase(onProgress?: (records: number) => void): Promise<number> {
    this.requireNativeProject();
    const active = await projectService.getSnapshotAll();
    const occupied = Object.entries(active?.domains || {}).some(([domain]) => domain !== 'metadata' && nativeDomainRecords(active, domain).length > 0);
    if (occupied) throw new Error('Browser migration requires an empty native project');

    const changes: Array<{ domain: string; operation: 'upsert'; id: string; value: unknown }> = [];
    const textureDocuments = new Set<string>();
    let processed = 0;
    const add = (domain: string, value: Record<string, unknown>) => {
      if (typeof value.id !== 'string' || !value.id) throw new Error(`Legacy ${domain} record has no stable id`);
      changes.push({ domain, operation: 'upsert', id: value.id, value });
      onProgress?.(++processed);
    };

    for await (const page of this.readOnlyStorePages<DBTexture>('textures')) {
      for (const record of page) {
        const assetId = await projectService.uploadAsset(new File([record.file], record.name, { type: record.file.type || 'application/octet-stream' }));
        add('textures', { id: record.id, name: record.name, assetId, dimensions: record.dimensions });
        textureDocuments.add(record.id);
      }
    }
    for await (const page of this.readOnlyStorePages<DBAudio>('audios')) {
      for (const record of page) {
        const assetId = await projectService.uploadAsset(new File([record.file], record.name, { type: record.type || record.file.type || 'application/octet-stream' }));
        add('audio', { id: record.id, name: record.name, assetId, type: record.type, duration: record.duration });
      }
    }
    for await (const page of this.readOnlyStorePages<DBModel>('models')) {
      for (const record of page) {
        const assetId = await projectService.uploadAsset(new File([record.file], record.name, { type: record.file.type || 'application/octet-stream' }));
        const textureOverrides: Record<string, string> = {};
        for (const [materialName, legacyUrl] of Object.entries(record.textureOverrides || {})) {
          const response = await fetch(legacyUrl);
          if (!response.ok) throw new Error(`Legacy material texture could not be read (${response.status})`);
          const blob = await response.blob();
          const overrideAssetId = await projectService.uploadAsset(new File([blob], 'legacy-material.png', { type: blob.type || 'image/png' }));
          textureOverrides[materialName] = overrideAssetId;
          if (!textureDocuments.has(overrideAssetId)) {
            add('textures', { id: overrideAssetId, name: 'Legacy material override', assetId: overrideAssetId, dimensions: { width: 0, height: 0 } });
            textureDocuments.add(overrideAssetId);
          }
        }
        add('models', {
          id: record.id, name: record.name, assetId, category: record.category,
          isPlacedInScene: record.isPlacedInScene, textureOverrides,
        });
        for (const animation of record.animationFiles || []) {
          const animationAssetId = await projectService.uploadAsset(new File([animation.file], animation.name, { type: animation.file.type || 'application/octet-stream' }));
          add('animations', { id: animationAssetId, name: animation.name, assetId: animationAssetId, modelId: record.id });
        }
      }
    }
    for await (const page of this.readOnlyStorePages<DBAttachment>('attachments')) {
      for (const record of page) {
        const assetId = await projectService.uploadAsset(new File([record.file], record.name, { type: record.file.type || 'application/octet-stream' }));
        add('attachments', pickDefined(record as unknown as Record<string, unknown>, ['id', 'name', 'parentModelId', 'boneName', 'position', 'rotation', 'scale'], { assetId }));
      }
    }

    const jsonStores: Array<[string, string, string[]]> = [
      ['levels', 'levels', ['id', 'name', 'createdAt', 'blueprint']],
      ['levelObjects', 'objects', ['id', 'levelId', 'modelId', 'name', 'type', 'position', 'rotation', 'scale', 'spawnConfig', 'audioConfig', 'terrainData', 'skyConfig']],
      ['sockets', 'sockets', ['id', 'name', 'parentModelId', 'boneName', 'position', 'rotation', 'scale', 'flashConfig']],
      ['blueprints', 'blueprints', ['id', 'name', 'type', 'description', 'linkedModelId', 'textureId', 'stats', 'traits', 'variables', 'animationGraph', 'meshScale', 'aimOffset', 'weaponSounds', 'weaponVolume']],
    ];
    for (const [store, domain, keys] of jsonStores) {
      for await (const page of this.readOnlyStorePages<Record<string, unknown>>(store)) {
        for (const record of page) {
          const value = pickDefined(record, keys);
          // Sculpted legacy terrains move their heights into a heightfield asset.
          add(domain, domain === 'objects' ? (await prepareLevelObjectDocument(value)).value as Record<string, unknown> : value);
        }
      }
    }
    if (!changes.length) throw new Error('No legacy browser project data was found');
    if (new TextEncoder().encode(JSON.stringify(changes)).byteLength > 900_000) {
      throw new Error('Legacy project metadata is too large for one safe migration transaction');
    }
    await projectService.applyChanges(changes);
    return processed;
  }

  async clearDatabase(): Promise<void> {
    throw new Error('Legacy project storage is read-only; clear the native project instead');
  }

  /**
   * Delete Entire Database: 
   * WARNING: Only use this if you intend to reload the page afterwards, 
   * as it closes connections. For SPA resets, use clearDatabase().
   */
  async deleteEntireDatabase(): Promise<void> {
    throw new Error('Legacy project storage is read-only and cannot be deleted');
  }
}

frontendDiagnostics.instrumentClass(DBOperations, 'project_documents', [
  'addLevel', 'deleteLevel', 'addModel', 'updateModelPlacement',
  'updateModelTextureOverrides', 'updateModelMaterialOverrides', 'updateModelInfo', 'addModelTextureOverride', 'deleteModel',
  'addAnimations', 'addAttachment', 'updateAttachment', 'deleteAttachment',
  'addSocket', 'updateSocket', 'deleteSocket', 'addLevelObject',
  'updateLevelObject', 'deleteLevelObject', 'getAllNativeLevelObjects', 'addTexture', 'updateTextureInfo', 'deleteTexture',
  'addAudio', 'updateAudioInfo', 'deleteAudio', 'saveBlueprint', 'deleteBlueprint',
  'getAllPrefabs', 'upsertPrefab', 'deletePrefab',
  'migrateLegacyDatabase', 'clearDatabase', 'deleteEntireDatabase',
]);
export const dbOperations = new DBOperations();

function nativeDomainRecords(snapshot: Awaited<ReturnType<typeof projectService.getSnapshotAll>>, domain: string): Array<Record<string, any>> {
  const raw = snapshot?.domains?.[domain];
  const values = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { documents?: unknown[] }).documents)
      ? (raw as { documents: unknown[] }).documents : [];
  return values.filter((value): value is Record<string, any> => Boolean(value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'));
}

/** Prepares a document for writing; `readStored` reads the document it replaces, if any. */
type DocumentPreparation = (value: unknown, readStored?: () => Promise<Record<string, unknown> | undefined>) => Promise<{ value: unknown; afterCommit?: () => void }>;

/** Level object documents carry heightfield and splat map asset references,
 * never inline terrain heights or paint weights: a sculpted or painted terrain
 * would exceed the host message and snapshot page limits and make the whole
 * objects domain unreadable. */
async function prepareLevelObjectDocument(value: unknown, readStored?: () => Promise<Record<string, unknown> | undefined>): Promise<{ value: unknown; afterCommit?: () => void }> {
  if (!value || typeof value !== 'object') return { value };
  const terrainData = (value as { terrainData?: unknown }).terrainData;
  if (!terrainData || typeof terrainData !== 'object') return { value };
  // Both steps compare against the document being replaced: read it once.
  let storedTerrain: Promise<TerrainData | null | undefined> | undefined;
  const readStoredTerrain = readStored && (() => {
    storedTerrain ??= readStored().then((stored) => stored?.terrainData as TerrainData | null | undefined);
    return storedTerrain;
  });
  const prepared = await externalizeTerrainData(terrainData as TerrainData, {
    storedHeightfield: readStoredTerrain && (async () => (await readStoredTerrain())?.heightfield),
  });
  const splat = await externalizeTerrainSplat(prepared.terrainData, {
    storedSplatmap: readStoredTerrain && (async () => (await readStoredTerrain())?.splatmap),
  });
  return {
    value: { ...(value as Record<string, unknown>), terrainData: splat.terrainData },
    afterCommit: () => { prepared.remember?.(); splat.remember?.(); },
  };
}

const ASSET_INFO_MAX_LENGTH = 256;

/** The rename/move fields as stored: a trimmed, non-empty name; folder '' is the library root. Throws when invalid. */
export function normalizeAssetInfoUpdate(updates: AssetInfoUpdate): AssetInfoUpdate {
  const normalized: AssetInfoUpdate = {};
  if (updates.name !== undefined) {
    const name = updates.name.trim();
    if (!name) throw new Error('An asset name is required.');
    if (name.length > ASSET_INFO_MAX_LENGTH) throw new Error(`Asset names are limited to ${ASSET_INFO_MAX_LENGTH} characters.`);
    normalized.name = name;
  }
  if (updates.folder !== undefined) {
    if (updates.folder.length > ASSET_INFO_MAX_LENGTH) throw new Error(`Folder paths are limited to ${ASSET_INFO_MAX_LENGTH} characters.`);
    normalized.folder = updates.folder;
  }
  return normalized;
}

/**
 * `overrides` without any texture slot referencing `textureId` (entries left
 * empty are dropped). Returns `overrides` itself when nothing references it.
 */
export function withoutMaterialOverrideTexture(overrides: MaterialOverrides, textureId: string): MaterialOverrides {
  let next = overrides;
  for (const [materialName, override] of Object.entries(overrides)) {
    if (override?.mapTextureId === textureId) next = setMaterialOverrideField(next, materialName, 'mapTextureId', undefined);
    if (override?.normalTextureId === textureId) next = setMaterialOverrideField(next, materialName, 'normalTextureId', undefined);
  }
  return next;
}

/** The partial asset document a rename/move merges into the stored one; only the given fields change. */
function assetInfoDocument(id: string, updates: AssetInfoUpdate): Record<string, unknown> {
  return { id, ...normalizeAssetInfoUpdate(updates) };
}

function pickDefined(source: Record<string, unknown>, keys: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const output: Record<string, unknown> = { ...extra };
  for (const key of keys) if (source[key] !== undefined) output[key] = source[key];
  return output;
}
