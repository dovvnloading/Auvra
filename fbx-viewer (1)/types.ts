
// ... existing imports ...
import * as THREE from 'three';
import React from 'react';
import type { ProjectStatus } from './utils/projectStatus';

export type AssetCategory = 'Character' | 'Prop' | 'Environment' | 'Weapon' | 'Animation' | 'Audio' | 'Texture';

// ... (keep existing interfaces) ...

export interface AudioData {
  id: string;
  name: string;
  url: string; // Blob URL
  type: string; // mime type
  duration: number;
  folder?: string; // Content browser folder path ('' or missing = root)
}

export interface AttachmentData {
  id: string;
  name: string;
  url: string;
  object: THREE.Group;
  parentModelId: string;
  boneName: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface MuzzleFlashConfig {
    enabled: boolean;
    textureId: string | null;
    scale: number;
    color: string;
    duration: number; // seconds
    rotationSpeed?: number;
    preview?: boolean; // Editor only: Force visibility
}

export interface SocketData {
  id: string;
  name: string;
  parentModelId: string;
  boneName: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  flashConfig?: MuzzleFlashConfig;
}

export interface TextureData {
  id: string;
  name: string;
  url: string;
  dimensions: { width: number; height: number };
  folder?: string; // Content browser folder path ('' or missing = root)
}

export interface LoadedModelData {
  id: string;
  name: string;
  url: string; // Blob URL
  object: THREE.Group;
  animations: THREE.AnimationClip[];
  category: AssetCategory;
  thumbnail?: string; // Base64 Data URL
  isPlacedInScene: boolean; // Determines if visible in Scene/Hierarchy
  initialScale?: [number, number, number]; // Scale applied during normalization
  textureOverrides?: Record<string, string>; // Map<MaterialName, logical texture id>
  folder?: string; // Content browser folder path, e.g. 'Characters/Enemies'
  importSettings?: ModelImportSettings;
}

export type LevelObjectType = 'prop' | 'foliage' | 'spawn_point' | 'audio_emitter' | 'terrain' | 'sky_sphere' | 'player_start';

export interface SpawnConfig {
    blueprintId: string; // ID of the Enemy Blueprint to spawn
    interval: number;    // Seconds between spawns
    maxSpawns: number;   // Total limit (0 = infinite)
    team: 'Enemy' | 'Player';
}

export interface AudioConfig {
    audioId: string; // Link to AudioData
    volume: number;
    loop: boolean;
    autoplay: boolean;
    muted?: boolean; // New: Local mute override
    isSpatial: boolean; // true = Positional (Falloff), false = Global (2D)
    refDistance: number; // Distance where volume starts dropping
    maxDistance: number; // Max hearing distance
    rolloffFactor: number;
    loopStart?: number; // Start time in seconds for the loop
    loopEnd?: number; // End time in seconds (Reset point)
}

/** Project reference to a terrain heightfield stored as a binary content-addressed asset. */
export interface TerrainHeightfieldReference {
    assetId: string;       // SHA-256 of the encoded heightfield asset
    encoding: 'float32le'; // 16-byte header, then row-major little-endian Float32 samples
    columns: number;       // resolution + 1
    rows: number;          // resolution + 1
}

export interface TerrainData {
    resolution: number; // e.g., 64, 128
    width: number;      // World units width
    depth: number;      // World units depth
    // Flattened (resolution + 1)^2 height values. In memory these are resolved
    // from `heightfield`; persisted documents carry them inline only in the
    // legacy form, which is migrated on the next terrain commit.
    heights?: number[];
    heightfield?: TerrainHeightfieldReference;
    textureId?: string; // Optional texture override
}

export interface SkyConfig {
    timeOfDay: number; // 0 - 24
    sunIntensity: number;
    ambienceIntensity: number;
    sunColor: string;
    fogColor: string;
    fogDensity: number;
    turbidity: number; // 0 - 20 (Haze)
    rayleigh: number; // 0 - 4 (Atmosphere thickness)
    mieCoefficient: number; // 0 - 0.1 (Haze scattering)
    mieDirectionalG: number; // 0 - 1 (Sun glare size)
    inclination: number; // 0 - 1 (Sun path tilt)
    azimuth: number; // 0 - 1 (Sun path rotation)
}

export interface LevelData {
  id: string;
  name: string;
  createdAt: number;
  blueprint?: LevelBlueprintData; // New: Level Logic
}

export interface LevelObject {
  id: string;
  levelId: string; // Link to LevelData
  modelId: string; // For props, this is the model. For spawners/terrain, this is empty.
  name: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  type: LevelObjectType; 
  spawnConfig?: SpawnConfig; // Only if type === 'spawn_point'
  audioConfig?: AudioConfig; // Only if type === 'audio_emitter'
  terrainData?: TerrainData; // Only if type === 'terrain'
  skyConfig?: SkyConfig;     // Only if type === 'sky_sphere'
  /** Transform parent in the same level; position/rotation/scale are local to it. */
  parentId?: string | null;
  /** Behaviour attached to the object (lights, movers, ...); see runtime/components. */
  components?: LevelComponent[];
  /** Prefab this object was instantiated from (instances are copies, not live links). */
  prefabId?: string;
}

export interface LevelComponent {
  id: string;
  type: string;
  enabled: boolean;
  props: Record<string, unknown>;
}

/** A reusable object tree stored in the project 'prefabs' domain. Transforms are local; the root's are relative to the placement point. */
export interface PrefabData {
  id: string;
  name: string;
  rootId: string;
  objects: Omit<LevelObject, 'levelId'>[];
  createdAt?: number;
}

/** Per-model import options stored on the model document. */
export interface ModelImportSettings {
  /** Scale the model so its largest dimension equals targetSize (the old behaviour forced 5). */
  normalize: boolean;
  targetSize: number;
}

export const DEFAULT_MODEL_IMPORT_SETTINGS: ModelImportSettings = { normalize: true, targetSize: 5 };

/** Content browser rename/move of a model, texture or audio asset; folder '' is the library root. */
export interface AssetInfoUpdate {
  name?: string;
  folder?: string;
}

// ... (keep remaining types unchanged) ...

export interface VisualSettings {
  environment: string;
  showGrid: boolean;
  showShadows: boolean;
  wireframe: boolean;
  exposure: number;
}

export type VariableType = 'Float' | 'Boolean';

export interface GraphVariable {
  id: string;
  name: string;
  type: VariableType;
  value: number | boolean; // Initial value
}

export interface InputBinding {
  id: string;
  key: string; // e.g., 'KeyW', 'Space'
  type: 'Press' | 'Release' | 'Hold';
  targetVariableId: string;
  targetValue: number | boolean;
}

export type StateType = 'Single' | 'Blend2D';

export interface BlendSample {
    id: string;
    clipName: string;
    position: [number, number]; // [x, y]
}

export interface GraphState {
  id: string;
  name: string;
  position: { x: number; y: number }; // Canvas position
  loop: boolean;
  isRoot?: boolean; // Identifies the default/central node
  
