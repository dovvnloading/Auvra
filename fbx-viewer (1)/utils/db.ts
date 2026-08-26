
import { AssetCategory, AttachmentData, Blueprint, SocketData, TextureData, LevelObject, LevelData, AudioData } from '../types';

const DB_NAME = 'OmniRenderDB';
const DB_VERSION = 16; 

export interface DBModel {
  id: string;
  name: string;
  file: Blob;
  animationFiles: Array<{ name: string, file: Blob }>;
  category: AssetCategory;
  thumbnail?: string;
  isPlacedInScene: boolean;
  textureOverrides?: Record<string, string>; // MaterialName -> Base64
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

  constructor() {
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error("Database error", request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        if (!db.objectStoreNames.contains('models')) {
          db.createObjectStore('models', { keyPath: 'id' });
        }
        
        if (!db.objectStoreNames.contains('attachments')) {
          const store = db.createObjectStore('attachments', { keyPath: 'id' });
          store.createIndex('parentModelId', 'parentModelId', { unique: false });
        }

        if (!db.objectStoreNames.contains('sockets')) {
           const store = db.createObjectStore('sockets', { keyPath: 'id' });
           store.createIndex('parentModelId', 'parentModelId', { unique: false });
        }

        if (!db.objectStoreNames.contains('textures')) {
           db.createObjectStore('textures', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('audios')) {
            db.createObjectStore('audios', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('levelObjects')) {
           const loStore = db.createObjectStore('levelObjects', { keyPath: 'id' });
           loStore.createIndex('levelId', 'levelId', { unique: false });
        } else {
           // Upgrade existing store for version 15
           const transaction = (event.target as IDBOpenDBRequest).transaction;
           if (transaction) {
               const loStore = transaction.objectStore('levelObjects');
               if (!loStore.indexNames.contains('levelId')) {
                   loStore.createIndex('levelId', 'levelId', { unique: false });
               }
           }
        }

        if (!db.objectStoreNames.contains('levels')) {
            db.createObjectStore('levels', { keyPath: 'id' });
        }

        if (db.objectStoreNames.contains('blueprints')) {
            db.deleteObjectStore('blueprints');
        }
        
        db.createObjectStore('blueprints', { keyPath: 'id' });
      };
    });
  }

  private async getDB(): Promise<IDBDatabase> {
    return this.dbPromise;
  }

  // --- LEVELS ---

