import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameContentProvider } from '../runtime/GameContentContext';
import { LevelRuntime } from '../runtime/LevelRuntime';
import { createSaveGameStore } from '../runtime/saveGame';
import { gameState, useGameState } from '../runtime/gameState';
import type { LoadedGameContent, PlayerStart, RuntimeHost, RuntimeLevel, SaveGameData } from '../runtime/types';
import { loadGameContent } from '../utils/projectHydration';
import { HUDRenderer } from '../components/HUDEditor/HUDRenderer';
import { loadGamePack, type GamePackSource } from './gamePack';
import { OptionsMenu } from './OptionsMenu';
import {
    AuthoredMenu,
    findMenuDocument,
    menuActionRunnable,
    PAUSE_MENU_DOCUMENT_ID,
    PAUSE_MENU_REQUIRED_ACTIONS,
    TITLE_MENU_DOCUMENT_ID,
    TITLE_MENU_REQUIRED_ACTIONS,
    type MenuActionHandlers,
} from './menus';
import { createPlayerOptionsStore, defaultPlayerOptions } from '../runtime/playerOptions';
import { localization, localizationSettingsFromDocuments, uiText, useUiText } from '../runtime/localization';

type Screen = 'title' | 'playing';

interface Session {
    levelId: string;
    key: number;
    restore: SaveGameData | null;
}

interface Toast {
    id: number;
    message: string;
    type: 'info' | 'success' | 'warning' | 'error';
}

const Button: React.FC<{ onClick: () => void; children: React.ReactNode; disabled?: boolean }> = ({ onClick, children, disabled }) => (
    <button
        onClick={onClick}
        disabled={disabled}
        className="w-64 px-6 py-3 rounded bg-white/10 hover:bg-white/20 disabled:opacity-40 disabled:hover:bg-white/10 text-white text-sm font-semibold tracking-wide transition-colors"
    >
        {children}
    </button>
);

const Menu: React.FC<{ title: string; subtitle?: string; children: React.ReactNode }> = ({ title, subtitle, children }) => (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 text-white">
        <h1 className="text-4xl font-bold mb-1">{title}</h1>
        {subtitle && <p className="text-sm text-white/60 mb-4">{subtitle}</p>}
        {children}
    </div>
);

