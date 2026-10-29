
// ... existing imports ...
import * as THREE from 'three';
import React from 'react';
import type { ProjectStatus } from './utils/projectStatus';
import type { MaterialOverrides } from './utils/materialOverrides';
import type { LevelBakedLighting } from './runtime/lighting/bakedLighting';

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
  /** Clips that also play mirrored (left and right swapped), as `<name> (Mirrored)`; rebuilt on load. */
  mirroredClips?: string[];
  /** Per-material colour/PBR/texture overrides, keyed by material name (see utils/materialOverrides). */
  materialOverrides?: MaterialOverrides;
  folder?: string; // Content browser folder path, e.g. 'Characters/Enemies'
  importSettings?: ModelImportSettings;
  /** Names of the clips in the model's own file, as stored with its document (they survive renaming the model). */
  sourceClipNames?: string[];
  /** On import: textures the source file names but does not contain, which it was imported without. */
  missingTextures?: number;
}

export type LevelObjectType = 'prop' | 'foliage' | 'spawn_point' | 'audio_emitter' | 'terrain' | 'sky_sphere' | 'player_start';

export interface SpawnConfig {
    blueprintId: string; // ID of the Enemy Blueprint to spawn
    interval: number;    // Seconds between spawns
    maxSpawns: number;   // Total limit (0 = infinite)
    team: 'Enemy' | 'Player';
    patrolPath?: string; // Object with a Spline component its enemies patrol along (empty: they wander)
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

/** Project reference to a terrain splat map (per-sample RGBA layer weights) stored as a binary content-addressed asset. */
export interface TerrainSplatmapReference {
    assetId: string;   // SHA-256 of the encoded splat map asset
    encoding: 'rgba8'; // 16-byte header ("AUVRASP1", uint32 columns, uint32 rows), then row-major RGBA8 weights
    columns: number;   // resolution + 1
    rows: number;      // resolution + 1
}

/** One terrain texture layer; splat channel N (R, G, B, A) weights layer N. */
export interface TerrainTextureLayer {
    textureId?: string; // textures domain id; a layer without one renders flat grey
    tiling: number;     // texture repeats across the terrain width
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
    textureLayers?: TerrainTextureLayer[]; // at most 4, blended by the splat map
    // Flattened (resolution + 1)^2 * 4 RGBA weights (0-255, heights order). In memory these are
    // resolved from `splatmap`; persisted documents carry only the reference.
    splat?: number[];
    splatmap?: TerrainSplatmapReference;
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
  /** Baked light probes and their settings (see runtime/lighting/bakedLighting.ts). */
  bakedLighting?: LevelBakedLighting;
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
  /** Prefab this object belongs to an instance of (utils/prefabSync.ts keeps instances in step with it). */
  prefabId?: string;
  /** The prefab object this object was made from; the one matching the prefab's rootId heads the instance. */
  prefabObjectId?: string;
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

/** Conduit: a junction with no animation; entering it goes straight on through one of its own transitions. */
export type StateType = 'Single' | 'Blend1D' | 'Blend2D' | 'StateMachine' | 'Conduit';

/** The states and transitions inside a State Machine state; its root state is where it is entered. */
export interface SubStateMachine {
  states: GraphState[];
  transitions: GraphTransition[];
}

export interface BlendSample {
    id: string;
    clipName: string;
    position: [number, number]; // [x, y]; a Blend1D state reads only x
}

/** A named event at a point in a state's clip, raised each time playback crosses it. */
export interface AnimNotify {
    id: string;
    name: string;
    /** Seconds from the start of the clip. */
    time: number;
}

/** A point on an animation curve: a value at a time in the state's clip. */
export interface AnimCurveKey {
    /** Seconds from the start of the clip. */
    time: number;
    value: number;
}

/** A value keyed over a state's clip that drives a graph variable while the state plays. */
export interface AnimCurve {
    id: string;
    variableId: string;
    keys: AnimCurveKey[];
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
  blendParamY: string; // Variable ID (unused by Blend1D)

