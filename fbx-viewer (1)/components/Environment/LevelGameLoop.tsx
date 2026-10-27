import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useScene } from '../../context/SceneContext';
import { useNotification } from '../../context/NotificationContext';
import { useNativeProjectDocument } from '../../utils/useNativeProjectDocument';
import { HUD_DOCUMENT_ID } from '../../utils/projectHydration';
import { HUDRenderer } from '../HUDEditor/HUDRenderer';
import type { HUDDocumentData } from '../../runtime/types';
import { LevelRuntime } from '../../runtime/LevelRuntime';
import type { RuntimeInspector } from '../../runtime/PauseController';
import { PlayToolbar } from './PlayToolbar';
import { GameContentProvider, useGameContent } from '../../runtime/GameContentContext';
import { projectService } from '../../utils/projectService';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import type { LevelObject, PrefabData } from '../../types';
import { objectsByLevel } from '../../runtime/levelStreaming';
import { gameState } from '../../runtime/gameState';
import { createDefaultLocalizationDocument, localization, LOCALIZATION_DOCUMENT_ID, type LocalizationDocument } from '../../runtime/localization';
import {
    DEFAULT_GAME_SETTINGS,
    GAME_SETTINGS_DOCUMENT_ID,
    GameSettings,
    normalizeGameSettings,
    PlayerStart,
    RuntimeHost,
    RuntimeLevel,
} from '../../runtime/types';

interface LevelGameLoopProps {
    onExit: () => void;
    spawnPosition?: THREE.Vector3;
    /** Start at `spawnPosition` even when the level has a Player Start ("Play from here"). */
    fromCamera?: boolean;
}

interface GameSettingsDocument {
    id: string;
    settings: GameSettings;
}

// Module scoped so the document hook sees a stable factory.
const createDefaultGameSettingsDocument = (): GameSettingsDocument => ({
    id: GAME_SETTINGS_DOCUMENT_ID,
    settings: DEFAULT_GAME_SETTINGS,
});

const createEmptyHud = (): HUDDocumentData => ({ id: HUD_DOCUMENT_ID, elements: [] });

/**
 * PLAY IN EDITOR
 *
 * Thin shell over the shared level runtime: plays the level open in the editor with the project's
 * game settings. Escape pauses; while paused the play toolbar resumes, steps one frame, restarts,
 * inspects the running objects or stops and returns to the editor (Escape again).
 */
