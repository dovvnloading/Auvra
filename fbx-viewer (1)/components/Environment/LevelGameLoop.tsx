import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useScene } from '../../context/SceneContext';
import { useNotification } from '../../context/NotificationContext';
import { useNativeProjectDocument } from '../../utils/useNativeProjectDocument';
import { LevelRuntime } from '../../runtime/LevelRuntime';
import { GameContentProvider, useGameContent } from '../../runtime/GameContentContext';
import { projectService } from '../../utils/projectService';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import type { PrefabData } from '../../types';
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

/**
 * PLAY IN EDITOR
 *
 * Thin shell over the shared level runtime: plays the level open in the editor with the project's
 * game settings, and returns to the editor when the level ends or Escape is pressed.
 */
export const LevelGameLoop: React.FC<LevelGameLoopProps> = ({ onExit, spawnPosition }) => {
    const { levelObjects, activeLevelBlueprint, levels, currentLevelId } = useScene();
    const { addNotification } = useNotification();
    const { document: settingsDocument, hydrated: settingsHydrated } = useNativeProjectDocument<GameSettingsDocument>(
        'metadata', GAME_SETTINGS_DOCUMENT_ID, createDefaultGameSettingsDocument,
    );
    const settings = useMemo(() => normalizeGameSettings(settingsDocument.settings), [settingsDocument]);
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
    const playContent = useMemo(() => ({ ...content, prefabs: prefabs ?? [] }), [content, prefabs]);
    const [sessionKey, setSessionKey] = useState(0);

    const level = useMemo<RuntimeLevel>(() => ({
        id: currentLevelId ?? 'editor-level',
        name: levels.find(l => l.id === currentLevelId)?.name ?? 'Untitled Level',
        objects: levelObjects,
        blueprint: activeLevelBlueprint,
    }), [activeLevelBlueprint, currentLevelId, levelObjects, levels]);

    // Play starts where the editor camera is, on the ground.
    const playerStart = useMemo<PlayerStart | null>(() => (
        spawnPosition ? { position: [spawnPosition.x, 0.5, spawnPosition.z], rotation: [0, 0, 0] } : null
    ), [spawnPosition]);

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
            restartLevel: () => setSessionKey(key => key + 1),
            endLevel: () => exitRef.current(),
            // Play-in-editor plays only the level open in the editor.
            openLevel: () => print('OpenLevel is available in the built game', 'warning'),
            saveGame: () => print('Save Game is available in the built game'),
            loadGame: () => print('Load Game is available in the built game'),
            // Escape returns to the editor, as it always has in play-in-editor.
            requestPause: () => exitRef.current(),
        };
    }, []);

    // Each play-in-editor run starts from a clean game state.
    useEffect(() => () => gameState.reset(), []);

    if (!settingsHydrated || prefabs === null) {
        return <div className="flex items-center justify-center h-full w-full bg-black text-xs text-gray-500">Starting play session...</div>;
    }

    return (
        <GameContentProvider value={playContent}>
            <LevelRuntime
                level={level}
                settings={settings}
                playerStart={playerStart}
                paused={false}
                host={host}
                sessionKey={sessionKey}
            />
        </GameContentProvider>
    );
};