  // State Type Info
  stateType: StateType;
  
  // Single Clip Data
  clipName: string | null;

  // Blend Data
  blendSamples: BlendSample[];
  blendParamX: string; // Variable ID
  blendParamY: string; // Variable ID
}

export type ConditionOperator = '>' | '<' | '==' | '!=' | '>=' | '<=';

export interface GraphCondition {
  variableId: string;
  operator: ConditionOperator;
  value: number | boolean;
}

export interface GraphTransition {
  id: string;
  fromStateId: string;
  toStateId: string;
  duration: number; // Blending duration in seconds
  conditions: GraphCondition[];
}

export interface AnimationGraphData {
  variables: GraphVariable[];
  inputs: InputBinding[];
  states: GraphState[];
  transitions: GraphTransition[];
  activeStateId: string | null;
}

// ... (keep Level Blueprint Logic Types) ...

export type PinDataType = 'Exec' | 'Boolean' | 'Float' | 'Integer' | 'String' | 'Object';
export type PinDirection = 'Input' | 'Output';

export interface LogicPin {
    id: string;
    name: string;
    dataType: PinDataType;
    direction: PinDirection;
}

export interface LogicNode {
    id: string;
    type: 'Event' | 'Branch' | 'And' | 'Or' | 'Check' | 'VariableGet' | 'VariableSet' | 'PrintString' | 'DestroyActor' | 
          'Add' | 'Subtract' | 'Multiply' | 'Divide' | 'Greater' | 'Less' | 'Equal' | 
          'LiteralFloat' | 'LiteralInteger' | 'LiteralString' | 'LiteralBoolean' | 'ToString' | 
          'LevelAction';
    name: string;
    position: { x: number; y: number };
    inputs: LogicPin[];
    outputs: LogicPin[];
    data?: any; // For storing variable references, operator types, or static messages
}

export interface LogicConnection {
    id: string;
    fromNodeId: string;
    fromPinId: string;
    toNodeId: string;
    toPinId: string;
}

export interface LevelBlueprintData {
    nodes: LogicNode[];
    connections: LogicConnection[];
    variables: GraphVariable[]; // Local level variables
}

// ... (keep Blueprint Types) ...

export type BlueprintType = 'Player Character' | 'Enemy Controller';

export interface BlueprintStat {
  id: string;
  name: string;
  value: number;
}

export interface Blueprint {
  id: string;
  name: string;
  type: BlueprintType;
  description: string;
  linkedModelId: string | null; // ID of LoadedModelData
  textureId?: string | null; // ID of TextureData (Material Override)
  stats: BlueprintStat[];
  traits: string[];
  variables: GraphVariable[]; // Moved here
  animationGraph: AnimationGraphData; // Encapsulated graph logic
  meshScale: number; // Global uniform scale for the character mesh
  aimOffset?: [number, number, number]; // Scope camera offset calibration
  weaponSounds?: string[]; // Array of AudioAsset IDs
  weaponVolume?: number; // Base volume for weapon sounds
}

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
}