  /** Playback speed multiplier; default 1. Negative plays the clip backwards. */
  playRate?: number;
  /** Variable ID whose value multiplies playRate each frame (e.g. a signed forward speed); unset leaves playRate alone. */
  playRateParam?: string;
  /**
   * Play the state's clips at the rate that carries the character at the speed it is really moving
   * over the ground (each clip's own speed is read from its feet), so planted feet do not slide.
   * Ignored with root motion, where the clip moves the character itself.
   */
  matchSpeed?: boolean;
  /** Events raised when playback crosses a time in the state's clip (Single states). */
  notifies?: AnimNotify[];
  /** Move the character by the clip's root-bone travel instead of leaving it in the pose. */
  rootMotion?: boolean;
  /** States with the same group keep their phase across a transition (a run starts mid-stride where the walk was). */
  syncGroup?: string;
  /** A State Machine state's own states and transitions. */
  subGraph?: SubStateMachine;
  /** Values keyed over the clip, written into graph variables each frame the state plays (Single states). */
  curves?: AnimCurve[];
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
  /** Fraction (0..1) of the source state's clip after which the transition may fire. */
  exitTime?: number;
  /** 'all' (default): every condition must hold; 'any': one is enough. */
  conditionMode?: 'all' | 'any';
  /** Fires from every state except its target (fromStateId is ignored). */
  anyState?: boolean;
  /** Higher fires first when several transitions are ready; default 0, ties keep list order. */
  priority?: number;
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
          'LevelAction' |
          // Flow control (hooks/levelBlueprintNodes/flow.ts)
          'Sequence' | 'ForLoop' | 'Delay' | 'DoOnce' | 'FlipFlop' | 'Gate' |
          // World (hooks/levelBlueprintNodes/world.ts)
          'SpawnPrefab' | 'GetActorTransform' | 'SetActorTransform' | 'PlaySound' | 'MakeNoise' | 'ApplyImpulse' | 'Raycast' |
          'GetLevelVariable' | 'SetLevelVariable' | 'InputActionPressed' | 'RandomFloat' | 'RandomInt' | 'Print' |
          // Animation (hooks/levelBlueprintNodes/world.ts)
          'PlayPlayerAnimation' | 'SetMorphTarget' |
          // Player (hooks/levelBlueprintNodes/world.ts)
          'DamagePlayer' | 'HealPlayer' | 'AddAmmo' | 'GiveWeapon' | 'GetPlayerHealth' |
          // Splines (hooks/levelBlueprintNodes/world.ts)
          'GetSplineLength' | 'GetSplinePoint' | 'FindClosestOnSpline' |
          // Vehicles (hooks/levelBlueprintNodes/world.ts)
          'EnterVehicle' | 'ExitVehicle' | 'GetVehicleState' | 'GetPlayerVehicle' | 'SetVehicleInput' | 'ReleaseVehicleInput' |
          // Multiplayer (hooks/useLevelBlueprintRuntime.ts)
          'SendNetworkEvent' | 'IsNetworkHost' |
          // Cameras (hooks/useLevelBlueprintRuntime.ts)
          'SetActiveCamera' |
          // Dialogue (hooks/useLevelBlueprintRuntime.ts)
          'StartDialogue';
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

/** A variable declared in a level blueprint; each play session starts it at `value`. */
export interface LevelVariable {
    id: string;
    name: string;
    type: VariableType | 'String';
    value: number | boolean | string;
}

export interface LevelBlueprintData {
    nodes: LogicNode[];
    connections: LogicConnection[];
    variables: LevelVariable[]; // Local level variables
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
  aimOffset?: [number, number, number]; // Aim camera offset calibration (see aimCameraOffset)
  /** How the player aims (default 'scope'): see AimView. */
  aimView?: AimView;
  weaponSounds?: string[]; // Array of AudioAsset IDs
  weaponVolume?: number; // Base volume for weapon sounds
  /** Pose fixes applied after the animation graph each frame (runtime/ik.ts). */
  ik?: CharacterIKSettings;
  /** A player's fire and aim clips, layered over its locomotion. */
  upperBody?: UpperBodySettings;
  /** Added on top of whatever the character is doing each time it is hurt (not by the hit that kills it). */
  hitReactClip?: string | null;
  /**
   * How much of the hit reaction the upper body takes while the character's weapon is held ready
   * (aimed, firing or just fired), 0 to 1 (default 0.2): the body still flinches, the weapon stays on target.
   */
  hitReactAimed?: number;
  /** A player's weapons, held one at a time (runtime/weapons.ts); without any it fires a default weapon. */
  weapons?: WeaponSettings[];
  /** An enemy's authored behavior (runtime/behaviorTree.ts); without one it uses the built-in AI. */
  behaviorTree?: BehaviorTreeData;
}

/** Composite nodes run their children in order; decorators wrap one child; leaves test or act. */
export type BehaviorNodeType = 'selector' | 'sequence' | 'inverter' | 'succeeder' | 'cooldown' | 'condition' | 'action';

export type BehaviorCondition = 'canSeePlayer' | 'remembersPlayer' | 'playerWithin' | 'healthBelow' | 'chance' | 'variableTrue';

export type BehaviorAction = 'chase' | 'attack' | 'shoot' | 'strafe' | 'search' | 'patrol' | 'wait' | 'moveTo' | 'flee' | 'returnHome' | 'setVariable' | 'playAnimation';

export interface BehaviorNode {
  id: string;
  type: BehaviorNodeType;
  /** Child ids, in order (composites any number, decorators one). */
  children?: string[];
  condition?: BehaviorCondition;
  action?: BehaviorAction;
  /** Distance (m), seconds, percent or chance (0..1), by condition or action. */
  value?: number;
  /** A graph variable, an object id or a clip name, by condition or action. */
  text?: string;
}

export interface BehaviorTreeData {
  rootId: string;
  behaviorNodes: BehaviorNode[];
}

export interface CharacterIKSettings {
  /** Plant each foot on the ground under it (needs colliders or terrain). */
  footIK?: boolean;
  /** Highest ground step a foot reaches for, in metres (default 0.5). */
  footMaxStep?: number;
  /** Turn a bone toward a target: the camera (players) or the player (enemies). */
  lookAt?: 'none' | 'camera' | 'player';
  /** Bone that looks (default 'Head'). */
  lookAtBone?: string;
  /** Largest turn away from the animated pose, in degrees (default 70). */
  lookAtMaxAngle?: number;
  /** While aiming, the spine leans up and down with the camera, so the arms follow the aim. */
  aimPitch?: boolean;
}

/** Where a weapon's model sits while it is not in use: on a bone, offset as attachments are (degrees). */
export interface WeaponCarry {
  boneName: string;
  position: [number, number, number];
  rotation: [number, number, number];
}

/** One of a player's weapons. Missing numbers take runtime/weapons.ts DEFAULT_WEAPON's. */
export interface WeaponSettings {
  id: string;
  name: string;
  /** The model attachment shown while this weapon is held; the other weapons' are hidden. */
  attachmentId?: string | null;
  /** Name of the socket its shots leave from (and flash at); the first Muzzle socket when unset. */
  muzzleSocket?: string | null;
  /** 'auto' fires while Fire is held, 'semi' once per press. */
  fireMode?: 'auto' | 'semi';
  /** Shots per second. */
  fireRate?: number;
  /** Damage per projectile. */
  damage?: number;
  /** Rounds per magazine; 0 never needs reloading. */
  magazine?: number;
  /** Rounds carried besides the magazine; -1 is unlimited. */
  reserve?: number;
  reloadSeconds?: number;
  /** Largest random angle a shot strays from the aim, in degrees (a quarter of it while aiming). */
  spread?: number;
  /** Projectiles per shot, as from a shotgun. */
  pellets?: number;
  /** World units per second. */
  projectileSpeed?: number;
  /** Carried from the start (default); otherwise the player gets it from a pickup, a Give Weapon node or a script. */
  startsOwned?: boolean;
  /**
   * Where its model goes while the player is not aiming, firing or reloading it, and while another
   * weapon is held: slung on the back, holstered at the hip. Without one it stays in the hand while
   * held and is hidden while another is.
   */
  carry?: WeaponCarry | null;
  /**
   * How the character moves while holding it (a rifle's or a pistol's animation set): each stands in
   * for the animation graph's own idle, walk, run, walking-backward and jump clips while this weapon
   * is held, and a weapon with them stays in the hands. Unset ones leave the graph's clip.
   */
  idleClip?: string | null;
  walkClip?: string | null;
  runClip?: string | null;
  backClip?: string | null;
  /** Stepping sideways while held (a 2D blend's side samples); the weapon's walk when unset. */
  leftClip?: string | null;
  rightClip?: string | null;
  jumpClip?: string | null;
  /**
   * Turning in place while aimed, left and right: played on the legs (the hips without the spine)
   * when the aim swings too far from where the feet point, the character turning as the clip turns.
   */
  turnLeftClip?: string | null;
  turnRightClip?: string | null;
  /**
   * Where the other hand holds it (a rifle's handguard), in the weapon model's own units: while it is
   * held, that hand takes hold there from wherever the animation has it, except while reloading.
   */
  supportGrip?: [number, number, number] | null;
  /**
   * How the other hand is turned on the weapon, in degrees in the weapon model's frame: recorded by
   * Fit from the weapon's own clip, so the hand holds the weapon the same way in every clip (a jump,
   * a fall). Without it the hand keeps the clip's rotation.
   */
  supportRotation?: [number, number, number] | null;
  /** The middle of the grip the gripping hand closes round, in the weapon model's own units (Fit to the hands). */
  gripPoint?: [number, number, number] | null;
  /** The end of the barrel, in the weapon model's own units: a one-handed weapon is fitted pointing it ahead. */
  muzzlePoint?: [number, number, number] | null;
/** Upper-body clips while firing, aiming and reloading this weapon; the blueprint's Upper Body clips when unset. */
  fireClip?: string | null;
  aimClip?: string | null;
  reloadClip?: string | null;
}

/** Where the camera aims from: the character's eyes, hiding it (`scope`), or over its shoulder with it in view. */
export type AimView = 'scope' | 'shoulder';

/** The aim camera's offset from the character (right, height, back toward the camera), per view. */
export const DEFAULT_AIM_OFFSETS: Record<AimView, [number, number, number]> = {
  scope: [0.5, 4.5, 1.0],
  shoulder: [1.6, 4.6, -3.4],
};

/** The aim camera offset a blueprint uses: its own, or its aim view's default. */
export const aimCameraOffset = (blueprint: Pick<Blueprint, 'aimOffset' | 'aimView'>): [number, number, number] =>
  blueprint.aimOffset ?? DEFAULT_AIM_OFFSETS[blueprint.aimView ?? 'scope'];

/** The bone upper-body clips play from when a blueprint names none. */
export const DEFAULT_UPPER_BODY_BONE = 'Spine';

/** Clips a player character plays on its upper body, over whatever its legs are doing. */
export interface UpperBodySettings {
  /** Looped while the fire button is held. */
  fireClip?: string | null;
  /** Looped while aiming and not firing. */
  aimClip?: string | null;
  /** The bone the clips play from: it and everything below it in the skeleton (default 'Spine'). */
  maskBone?: string;
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
    /** False while the character cannot be hit: hidden, as while riding in a vehicle. Absent: always. */
    isHittable?: () => boolean;
}

/** Host project template ids accepted by project.create (protocol/v1 projectCreatePayload.template). */
export type ProjectTemplate = 'blank' | 'starter' | 'arena' | 'courtyard' | 'outpost';

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
  createNewProject: (template?: ProjectTemplate) => Promise<void>;
  projectStatus: ProjectStatus;

  // Model Actions
  addModel: (file: File, category: AssetCategory) => Promise<void>;
  /** Import with explicit options; the settings are stored on the model document. */
  importModelWithOptions: (file: File, settings: ModelImportSettings, category?: AssetCategory) => Promise<void>;
  /**
   * Replace a model's source file in place (id, references and settings are kept), or without a
   * file read its stored source again; `settings` replaces its import settings (its size).
   */
  reimportModel: (modelId: string, file?: File | null, settings?: ModelImportSettings) => Promise<void>;
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
  /** Persist a model's material overrides and apply them to its loaded object; rejects when they cannot be saved. */
  updateModelMaterialOverrides: (modelId: string, overrides: MaterialOverrides) => Promise<void>;
  /** Adds a mirrored copy (left and right swapped) of one of a model's clips. */
  mirrorClip: (modelId: string, clipName: string) => Promise<void>;

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
