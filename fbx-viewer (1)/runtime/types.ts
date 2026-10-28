import type { MutableRefObject, ReactNode } from 'react';
import type { RuntimeInspector } from './PauseController';
import type {
    AttachmentData, AudioData, Blueprint, LevelBlueprintData, LevelData, LevelObject,
    LoadedModelData, PrefabData, SocketData, TextureData,
} from '../types';
import type { PlayerOptionsStore } from './playerOptions';
import { DEFAULT_NETWORK_SETTINGS, normalizeNetworkSettings, type NetworkSettings } from './net/protocol';
import type { SavedWeapons } from './weapons';

/** Everything the gameplay runtime needs from loaded content, whether it came from the editor or a game pack. */
export interface GameContent {
    models: LoadedModelData[];
    blueprints: Blueprint[];
    attachments: AttachmentData[];
    sockets: SocketData[];
    textures: TextureData[];
    audioAssets: AudioData[];
    /** Prefab documents that Spawn Prefab can instantiate during play. */
    prefabs?: PrefabData[];
    /** Every level's objects by level id, for Level Streaming volumes. */
    levelObjects?: Readonly<Record<string, LevelObject[]>>;
}

/** One playable level: its objects (already filtered to this level) and its level blueprint. */
export interface RuntimeLevel {
    id: string;
    name: string;
    objects: LevelObject[];
    blueprint: LevelBlueprintData;
}

export interface PlayerStart {
    position: [number, number, number];
    rotation: [number, number, number];
}

/** Stored in the project 'metadata' domain as the document { id: GAME_SETTINGS_DOCUMENT_ID, settings }. */
export interface GameSettings {
    schema: 1;
    name: string;
    startupLevelId: string | null;
    playerBlueprintId: string | null;
    window: { fullscreen: boolean };
    /**
     * meshLod: meshes draw simpler levels of themselves as they get smaller on the screen (utils/meshLod.ts).
     * textureCompression: colour and material maps load GPU-compressed (utils/textureCompression).
     */
    quality: { shadows: boolean; postProcessing: boolean; maxDpr: number; fov: number; meshLod: boolean; textureCompression: boolean };
    input: { mouseSensitivity: number; invertY: boolean };
    audio: { masterVolume: number };
    /** Multiplayer through a relay server (runtime/net/protocol.ts). */
    network: NetworkSettings;
}

export const GAME_SETTINGS_DOCUMENT_ID = 'game-settings';

export const DEFAULT_GAME_SETTINGS: GameSettings = {
    schema: 1,
    name: 'Untitled Game',
    startupLevelId: null,
    playerBlueprintId: null,
    window: { fullscreen: false },
    quality: { shadows: true, postProcessing: true, maxDpr: 2, fov: 60, meshLod: true, textureCompression: true },
    input: { mouseSensitivity: 0.002, invertY: false },
    audio: { masterVolume: 1 },
    network: DEFAULT_NETWORK_SETTINGS,
};

/** Merges a stored (possibly partial or older) settings object over the defaults. */
export const normalizeGameSettings = (value: unknown): GameSettings => {
    const stored = (value && typeof value === 'object' ? value : {}) as Partial<GameSettings>;
    return {
        ...DEFAULT_GAME_SETTINGS,
        ...stored,
        schema: 1,
        window: { ...DEFAULT_GAME_SETTINGS.window, ...(stored.window ?? {}) },
        quality: { ...DEFAULT_GAME_SETTINGS.quality, ...(stored.quality ?? {}) },
        input: { ...DEFAULT_GAME_SETTINGS.input, ...(stored.input ?? {}) },
        audio: { ...DEFAULT_GAME_SETTINGS.audio, ...(stored.audio ?? {}) },
        network: normalizeNetworkSettings(stored.network),
    };
};

/** What the level runtime asks of whoever hosts it: play-in-editor or the standalone player. */
export interface RuntimeHost {
    print(message: string, type?: 'info' | 'success' | 'warning' | 'error'): void;
    restartLevel(): void;
    endLevel(): void;
    openLevel(levelId: string): void;
    saveGame(slot?: string): void;
    loadGame(slot?: string): void;
    requestPause(): void;
}

export interface LevelRuntimeProps {
    level: RuntimeLevel;
    settings: GameSettings;
    /** null falls back to the level's player_start object, then the origin. */
    playerStart: PlayerStart | null;
    paused: boolean;
    host: RuntimeHost;
    /** Changing this starts a fresh session of the same level (restart or load). */
    sessionKey: number;
    /** Rendered above the canvas, e.g. the authored HUD. */
    overlay?: ReactNode;
    /** Applied to the session after it starts (load game). */
    restore?: SaveGameData | null;
    /** The player's saved options (sensitivity, volumes, bindings); without one the game settings' defaults apply. */
    playerOptions?: PlayerOptionsStore;
    /** While paused, each change runs exactly one frame (play-in-editor's Step). */
    stepRequest?: number;
    /** Filled with a reader of the running scene's level objects (play-in-editor's inspector). */
    inspectRef?: MutableRefObject<RuntimeInspector | null>;
    /** Filled with a reader of what a save records of the running session (the built game's Save). */
    saveStateRef?: MutableRefObject<(() => RuntimeSaveState | null) | null>;
}

/** What a running session puts in a save: where the player stands and which authored objects are gone. */
export interface RuntimeSaveState {
    position: [number, number, number];
    rotation: [number, number, number];
    destroyedObjectIds: string[];
    /** The player's weapons: which are carried, which is held and the rounds left. */
    weapons?: SavedWeapons;
}

/** A saved play session: loading it starts the level with the player where they were and destroyed actors gone. */
export interface SaveGameData {
    schema: 1;
    gameId: string;
    slot: string;
    savedAt: string;
    levelId: string;
    player: {
        position: [number, number, number];
        rotation: [number, number, number];
        health: number;
        stamina: number;
        /** Saves made before weapons were saved have none; loading one starts with fresh magazines. */
        weapons?: SavedWeapons;
    };
    destroyedObjectIds: string[];
    variables: Record<string, number | boolean | string>;
}

/** Game pack written by Build Game. Layout: game/game.json, game/content/<domain>.json, game/assets/<file>. */
export const GAME_PACK_FORMAT = 'auvra.game';

export interface GamePackManifest {
    format: typeof GAME_PACK_FORMAT;
    schema: 1;
    gameId: string;
    name: string;
    buildId: string;
    startupLevelId: string;
    settings: GameSettings;
    levels: { id: string; name: string }[];
    /** Domain names present under game/content/<domain>.json ({ schemaVersion, documents }). */
    domains: string[];
    /** Every shipped asset: id is the project asset id, file is relative to game/assets/. */
    assets: { id: string; file: string; mime: string; size: number }[];
}

/** A document in the project 'hud' domain: the game HUD ('hud-main') or an authored menu ('menu-title', 'menu-pause'). */
export interface HUDDocumentData {
    id: string;
    name?: string;
    elements: unknown[];
    layout?: { width: number; height: number };
}

/** Result of loading a project snapshot or game pack into runtime-ready content. */
export interface LoadedGameContent {
    content: GameContent;
    levels: LevelData[];
    objects: LevelObject[];
    hud: HUDDocumentData | null;
    /** Every usable document in the 'hud' domain, including authored menus. */
    hudDocuments?: HUDDocumentData[];
    settings: GameSettings;
}