export const PlayerApp: React.FC = () => {
    const [pack, setPack] = useState<GamePackSource | null>(null);
    const [loaded, setLoaded] = useState<LoadedGameContent | null>(null);
    const [progress, setProgress] = useState<{ value: number; label?: string }>({ value: 0 });
    const [error, setError] = useState<string | null>(null);
    const [screen, setScreen] = useState<Screen>('title');
    const [session, setSession] = useState<Session | null>(null);
    const [paused, setPaused] = useState(false);
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [optionsOpen, setOptionsOpen] = useState(false);
    const toastId = useRef(0);
    const health = useGameState(state => state.player.health);
    // Built-in screens follow the project's string tables; toasts below use uiText, read when they fire.
    const text = useUiText();

    // --- Load the game pack and hydrate its content once ---
    useEffect(() => {
        const controller = new AbortController();
        let source: GamePackSource | null = null;
        (async () => {
            try {
                source = await loadGamePack(window.location.href, controller.signal);
                setPack(source);
                localization.scopeToGame(source.manifest.gameId);
                localization.load(localizationSettingsFromDocuments(source.domains.metadata));
                const content = await loadGameContent(source.domains as Record<string, any[]>, {
                    resolveAssetUrl: source.resolveAssetUrl,
                    generateThumbnails: false,
                    // The player has no level manager to load terrain heights and paint later.
                    resolveTerrains: true,
                    onProgress: (value, label) => setProgress({ value, label }),
                    signal: controller.signal,
                });
                if (!controller.signal.aborted) setLoaded(content);
            } catch (failure) {
                if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
            }
        })();
        return () => {
            controller.abort();
            source?.dispose();
        };
    }, []);

    const manifest = pack?.manifest ?? null;
    const settings = loaded?.settings ?? null;
    const saves = useMemo(() => (manifest ? createSaveGameStore(manifest.gameId) : null), [manifest]);
    const optionsStore = useMemo(
        () => (manifest && settings ? createPlayerOptionsStore(manifest.gameId, defaultPlayerOptions(settings)) : null),
        [manifest, settings],
    );
    const [saveList, setSaveList] = useState(() => saves?.list() ?? []);
    useEffect(() => { setSaveList(saves?.list() ?? []); }, [saves]);

    useEffect(() => {
        if (manifest) document.title = manifest.name;
    }, [manifest]);

    const levels = useMemo(() => {
        const map = new Map<string, RuntimeLevel>();
        if (!loaded) return map;
        for (const level of loaded.levels) {
            map.set(level.id, {
                id: level.id,
                name: level.name,
                objects: loaded.objects.filter(object => object.levelId === level.id),
                blueprint: level.blueprint ?? { nodes: [], connections: [], variables: [] },
            });
        }
        return map;
    }, [loaded]);

    const startupLevelId = useMemo(() => {
        const preferred = settings?.startupLevelId ?? manifest?.startupLevelId ?? null;
        if (preferred && levels.has(preferred)) return preferred;
        return levels.keys().next().value ?? null;
    }, [settings, manifest, levels]);

    const print = useCallback((message: string, type: Toast['type'] = 'info') => {
        const id = ++toastId.current;
        setToasts(previous => [...previous.slice(-3), { id, message, type }]);
        window.setTimeout(() => setToasts(previous => previous.filter(toast => toast.id !== id)), 3000);
    }, []);

    const beginSession = useCallback((levelId: string, restore: SaveGameData | null = null) => {
        gameState.reset();
        gameState.update({ levelId });
        setPaused(false);
        setScreen('playing');
        setSession(previous => ({ levelId, key: (previous?.key ?? 0) + 1, restore }));
    }, []);

    const quitToTitle = useCallback(() => {
        setPaused(false);
        setSession(null);
        setScreen('title');
        if (document.pointerLockElement) document.exitPointerLock();
    }, []);

    const saveGame = useCallback((slot = 'auto') => {
        if (!saves || !session || !manifest) return;
        const state = gameState.get();
        const start = levels.get(session.levelId)?.objects.find(object => object.type === 'player_start');
        const data: SaveGameData = {
            schema: 1,
            gameId: manifest.gameId,
            slot,
            savedAt: new Date().toISOString(),
            levelId: session.levelId,
            player: {
                position: start?.position ?? [0, 0, 0],
                rotation: start?.rotation ?? [0, 0, 0],
                health: state.player.health,
                stamina: state.player.stamina,
            },
            destroyedObjectIds: [],
            variables: { ...state.vars },
        };
        if (saves.save(data)) {
            setSaveList(saves.list());
            print(uiText('ui.toast.saved'), 'success');
        } else {
            print(uiText('ui.toast.saveFailed'), 'error');
        }
    }, [saves, session, manifest, levels, print]);

    const loadGame = useCallback((slot = 'auto') => {
        const data = saves?.load(slot) ?? null;
        if (!data || !levels.has(data.levelId)) {
            print(uiText('ui.toast.noSave'), 'warning');
            return;
        }
        beginSession(data.levelId, data);
    }, [saves, levels, beginSession, print]);

    const host = useMemo<RuntimeHost>(() => ({
        print,
        restartLevel: () => { if (session) beginSession(session.levelId); },
        endLevel: quitToTitle,
        openLevel: levelId => {
            if (levels.has(levelId)) beginSession(levelId);
            else print(uiText('ui.toast.missingLevel', { level: levelId }), 'error');
        },
        saveGame,
        loadGame,
        requestPause: () => setPaused(true),
    }), [print, session, beginSession, quitToTitle, levels, saveGame, loadGame]);

    const startGame = useCallback(() => {
        if (!startupLevelId) return;
        if (settings?.window.fullscreen && !document.fullscreenElement) {
            document.documentElement.requestFullscreen?.().catch(() => undefined);
        }
        beginSession(startupLevelId);
    }, [startupLevelId, settings, beginSession]);

    const hasSaves = saveList.length > 0;
    const latestSlot = hasSaves ? saveList[0].slot : null;
    const menuHandlers = useMemo<MenuActionHandlers>(() => ({
        play: startupLevelId ? startGame : undefined,
        continue: latestSlot ? () => loadGame(latestSlot) : undefined,
        load: hasSaves ? () => loadGame() : undefined,
        options: optionsStore ? () => setOptionsOpen(true) : undefined,
        openLevel: host.openLevel,
    }), [startupLevelId, startGame, latestSlot, hasSaves, loadGame, optionsStore, host]);

    const titleHandlers = useMemo<MenuActionHandlers>(() => ({
        ...menuHandlers,
        // Browsers only close windows a script opened; elsewhere this is a no-op.
        quit: () => {
            if (document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined);
            window.close();
        },
    }), [menuHandlers]);

    const pauseHandlers = useMemo<MenuActionHandlers>(() => ({
        ...menuHandlers,
        resume: () => setPaused(false),
        save: () => saveGame(),
        quit: quitToTitle,
    }), [menuHandlers, saveGame, quitToTitle]);

    // Authored 'menu-title' / 'menu-pause' HUD documents replace the built-in menus when present, and only
    // when an entry the screen requires can run right now, so a menu whose buttons are all disabled never traps the player.
    const titleMenu = useMemo(
        () => findMenuDocument(pack?.domains.hud, TITLE_MENU_DOCUMENT_ID, TITLE_MENU_REQUIRED_ACTIONS, menuActionRunnable(titleHandlers, levels)),
        [pack, titleHandlers, levels],
    );
    const pauseMenu = useMemo(
        () => findMenuDocument(pack?.domains.hud, PAUSE_MENU_DOCUMENT_ID, PAUSE_MENU_REQUIRED_ACTIONS, menuActionRunnable(pauseHandlers, levels)),
        [pack, pauseHandlers, levels],
    );

    const hudOverlay = useMemo(() => {
        const hud = loaded?.hud;
        return hud && Array.isArray(hud.elements) && hud.elements.length > 0
            ? <HUDRenderer document={hud} bindings />
            : undefined;
    }, [loaded]);

    const gameOver = screen === 'playing' && session !== null && health <= 0;
    const level = session ? levels.get(session.levelId) ?? null : null;
    const playerStart: PlayerStart | null = session?.restore
        ? { position: session.restore.player.position, rotation: session.restore.player.rotation }
        : null;

    if (error) {
        return (
            <Menu title={text('ui.startFailed')} subtitle={error}>
                <p className="text-xs text-white/50 max-w-md text-center">
                    {text('ui.startFailedHint')}
                </p>
            </Menu>
        );
    }

    if (!loaded || !manifest || !settings) {
        return (
            <Menu title={manifest?.name ?? text('ui.loading')} subtitle={progress.label ?? text('ui.loadingContent')}>
                <div className="w-64 h-1.5 rounded bg-white/10 overflow-hidden">
                    <div className="h-full bg-white/70 transition-all" style={{ width: `${Math.round(Math.min(1, Math.max(0, progress.value)) * 100)}%` }} />
                </div>
            </Menu>
        );
    }

    return (
        <GameContentProvider value={loaded.content}>
            <div className="relative w-screen h-screen bg-black overflow-hidden select-none">
                {screen === 'playing' && level && session && (
                    <LevelRuntime
                        key={session.levelId}
                        level={level}
                        settings={settings}
                        playerStart={playerStart}
                        paused={paused || gameOver}
                        host={host}
                        sessionKey={session.key}
                        overlay={hudOverlay}
                        restore={session.restore}
                        playerOptions={optionsStore ?? undefined}
                    />
                )}

                {screen === 'title' && titleMenu && (
                    <AuthoredMenu document={titleMenu} handlers={titleHandlers} availableLevels={levels} />
                )}

                {screen === 'title' && !titleMenu && (
                    <Menu title={manifest.name}>
                        <Button onClick={startGame} disabled={!startupLevelId}>{text('ui.play')}</Button>
                        {saveList.length > 0 && <Button onClick={() => loadGame(saveList[0].slot)}>{text('ui.continue')}</Button>}
                        <Button onClick={() => setOptionsOpen(true)} disabled={!optionsStore}>{text('ui.options')}</Button>
                        {!startupLevelId && <p className="text-xs text-red-300">{text('ui.noPlayableLevel')}</p>}
                    </Menu>
                )}

                {screen === 'playing' && paused && !gameOver && pauseMenu && (
                    <AuthoredMenu document={pauseMenu} handlers={pauseHandlers} availableLevels={levels} />
                )}

                {screen === 'playing' && paused && !gameOver && !pauseMenu && (
                    <Menu title={text('ui.paused')}>
                        <Button onClick={() => setPaused(false)}>{text('ui.resume')}</Button>
                        <Button onClick={() => saveGame()}>{text('ui.save')}</Button>
                        <Button onClick={() => loadGame()} disabled={saveList.length === 0}>{text('ui.load')}</Button>
                        <Button onClick={() => setOptionsOpen(true)} disabled={!optionsStore}>{text('ui.options')}</Button>
                        <Button onClick={quitToTitle}>{text('ui.quitToTitle')}</Button>
                    </Menu>
                )}

                {optionsOpen && optionsStore && <OptionsMenu store={optionsStore} onClose={() => setOptionsOpen(false)} />}

                {gameOver && (
                    <Menu title={text('ui.gameOver')}>
                        <Button onClick={() => session && beginSession(session.levelId)}>{text('ui.gameOver.retry')}</Button>
                        <Button onClick={() => loadGame()} disabled={saveList.length === 0}>{text('ui.gameOver.loadLastSave')}</Button>
                        <Button onClick={quitToTitle}>{text('ui.quitToTitle')}</Button>
                    </Menu>
                )}

                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none">
                    {toasts.map(toast => (
                        <div key={toast.id} className="px-4 py-2 rounded bg-black/70 text-white text-xs">{toast.message}</div>
                    ))}
                </div>
            </div>
        </GameContentProvider>
    );
};