export const LevelGameLoop: React.FC<LevelGameLoopProps> = ({ onExit, spawnPosition, fromCamera = false }) => {
    const { levelObjects, activeLevelBlueprint, levels, currentLevelId } = useScene();
    const { addNotification } = useNotification();
    const { document: settingsDocument, hydrated: settingsHydrated } = useNativeProjectDocument<GameSettingsDocument>(
        'metadata', GAME_SETTINGS_DOCUMENT_ID, createDefaultGameSettingsDocument,
    );
    const settings = useMemo(() => normalizeGameSettings(settingsDocument.settings), [settingsDocument]);
    // The game HUD the built game shows; with no elements the runtime's own HUD stands in, as in the player.
    const { document: hudDocument } = useNativeProjectDocument<HUDDocumentData>('hud', HUD_DOCUMENT_ID, createEmptyHud);
    const hudOverlay = useMemo(() => (
        Array.isArray(hudDocument.elements) && hudDocument.elements.length > 0 ? <HUDRenderer document={hudDocument} bindings /> : undefined
    ), [hudDocument]);
    const { document: localizationDocument } = useNativeProjectDocument<LocalizationDocument>(
        'metadata', LOCALIZATION_DOCUMENT_ID, createDefaultLocalizationDocument,
    );
    useEffect(() => {
        localization.load(localizationDocument.settings);
    }, [localizationDocument]);

    // Spawn Prefab needs the project's prefabs; they cannot change while a session runs.
    const content = useGameContent();
    const [prefabs, setPrefabs] = useState<PrefabData[] | null>(null);
    useEffect(() => {
        let current = true;
        // Read-only snapshot: play never writes to the project.
        const read = projectService.getStatus().projectId
            ? projectService.getSnapshotAll('prefabs').then(snapshot => {
                const raw = snapshot?.domains?.prefabs as unknown;
                const records = Array.isArray(raw) ? raw : (raw as { documents?: unknown[] } | undefined)?.documents ?? [];
                return records.filter((doc): doc is PrefabData => typeof (doc as PrefabData | null)?.id === 'string');
            })
            : Promise.resolve<PrefabData[]>([]);
        read.then(
            list => { if (current) setPrefabs(list); },
            error => {
                frontendDiagnostics.failure('play_prefabs_load_failed', error);
                if (current) setPrefabs([]);
            },
        );
        return () => { current = false; };
    }, []);
    // Level Streaming volumes load other levels' objects: a read-only snapshot taken when play starts.
    const [otherLevels, setOtherLevels] = useState<Record<string, LevelObject[]>>({});
    useEffect(() => {
        let current = true;
        if (!projectService.getStatus().projectId) return undefined;
        projectService.getSnapshotAll('objects').then(snapshot => {
            const raw = snapshot?.domains?.objects as unknown;
            const records = Array.isArray(raw) ? raw : (raw as { documents?: unknown[] } | undefined)?.documents ?? [];
            const objects = records.filter((doc): doc is LevelObject => typeof (doc as LevelObject | null)?.id === 'string' && typeof (doc as LevelObject).levelId === 'string');
            if (current) setOtherLevels(objectsByLevel(objects));
        }, error => frontendDiagnostics.failure('play_level_objects_load_failed', error));
        return () => { current = false; };
    }, []);
    const playContent = useMemo(() => ({ ...content, prefabs: prefabs ?? [], levelObjects: otherLevels }), [content, prefabs, otherLevels]);
    const [sessionKey, setSessionKey] = useState(0);
    const [paused, setPaused] = useState(false);
    const [stepRequest, setStepRequest] = useState(0);
    const inspectRef = useRef<RuntimeInspector | null>(null);
    const objectNames = useMemo(() => new Map(levelObjects.map(object => [object.id, object.name] as const)), [levelObjects]);
    const resume = useCallback(() => setPaused(false), []);
    const step = useCallback(() => setStepRequest(request => request + 1), []);
    const restart = useCallback(() => {
        setSessionKey(key => key + 1);
        setPaused(false);
    }, []);
    const stop = useCallback(() => exitRef.current(), []);
    const inspect = useCallback(() => inspectRef.current, []);

    const level = useMemo<RuntimeLevel>(() => ({
        id: currentLevelId ?? 'editor-level',
        name: levels.find(l => l.id === currentLevelId)?.name ?? 'Untitled Level',
        objects: levelObjects,
        blueprint: activeLevelBlueprint,
    }), [activeLevelBlueprint, currentLevelId, levelObjects, levels]);

    // Play starts at the level's Player Start (null lets the runtime use it). "Play from here", or a
    // level without one, starts under the editor camera, on the ground.
    const hasPlayerStart = levelObjects.some(object => object.type === 'player_start');
    const playerStart = useMemo<PlayerStart | null>(() => (
        spawnPosition && (fromCamera || !hasPlayerStart)
            ? { position: [spawnPosition.x, 0.5, spawnPosition.z], rotation: [0, 0, 0] }
            : null
    ), [spawnPosition, fromCamera, hasPlayerStart]);

    const exitRef = useRef(onExit);
    const notifyRef = useRef(addNotification);
    useLayoutEffect(() => {
        exitRef.current = onExit;
        notifyRef.current = addNotification;
    }, [onExit, addNotification]);

    const host = useMemo<RuntimeHost>(() => {
        const print: RuntimeHost['print'] = (message, type = 'info') => {
            notifyRef.current({ message, type: type === 'warning' ? 'info' : type });
        };
        return {
            print,
            restartLevel: () => {
                setSessionKey(key => key + 1);
                setPaused(false);
            },
            endLevel: () => exitRef.current(),
            // Play-in-editor plays only the level open in the editor.
            openLevel: () => print('OpenLevel is available in the built game', 'warning'),
            saveGame: () => print('Save Game is available in the built game'),
            loadGame: () => print('Load Game is available in the built game'),
            // Escape (or losing the pointer) pauses; the toolbar then offers step, inspect and stop.
            requestPause: () => setPaused(true),
        };
    }, []);

    // Each play-in-editor run starts from a clean game state.
    useEffect(() => () => gameState.reset(), []);

    if (!settingsHydrated || prefabs === null) {
        return <div className="flex items-center justify-center h-full w-full bg-black text-xs text-gray-500">Starting play session...</div>;
    }

    return (
        <GameContentProvider value={playContent}>
            <div className="relative w-full h-full">
                <LevelRuntime
                    level={level}
                    settings={settings}
                    playerStart={playerStart}
                    paused={paused}
                    host={host}
                    sessionKey={sessionKey}
                    stepRequest={stepRequest}
                    inspectRef={inspectRef}
                    overlay={hudOverlay}
                />
                <PlayToolbar
                    paused={paused}
                    onResume={resume}
                    onStep={step}
                    onRestart={restart}
                    onStop={stop}
                    inspect={inspect}
                    objectNames={objectNames}
                    frame={stepRequest}
                />
            </div>
        </GameContentProvider>
    );
};
