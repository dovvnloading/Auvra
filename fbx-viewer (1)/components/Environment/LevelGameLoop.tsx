import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useScene } from '../../context/SceneContext';
import { useNotification } from '../../context/NotificationContext';
import { useNativeProjectDocument } from '../../utils/useNativeProjectDocument';
import { LevelRuntime } from '../../runtime/LevelRuntime';
import { gameState } from '../../runtime/gameState';
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

    if (!settingsHydrated) {
        return <div className="flex items-center justify-center h-full w-full bg-black text-xs text-gray-500">Starting play session...</div>;
    }

    return (
        <LevelRuntime
            level={level}
            settings={settings}
            playerStart={playerStart}
            paused={false}
            host={host}
            sessionKey={sessionKey}
        />
    );
};