export interface DebugProjectile {
    trigger: number;
    origin: [number, number, number];
    direction: [number, number, number];
}

export interface Hitbox {
    center: THREE.Vector3; // World Space
    radius: number;
    height: number;
}

export interface Hittable {
    id: string;
    getHitbox: () => Hitbox;
    takeDamage: (amount: number, point: THREE.Vector3) => void;
    isDead: () => boolean;
    team: 'Player' | 'Enemy';
}

export interface SceneContextType {
  models: LoadedModelData[];
  attachments: AttachmentData[];
  sockets: SocketData[];
  selectedModelId: string | null;
  isLoading: boolean;

  // Project Actions
  saveProject: () => Promise<void>;
  saveProjectAs: () => Promise<void>;
  exportProject: () => Promise<void>;
  buildGame: (target?: 'web' | 'windows') => Promise<void>;
  importProject: () => Promise<void>;
  importLegacyProject: () => Promise<void>;
  migrateLegacyBrowserProject: () => Promise<number>;
  loadProject: () => Promise<void>;
  openRecentProject: (projectId: string) => Promise<void>;
  recoverProject: (recoveryId: string) => Promise<void>;
  closeProject: () => Promise<void>;
  createNewProject: () => Promise<void>;
  projectStatus: ProjectStatus;

  // Model Actions
  addModel: (file: File, category: AssetCategory) => Promise<void>;
  /** Import with explicit options; the settings are stored on the model document. */
  importModelWithOptions: (file: File, settings: ModelImportSettings, category?: AssetCategory) => Promise<void>;
  /** Replace a model's source file in place (id, references and settings are kept). */
  reimportModel: (modelId: string, file: File) => Promise<void>;
  /** Rename and/or move a model; rejects when the change cannot be saved. */
  updateModel: (id: string, updates: AssetInfoUpdate) => Promise<void>;
  removeModel: (id: string) => void;
  placeInScene: (id: string) => void; 
  removeFromScene: (id: string) => void; 
  selectModel: (id: string | null) => void;
  addAnimations: (files: File[], modelId: string) => Promise<void>;
  retextureModel: (modelId: string, textureUrl: string, targetTextureUuid?: string) => Promise<void>;
  previewTexture: (modelId: string, textureUrl: string, targetTextureUuid?: string) => Promise<void>;
  resetModelTexture: (modelId: string) => Promise<void>;

