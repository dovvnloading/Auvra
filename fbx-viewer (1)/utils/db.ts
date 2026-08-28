
import { AssetCategory, AttachmentData, Blueprint, SocketData, TextureData, LevelObject, LevelData, AudioData } from '../types';
import { AssetTransferOptions, projectService } from './projectService';

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
  private dbPromise: Promise<IDBDatabase>;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.dbPromise = new Promise((resolve, reject) => {
      // Legacy storage is a read-only migration source. Opening without a
      // version prevents upgrades; a new database is aborted immediately.
      const request = indexedDB.open(DB_NAME);

      request.onerror = () => {
        console.error("Database error", request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onupgradeneeded = () => {
        request.transaction?.abort();
        reject(new Error('Legacy project storage does not exist; refusing to create or upgrade it'));
      };
    });
  }

  private async getDB(): Promise<IDBDatabase> {
    return this.dbPromise;
  }

  /** Read one bounded legacy page through a readonly cursor. */
  private async readOnlyStorePage<T>(storeName: string, offset: number, pageSize = 64): Promise<{ values: T[]; nextOffset: number | null }> {
    const db = await this.getDB();
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
    if (!db.objectStoreNames.contains(storeName)) return;
    let offset = 0;
    for (;;) {
      const page = await this.readOnlyStorePage<T>(storeName, offset);
      if (page.values.length) yield page.values;
      if (page.nextOffset === null) return;
      offset = page.nextOffset;
    }
  }

  /** Route authored JSON mutations to the native repository once a project is
   * open. IndexedDB remains a read-only migration source; binary uploads are
   * handled by the host asset transport and are therefore not sent here. */
  private async canonicalChange(domain: string, operation: 'upsert' | 'remove', value: unknown, id?: string): Promise<boolean> {
    const run = () => this.performCanonicalChange(domain, operation, value, id);
    const result = this.mutationQueue.then(run, run);
    this.mutationQueue = result.catch(() => undefined);
    return result;
  }

  private async performCanonicalChange(domain: string, operation: 'upsert' | 'remove', value: unknown, id?: string): Promise<boolean> {
    if (!projectService.getStatus().projectId) throw new Error('Open a native project before editing');
    if (projectService.getStatus().readOnly) throw new Error('Project is read-only');
    let completeValue = value;
    if (operation === 'upsert' && value && typeof value === 'object' && id) {
      const snapshot = await projectService.getSnapshotAll(domain);
      const rawDomain = snapshot?.domains?.[domain];
      const records = Array.isArray(rawDomain)
        ? rawDomain
        : rawDomain && typeof rawDomain === 'object' && Array.isArray((rawDomain as { documents?: unknown[] }).documents)
          ? (rawDomain as { documents: unknown[] }).documents : snapshot?.documents || [];
      const current = records.find((record) => record && typeof record === 'object' && (record as { id?: unknown }).id === id);
      if (current && typeof current === 'object') completeValue = { ...(current as Record<string, unknown>), ...(value as Record<string, unknown>) };
    }
    await projectService.applyChanges([{ domain, operation, id, value: completeValue }]);
    return true;
  }

  private requireNativeProject(): void {
    if (!projectService.getStatus().projectId) throw new Error('Open a native project before editing');
    if (projectService.getStatus().readOnly) throw new Error('Project is read-only');
  }

  // --- LEVELS ---

  async addLevel(level: LevelData): Promise<void> {
      await this.canonicalChange('levels', 'upsert', level, level.id);
  }

  async getAllLevels(): Promise<LevelData[]> {
      return this.readOnlyStoreAll<LevelData>('levels');
  }

  async deleteLevel(id: string): Promise<void> {
      this.requireNativeProject();
      const snapshot = await projectService.getSnapshotAll();
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
    await projectService.applyChanges([{ domain: 'models', operation: 'upsert', id: model.id, value: {
      id: model.id, name: model.name, assetId: modelAssetId,
      category: model.category, isPlacedInScene: model.isPlacedInScene,
    } }, ...animationAssets.map((animation) => ({
      domain: 'animations', operation: 'upsert' as const, id: animation.id, value: animation,
    }))]);
  }

  async getAllModels(): Promise<DBModel[]> {
    return this.readOnlyStoreAll<DBModel>('models');
  }

  async getAllModelMetadata(): Promise<DBModelMetadata[]> {
    const db = await this.getDB();
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
    for (const domain of ['animations', 'attachments', 'sockets', 'graphs', 'objects']) {
      for (const record of nativeDomainRecords(snapshot, domain)) {
        if (record.modelId === id || record.parentModelId === id) changes.push({ domain, operation: 'remove', id: record.id });
      }
    }
    for (const record of nativeDomainRecords(snapshot, 'blueprints')) {
      if (record.linkedModelId === id) changes.push({ domain: 'blueprints', operation: 'upsert', id: record.id, value: { ...record, linkedModelId: null } });
    }
    await projectService.applyChanges(changes);
  }

  async addAnimations(modelId: string, files: File[], transfer: AssetTransferOptions = {}): Promise<void> {
    this.requireNativeProject();
    const animationAssets: Array<{ id: string; name: string; assetId: string; modelId: string }> = [];
    for (const [index, file] of files.entries()) {
      const assetId = await projectService.uploadAsset(file, {
        ...transfer,
        onProgress: (progress) => transfer.onProgress?.((index + progress) / Math.max(1, files.length)),
      });
      assertTransferActive(transfer);
      animationAssets.push({ id: assetId, name: file.name, assetId, modelId });
    }
    assertTransferActive(transfer);
    await projectService.applyChanges(animationAssets.map((animation) => ({
      domain: 'animations', operation: 'upsert' as const, id: animation.id, value: animation,
    })));
  }

  // --- ATTACHMENTS ---

  async addAttachment(attachment: DBAttachment, transfer: AssetTransferOptions = {}): Promise<void> {
    this.requireNativeProject();
    const assetId = await projectService.uploadAsset(new File([attachment.file], attachment.name), transfer);
    assertTransferActive(transfer);
    await projectService.applyChanges([{ domain: 'attachments', operation: 'upsert', id: attachment.id, value: {
      id: attachment.id, name: attachment.name, assetId,
      parentModelId: attachment.parentModelId, boneName: attachment.boneName,
      position: attachment.position, rotation: attachment.rotation, scale: attachment.scale,
    } }]);
  }

  async getAllAttachments(): Promise<DBAttachment[]> {
      return this.readOnlyStoreAll<DBAttachment>('attachments');
  }

  async getAllAttachmentMetadata(): Promise<DBAttachmentMetadata[]> {
    const db = await this.getDB();
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


  async updateAttachment(id: string, updates: Partial<DBAttachment>): Promise<void> {
      await this.canonicalChange('attachments', 'upsert', { id, ...updates }, id);
  }

  async deleteAttachment(id: string): Promise<void> {
      await this.canonicalChange('attachments', 'remove', undefined, id);
  }

  // --- SOCKETS (MUZZLES) ---

  async addSocket(socket: DBSocket): Promise<void> {
    await this.canonicalChange('sockets', 'upsert', socket, socket.id);
  }

  async getAllSockets(): Promise<DBSocket[]> {
      return this.readOnlyStoreAll<DBSocket>('sockets');
  }

  async updateSocket(id: string, updates: Partial<DBSocket>): Promise<void> {
      await this.canonicalChange('sockets', 'upsert', { id, ...updates }, id);
  }

  async deleteSocket(id: string): Promise<void> {
      await this.canonicalChange('sockets', 'remove', undefined, id);
  }

  // --- LEVEL OBJECTS ---

  async addLevelObject(obj: DBLevelObject): Promise<void> {
    await this.canonicalChange('objects', 'upsert', obj, obj.id);
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
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['levelObjects'], 'readonly');
          const store = transaction.objectStore('levelObjects');
          const index = store.index('levelId');
          const request = index.getAll(levelId);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
      });
  }

  async updateLevelObject(id: string, updates: Partial<DBLevelObject>): Promise<void> {
    await this.canonicalChange('objects', 'upsert', { id, ...updates }, id);
  }

  async deleteLevelObject(id: string): Promise<void> {
    await this.canonicalChange('objects', 'remove', undefined, id);
  }

  // --- TEXTURES ---

  async addTexture(texture: DBTexture, transfer: AssetTransferOptions = {}): Promise<void> {
    this.requireNativeProject();
    const assetId = await projectService.uploadAsset(new File([texture.file], texture.name), transfer);
    assertTransferActive(transfer);
    await projectService.applyChanges([{ domain: 'textures', operation: 'upsert', id: texture.id, value: {
      id: texture.id, name: texture.name, assetId, dimensions: texture.dimensions,
    } }]);
  }

  async getAllTextures(): Promise<DBTexture[]> {
      return this.readOnlyStoreAll<DBTexture>('textures');
  }

  async deleteTexture(id: string): Promise<void> {
    this.requireNativeProject();
    const snapshot = await projectService.getSnapshotAll();
    const changes: Array<{ domain: string; operation: 'remove' | 'upsert'; id: string; value?: unknown }> = [
      { domain: 'textures', operation: 'remove', id },
    ];
    for (const record of nativeDomainRecords(snapshot, 'models')) {
      const textureOverrides = Object.fromEntries(Object.entries(record.textureOverrides || {}).filter(([, textureId]) => textureId !== id));
      if (Object.keys(textureOverrides).length !== Object.keys(record.textureOverrides || {}).length) {
        changes.push({ domain: 'models', operation: 'upsert', id: record.id, value: { ...record, textureOverrides } });
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
      if (record.terrainData?.textureId === id) {
        const { textureId: _removed, ...terrainData } = record.terrainData;
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
    await projectService.applyChanges([{ domain: 'audio', operation: 'upsert', id: audio.id, value: {
      id: audio.id, name: audio.name, assetId, type: audio.type, duration: audio.duration,
    } }]);
  }

  async getAllAudio(): Promise<DBAudio[]> {
      return this.readOnlyStoreAll<DBAudio>('audios');
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
        for (const record of page) add(domain, pickDefined(record, keys));
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

export const dbOperations = new DBOperations();

function nativeDomainRecords(snapshot: Awaited<ReturnType<typeof projectService.getSnapshotAll>>, domain: string): Array<Record<string, any>> {
  const raw = snapshot?.domains?.[domain];
  const values = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { documents?: unknown[] }).documents)
      ? (raw as { documents: unknown[] }).documents : [];
  return values.filter((value): value is Record<string, any> => Boolean(value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'));
}

function pickDefined(source: Record<string, unknown>, keys: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const output: Record<string, unknown> = { ...extra };
  for (const key of keys) if (source[key] !== undefined) output[key] = source[key];
  return output;
}