  async addLevel(level: LevelData): Promise<void> {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['levels'], 'readwrite');
          const store = transaction.objectStore('levels');
          const request = store.put(level);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
      });
  }

  async getAllLevels(): Promise<LevelData[]> {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['levels'], 'readonly');
          const store = transaction.objectStore('levels');
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
      });
  }

  async deleteLevel(id: string): Promise<void> {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['levels', 'levelObjects'], 'readwrite');
          
          // Delete the level metadata
          const levelStore = transaction.objectStore('levels');
          levelStore.delete(id);

          // Delete all objects associated with this level
          const objStore = transaction.objectStore('levelObjects');
          const index = objStore.index('levelId');
          const request = index.openCursor(IDBKeyRange.only(id));

          request.onsuccess = (e) => {
              const cursor = (e.target as IDBRequest).result as IDBCursor;
              if (cursor) {
                  cursor.delete();
                  cursor.continue();
              }
          };

          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
      });
  }

  // --- MODELS ---

  async addModel(model: DBModel): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['models'], 'readwrite');
      const store = transaction.objectStore('models');
      const request = store.put(model);
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getAllModels(): Promise<DBModel[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['models'], 'readonly');
      const store = transaction.objectStore('models');
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
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
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['models'], 'readwrite');
          const store = transaction.objectStore('models');
          const getRequest = store.get(id);

          getRequest.onsuccess = () => {
              const data = getRequest.result as DBModel;
              if (data) {
                  data.isPlacedInScene = isPlacedInScene;
                  store.put(data);
                  resolve();
              } else {
                  reject(new Error("Model not found"));
              }
          };
          getRequest.onerror = () => reject(getRequest.error);
      });
  }

  async updateModelTextureOverrides(id: string, overrides: Record<string, string>): Promise<void> {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['models'], 'readwrite');
          const store = transaction.objectStore('models');
          const getRequest = store.get(id);

          getRequest.onsuccess = () => {
              const data = getRequest.result as DBModel;
              if (data) {
                  // Merge with existing overrides if any
                  data.textureOverrides = { ...(data.textureOverrides || {}), ...overrides };
                  store.put(data);
                  resolve();
              } else {
                  reject(new Error("Model not found"));
              }
          };
          getRequest.onerror = () => reject(getRequest.error);
      });
  }

  async deleteModel(id: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['models'], 'readwrite');
      const store = transaction.objectStore('models');
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async addAnimations(modelId: string, files: File[]): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['models'], 'readwrite');
        const store = transaction.objectStore('models');
        const getRequest = store.get(modelId);

        getRequest.onsuccess = () => {
            const data = getRequest.result as DBModel;
            if (data) {
                const newAnims = files.map(f => ({ name: f.name, file: f }));
                data.animationFiles = [...(data.animationFiles || []), ...newAnims];
                store.put(data);
                resolve();
            } else {
                reject(new Error("Model not found"));
            }
        };
        getRequest.onerror = () => reject(getRequest.error);
    });
  }

  // --- ATTACHMENTS ---

  async addAttachment(attachment: DBAttachment): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['attachments'], 'readwrite');
        const store = transaction.objectStore('attachments');
        const request = store.put(attachment);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
  }

  async getAllAttachments(): Promise<DBAttachment[]> {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['attachments'], 'readonly');
          const store = transaction.objectStore('attachments');
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
      });
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
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['attachments'], 'readwrite');
          const store = transaction.objectStore('attachments');
          const getRequest = store.get(id);

          getRequest.onsuccess = () => {
              const data = getRequest.result;
              if (data) {
                  const updatedData = { ...data, ...updates };
                  store.put(updatedData);
                  resolve();
              } else {
                  reject(new Error("Attachment not found"));
              }
          };
          getRequest.onerror = () => reject(getRequest.error);
      });
  }

  async deleteAttachment(id: string): Promise<void> {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['attachments'], 'readwrite');
          const store = transaction.objectStore('attachments');
          const request = store.delete(id);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
      });
  }

  // --- SOCKETS (MUZZLES) ---

  async addSocket(socket: DBSocket): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['sockets'], 'readwrite');
        const store = transaction.objectStore('sockets');
        const request = store.put(socket);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
  }

  async getAllSockets(): Promise<DBSocket[]> {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['sockets'], 'readonly');
          const store = transaction.objectStore('sockets');
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
      });
  }

  async updateSocket(id: string, updates: Partial<DBSocket>): Promise<void> {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['sockets'], 'readwrite');
          const store = transaction.objectStore('sockets');
          const getRequest = store.get(id);

          getRequest.onsuccess = () => {
              const data = getRequest.result;
              if (data) {
                  const updatedData = { ...data, ...updates };
                  store.put(updatedData);
                  resolve();
              } else {
                  reject(new Error("Socket not found"));
              }
          };
          getRequest.onerror = () => reject(getRequest.error);
      });
  }

  async deleteSocket(id: string): Promise<void> {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['sockets'], 'readwrite');
          const store = transaction.objectStore('sockets');
          const request = store.delete(id);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
      });
  }

  // --- LEVEL OBJECTS ---

  async addLevelObject(obj: DBLevelObject): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['levelObjects'], 'readwrite');
        const store = transaction.objectStore('levelObjects');
        const request = store.put(obj);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
  }

  /**
   * Fetch all level objects indiscriminately (for export).
   */
  async getAllLevelObjects(): Promise<DBLevelObject[]> {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['levelObjects'], 'readonly');
          const store = transaction.objectStore('levelObjects');
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
      });
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
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['levelObjects'], 'readwrite');
          const store = transaction.objectStore('levelObjects');
          const getRequest = store.get(id);

          getRequest.onsuccess = () => {
              const data = getRequest.result;
              if (data) {
                  const updatedData = { ...data, ...updates };
                  store.put(updatedData);
                  resolve();
              } else {
                  // If not found, ignore or reject. For fast dragging, ignore.
                  resolve();
              }
          };
          getRequest.onerror = () => reject(getRequest.error);
      });
  }

  async deleteLevelObject(id: string): Promise<void> {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['levelObjects'], 'readwrite');
          const store = transaction.objectStore('levelObjects');
          const request = store.delete(id);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
      });
  }

  // --- TEXTURES ---

  async addTexture(texture: DBTexture): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['textures'], 'readwrite');
        const store = transaction.objectStore('textures');
        const request = store.put(texture);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
  }

  async getAllTextures(): Promise<DBTexture[]> {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['textures'], 'readonly');
          const store = transaction.objectStore('textures');
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
      });
  }

  async deleteTexture(id: string): Promise<void> {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['textures'], 'readwrite');
          const store = transaction.objectStore('textures');
          const request = store.delete(id);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
      });
  }

  // --- AUDIO ---

  async addAudio(audio: DBAudio): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['audios'], 'readwrite');
        const store = transaction.objectStore('audios');
        const request = store.put(audio);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
  }

  async getAllAudio(): Promise<DBAudio[]> {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['audios'], 'readonly');
          const store = transaction.objectStore('audios');
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
      });
  }

  async deleteAudio(id: string): Promise<void> {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['audios'], 'readwrite');
          const store = transaction.objectStore('audios');
          const request = store.delete(id);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
      });
  }

  // --- BLUEPRINTS ---

  async saveBlueprint(blueprint: Blueprint): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['blueprints'], 'readwrite');
        const store = transaction.objectStore('blueprints');
        const request = store.put(blueprint);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
  }

  async getAllBlueprints(): Promise<Blueprint[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['blueprints'], 'readonly');
        const store = transaction.objectStore('blueprints');
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
  }

  async deleteBlueprint(id: string): Promise<void> {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
          const transaction = db.transaction(['blueprints'], 'readwrite');
          const store = transaction.objectStore('blueprints');
          const request = store.delete(id);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
      });
  }

  // --- SYSTEM ---

  async clearDatabase(): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      // Create a transaction that spans all stores to clear them atomically
      const transaction = db.transaction(
          ['models', 'attachments', 'sockets', 'blueprints', 'textures', 'levelObjects', 'levels', 'audios'], 
          'readwrite'
      );
      
      transaction.objectStore('models').clear();
      transaction.objectStore('attachments').clear();
      transaction.objectStore('sockets').clear();
      transaction.objectStore('blueprints').clear();
      transaction.objectStore('textures').clear();
      transaction.objectStore('levelObjects').clear();
      transaction.objectStore('levels').clear();
      transaction.objectStore('audios').clear();

      transaction.oncomplete = () => {
          console.log("[DB] Database Cleared (Object Stores Truncated)");
          resolve();
      };
      
      transaction.onerror = (e) => {
          console.error("[DB] Failed to clear database", e);
          reject(transaction.error);
      };
    });
  }

  /**
   * Delete Entire Database: 
   * WARNING: Only use this if you intend to reload the page afterwards, 
   * as it closes connections. For SPA resets, use clearDatabase().
   */
  async deleteEntireDatabase(): Promise<void> {
    console.log("[DB] deleteEntireDatabase called. Closing connections...");
    try {
        const db = await this.getDB();
        db.close();
    } catch(e) { /* ignore */ }

    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DB_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => resolve(); // Proceed anyway
    });
  }
}

export const dbOperations = new DBOperations();