  // Texture Actions
  textures: TextureData[];
  addTexture: (file: File) => Promise<string | null>;
  saveTextureToLibrary: (base64: string, name: string) => Promise<string | null>;
  removeTexture: (id: string) => void;
  updateTexture: (id: string, updates: AssetInfoUpdate) => Promise<void>;

  // Audio Actions
  audioAssets: AudioData[];
  addAudio: (file: File) => Promise<string | null>;
  removeAudio: (id: string) => void;
  updateAudio: (id: string, updates: AssetInfoUpdate) => Promise<void>;

  // Attachment Actions
  addAttachment: (file: File, parentModelId: string) => Promise<void>;
  addAttachmentFromLibrary: (sourceModelId: string, parentModelId: string) => Promise<void>;
  updateAttachment: (id: string, updates: Partial<AttachmentData>) => void;
  removeAttachment: (id: string) => void;

  // Socket Actions
  addSocket: (parentModelId: string, name: string) => void;
  updateSocket: (id: string, updates: Partial<SocketData>) => void;
  removeSocket: (id: string) => void;
  triggerSocketFlash: (socketId: string) => void;
  flashTriggers: Record<string, number>;

  // Level / Environment Actions
  levels: LevelData[];
  currentLevelId: string | null;
  levelObjects: LevelObject[]; // Objects for the CURRENT level
  
  createLevel: (name: string) => Promise<void>;
  loadLevel: (id: string) => Promise<void>;
  deleteLevel: (id: string) => Promise<void>;
  
  addLevelObject: (
      modelId: string, 
      position: [number, number, number], 
      rotation: [number, number, number], 
      scale: [number, number, number],
      type?: LevelObjectType,
      extraData?: any // Terrain data or other configs
  ) => Promise<string | undefined>; // Updated return type
  /** Insert complete documents (ids, parents, components kept) as one undo step; resolves to the inserted ids. */
  addLevelObjects: (objects: LevelObject[]) => Promise<string[]>;
  
  /** Deletes the object and all of its descendants. */
  removeLevelObject: (id: string) => void;
  /** Deletes the objects and all of their descendants as one undo step. */
  removeLevelObjects: (ids: string[]) => void;
  updateLevelObject: (id: string, updates: Partial<LevelObject>) => void;
  
  // Level Blueprint Actions
  activeLevelBlueprint: LevelBlueprintData;
  updateLevelBlueprint: (data: Partial<LevelBlueprintData>) => void;

  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  snapshotHistory: () => void;

  // Graph Actions
  graphData: Record<string, AnimationGraphData>;
  updateGraph: (modelId: string, data: Partial<AnimationGraphData>) => void;
  resetGraphs: () => void;

  // Blueprint Actions
  blueprints: Blueprint[];
  isCreatingPlayerBlueprint: boolean;
  selectedBlueprintId: string | null;
  selectBlueprint: (id: string | null) => void;
  addBlueprint: (type: BlueprintType) => Promise<void>;
  updateBlueprint: (id: string, updates: Partial<Blueprint>) => void;
  removeBlueprint: (id: string) => void;
  setBlueprints: (blueprints: Blueprint[]) => void;
  
  // Runtime Triggers
  characterFireTriggers: Record<string, number>;
  triggerCharacterFire: (modelId: string) => void;

  // Camera Actions
  cameraState: CameraState;
  setCameraState: React.Dispatch<React.SetStateAction<CameraState>>;

  // Debug Actions
  debugProjectile: DebugProjectile;
  triggerDebugProjectile: (origin: [number, number, number], direction: [number, number, number]) => void;
}
