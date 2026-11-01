import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { Filter, FileCode, FolderOpen } from 'lucide-react';
import { useScene } from '../../../context/SceneContext';
import { useNotification } from '../../../context/NotificationContext';
import { AssetCategory, AudioData, LoadedModelData, ModelImportSettings, TextureData } from '../../../types';
import { ThumbnailTooltip } from '../ThumbnailTooltip';
import { BrowserToolbar } from './BrowserToolbar';
import { ModelCard } from './ModelCard';
import { BlueprintCard } from './BlueprintCard';
import { TextureCard } from './TextureCard';
import { AudioCard } from './AudioCard';
import { FolderTree } from './FolderTree';
import { FolderCard } from './FolderCard';
import { BreadcrumbBar } from './BreadcrumbBar';
import { AssetContextMenu, type AssetMenuAction } from './AssetContextMenu';
import { InlineNameInput, type InlineNameCommitSource } from './InlineNameInput';
import { ImportOptionsDialog } from './ImportOptionsDialog';
import {
    ASSET_DRAG_TYPE,
    MODEL_DRAG_TYPE,
    MODEL_FILE_ACCEPT,
    ROOT_FOLDER,
    childFolderPaths,
    collectFolderPaths,
    decodeAssetDrag,
    encodeAssetDrag,
    folderAncestors,
    isModelFileName,
    isWithinFolder,
    normalizeFolderPath,
    parentFolderPath,
    splitAssetName,
    validateAssetRename,
    validateNewFolderName,
    type BrowserAssetKind,
} from './browserFolders';
import { selectAnimationTarget } from '../../../utils/animationBinding';
import { appAlert } from '../../../utils/appDialogs';

type AssetInfoUpdate = { name?: string; folder?: string };

/**
 * Asset-organization actions the asset managers publish through the scene
 * context. Each is looked up at runtime so the browser disables an action
 * rather than failing while the context does not expose it.
 */
interface BrowserAssetActions {
    importModelWithOptions: (file: File, settings: ModelImportSettings, category?: AssetCategory) => Promise<void>;
    reimportModel: (modelId: string, file?: File | null, settings?: ModelImportSettings) => Promise<void>;
    updateModel: (id: string, updates: AssetInfoUpdate) => Promise<void> | void;
    updateTexture: (id: string, updates: AssetInfoUpdate) => Promise<void> | void;
    updateAudio: (id: string, updates: AssetInfoUpdate) => Promise<void> | void;
}

const ACTION_KEYS: readonly (keyof BrowserAssetActions)[] = ['importModelWithOptions', 'reimportModel', 'updateModel', 'updateTexture', 'updateAudio'];

const pickAssetActions = (scene: object): Partial<BrowserAssetActions> => {
    const source = scene as Record<string, unknown>;
    const actions: Partial<Record<keyof BrowserAssetActions, unknown>> = {};
    for (const key of ACTION_KEYS) {
        if (typeof source[key] === 'function') actions[key] = source[key];
    }
    return actions as Partial<BrowserAssetActions>;
};

type LibraryItem =
    | { kind: 'model'; id: string; name: string; folder: string; category: AssetCategory; model: LoadedModelData }
    | { kind: 'texture'; id: string; name: string; folder: string; category: AssetCategory; texture: TextureData }
    | { kind: 'audio'; id: string; name: string; folder: string; category: AssetCategory; audio: AudioData };

/** Texture and audio records carry `folder` from their project documents even where the type does not declare it. */
const folderOf = (asset: object): string => {
    const folder = (asset as { folder?: unknown }).folder;
    return normalizeFolderPath(typeof folder === 'string' ? folder : undefined);
};

const KIND_LABEL: Record<BrowserAssetKind, string> = { model: 'models', texture: 'textures', audio: 'audio' };

const folderStorageKey = (projectId: string | null) => (projectId ? `auvra.contentBrowser.folders.${projectId}` : null);

/** Empty folders are a per-viewer convenience; folders holding assets persist through the asset documents. */
const readStoredFolders = (key: string | null): string[] => {
    if (!key) return [];
    try {
        const parsed: unknown = JSON.parse(window.localStorage.getItem(key) || '[]');
        return Array.isArray(parsed) ? collectFolderPaths(parsed.filter((value): value is string => typeof value === 'string')) : [];
    } catch {
        return [];
    }
};

const writeStoredFolders = (key: string | null, folders: string[]) => {
    if (!key) return;
    try {
        window.localStorage.setItem(key, JSON.stringify(folders));
    } catch {
        // Storage can be unavailable (private window, quota); folders then last for the session.
    }
};

export const ContentBrowser: React.FC = () => {
    const scene = useScene();
    const {
        models,
        addModel,
        addAnimations,
        selectedModelId,
        selectModel,
        placeInScene,
        removeFromScene,
        isLoading,
        blueprints,
        isCreatingPlayerBlueprint,
        selectBlueprint,
        addBlueprint,
        textures,
        addTexture,
        removeTexture,
        audioAssets,
        addAudio,
        removeAudio,
        projectStatus,
    } = scene;
    const assetActions = useMemo(() => pickAssetActions(scene), [scene]);
    const { addNotification } = useNotification();

    const [activeTab, setActiveTab] = useState<'models' | 'blueprints'>('models');
    const [filter, setFilter] = useState<AssetCategory | 'All'>('All');
    const [searchQuery, setSearchQuery] = useState('');
    const animationTarget = useMemo(() => {
        try {
            return selectAnimationTarget(models, selectedModelId);
        } catch {
            return null;
        }
    }, [models, selectedModelId]);

    const [menu, setMenu] = useState<{ x: number; y: number; kind: BrowserAssetKind; id: string } | null>(null);
    const closeMenu = useCallback(() => setMenu(null), []);

    // --- Hover Logic for Live Preview ---
    const [hoveredModel, setHoveredModel] = useState<LoadedModelData | null>(null);
    const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
    const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latestCursorPos = useRef({ x: 0, y: 0 });

    const handleMouseMove = (e: React.MouseEvent) => {
        latestCursorPos.current = { x: e.clientX, y: e.clientY };
        if (hoveredModel) {
            setCursorPos({ x: e.clientX, y: e.clientY });
        }
    };

    const handleHoverStart = (model: LoadedModelData) => {
        if (model.category === 'Animation') return;
        if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = setTimeout(() => {
            setHoveredModel(model);
            setCursorPos(latestCursorPos.current);
        }, 400);
    };

    const handleHoverEnd = () => {
        if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
        setHoveredModel(null);
    };

    const notifyError = useCallback((message: string, error?: unknown) => {
        const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
        addNotification({ type: 'error', message: `${message}${detail}` });
    }, [addNotification]);

    // --- Library Items & Folders ---
    const libraryItems = useMemo<LibraryItem[]>(() => [
        ...models.map((model): LibraryItem => ({ kind: 'model', id: model.id, name: model.name, folder: folderOf(model), category: model.category, model })),
        ...textures.map((texture): LibraryItem => ({ kind: 'texture', id: texture.id, name: texture.name, folder: folderOf(texture), category: 'Texture', texture })),
        ...audioAssets.map((audio): LibraryItem => ({ kind: 'audio', id: audio.id, name: audio.name, folder: folderOf(audio), category: 'Audio', audio })),
    ], [models, textures, audioAssets]);

    const projectId = projectStatus?.projectId ?? null;
    const storageKey = folderStorageKey(projectId);
    const [extraFolders, setExtraFolders] = useState<string[]>(() => readStoredFolders(storageKey));
    const [currentFolder, setCurrentFolder] = useState<string>(ROOT_FOLDER);
    const [creatingFolderIn, setCreatingFolderIn] = useState<string | null>(null);
    const [createFolderError, setCreateFolderError] = useState<string | null>(null);

    useEffect(() => {
        setExtraFolders(readStoredFolders(storageKey));
        setCurrentFolder(ROOT_FOLDER);
        setCreatingFolderIn(null);
    }, [storageKey]);

    const persistExtraFolders = (next: string[]) => {
        const normalized = collectFolderPaths(next);
        setExtraFolders(normalized);
        writeStoredFolders(storageKey, normalized);
    };

    const folders = useMemo(
        () => collectFolderPaths([...libraryItems.map((item) => item.folder), ...extraFolders]),
        [libraryItems, extraFolders],
    );

    /** Assets in each folder, counting subfolders. */
    const itemCountByFolder = useMemo(() => {
        const counts = new Map<string, number>();
        for (const item of libraryItems) {
            for (const path of folderAncestors(item.folder)) counts.set(path, (counts.get(path) || 0) + 1);
        }
        return counts;
    }, [libraryItems]);

    // A folder can disappear (another viewer moved its assets, project switch); fall back to its nearest parent.
    useEffect(() => {
        if (currentFolder === ROOT_FOLDER || folders.includes(currentFolder)) return;
        let fallback = parentFolderPath(currentFolder);
        while (fallback !== ROOT_FOLDER && !folders.includes(fallback)) fallback = parentFolderPath(fallback);
        setCurrentFolder(fallback);
    }, [currentFolder, folders]);

    const navigateTo = (path: string) => {
        setCurrentFolder(normalizeFolderPath(path));
        setCreatingFolderIn(null);
    };

    const beginCreateFolder = () => {
        setActiveTab('models');
        setCreateFolderError(null);
        setCreatingFolderIn(currentFolder);
    };

    const cancelCreateFolder = () => {
        setCreatingFolderIn(null);
        setCreateFolderError(null);
    };

    const commitCreateFolder = (value: string, source: InlineNameCommitSource): boolean => {
        if (creatingFolderIn === null) return true;
        if (source === 'blur' && !value.trim()) {
            cancelCreateFolder();
            return true;
        }
        const result = validateNewFolderName(value, creatingFolderIn, folders);
        if (!result.ok) {
            if (source === 'blur') {
                cancelCreateFolder();
                return true;
            }
            setCreateFolderError(result.error);
            return false;
        }
        if (!result.existed) persistExtraFolders([...extraFolders, result.path]);
        cancelCreateFolder();
        return true;
    };

    const canRemoveFolder = (path: string) => !itemCountByFolder.get(path)
        && extraFolders.some((folder) => isWithinFolder(folder, path, true));

    const removeFolder = (path: string) => {
        if (!canRemoveFolder(path)) return;
        persistExtraFolders(extraFolders.filter((folder) => !isWithinFolder(folder, path, true)));
        if (isWithinFolder(currentFolder, path, true)) setCurrentFolder(parentFolderPath(path));
    };

    const updaterFor = (kind: BrowserAssetKind) => (
        kind === 'model' ? assetActions.updateModel : kind === 'texture' ? assetActions.updateTexture : assetActions.updateAudio
    );

    const findItem = (kind: BrowserAssetKind, id: string) => libraryItems.find((item) => item.kind === kind && item.id === id);

    // --- Move ---
    const moveAsset = async (kind: BrowserAssetKind, id: string, folder: string) => {
        const item = findItem(kind, id);
        if (!item) return;
        const target = normalizeFolderPath(folder);
        if (item.folder === target) return;
        const update = updaterFor(kind);
        if (!update) {
            notifyError(`Moving ${KIND_LABEL[kind]} between folders is not available yet.`);
            return;
        }
        // Keep the source folder in the tree once its last asset leaves.
        if (item.folder && !extraFolders.includes(item.folder)) persistExtraFolders([...extraFolders, item.folder]);
        try {
            // '' (not undefined) so the merge-upsert clears a stored folder.
            await update(id, { folder: target });
        } catch (error) {
            notifyError(`Could not move ${item.name}`, error);
        }
    };

    const handleFolderDrop = (event: React.DragEvent, folder: string) => {
        const payload = decodeAssetDrag(event.dataTransfer.getData(ASSET_DRAG_TYPE));
        if (payload) void moveAsset(payload.kind, payload.id, folder);
    };

    const handleDragStart = (event: React.DragEvent, item: LibraryItem) => {
        handleHoverEnd();
        setMenu(null);
        event.dataTransfer.effectAllowed = 'copyMove';
        event.dataTransfer.setData(ASSET_DRAG_TYPE, encodeAssetDrag({ kind: item.kind, id: item.id }));
        // Animation clips have no geometry to place.
        if (item.kind === 'model' && item.category !== 'Animation') event.dataTransfer.setData(MODEL_DRAG_TYPE, item.id);
    };

    // --- Rename ---
    const [renaming, setRenaming] = useState<{ kind: BrowserAssetKind; id: string } | null>(null);
    const [renameError, setRenameError] = useState<string | null>(null);

    const beginRename = (item: LibraryItem) => {
        if (!updaterFor(item.kind)) {
            notifyError(`Renaming ${KIND_LABEL[item.kind]} is not available yet.`);
            return;
        }
        handleHoverEnd();
        setRenameError(null);
        setRenaming({ kind: item.kind, id: item.id });
    };

    const cancelRename = () => {
        setRenaming(null);
        setRenameError(null);
    };

    const commitRename = (value: string, source: InlineNameCommitSource): boolean => {
        const item = renaming ? findItem(renaming.kind, renaming.id) : undefined;
        if (!item) {
            cancelRename();
            return true;
        }
        const siblings = libraryItems.filter((candidate) => candidate.kind === item.kind).map((candidate) => candidate.name);
        const result = validateAssetRename(item.name, value, siblings);
        if (!result.ok) {
            if (source === 'blur') {
                cancelRename();
                return true;
            }
            setRenameError(result.error);
            return false;
        }
        cancelRename();
        const update = updaterFor(item.kind);
        if (result.changed && update) {
            Promise.resolve()
                .then(() => update(item.id, { name: result.name }))
                .catch((error: unknown) => notifyError(`Could not rename ${item.name}`, error));
        }
        return true;
    };

    const nameEditorFor = (item: LibraryItem) => {
        if (!renaming || renaming.kind !== item.kind || renaming.id !== item.id) return undefined;
        const { stem, extension } = splitAssetName(item.name);
        return (
            <InlineNameInput
                initialValue={stem}
                suffix={extension || undefined}
                ariaLabel={`Rename ${item.name}`}
                error={renameError}
                onCommit={commitRename}
                onCancel={cancelRename}
            />
        );
    };

    // --- Context Menu ---
    const menuItem = menu ? findItem(menu.kind, menu.id) : undefined;

    const openMenu = (event: React.MouseEvent, item: LibraryItem) => {
        event.preventDefault();
        handleHoverEnd();
        setMenu({ x: event.clientX, y: event.clientY, kind: item.kind, id: item.id });
    };

    const actionState = (available: boolean, unavailableReason: string): AssetMenuAction => ({ available, unavailableReason });

    // --- Import Handlers ---
    const [importPromptFile, setImportPromptFile] = useState<File | null>(null);
    const importPromptResolveRef = useRef<((settings: ModelImportSettings | null) => void) | null>(null);

    const requestImportSettings = (file: File) => new Promise<ModelImportSettings | null>((resolve) => {
        importPromptResolveRef.current?.(null);
        importPromptResolveRef.current = resolve;
        setImportPromptFile(file);
    });

    const settleImportPrompt = useCallback((settings: ModelImportSettings | null) => {
        const resolve = importPromptResolveRef.current;
        importPromptResolveRef.current = null;
        setImportPromptFile(null);
        resolve?.(settings);
    }, []);
    const cancelImportPrompt = useCallback(() => settleImportPrompt(null), [settleImportPrompt]);

    useEffect(() => () => importPromptResolveRef.current?.(null), []);

    const handleImport = async (files: File[], category: AssetCategory) => {
        if (category === 'Animation') {
            try {
                const target = selectAnimationTarget(models, selectedModelId);
                await addAnimations(files, target.id);
                selectModel(target.id);
            } catch (error) {
                void appAlert('Animation clips were not imported.', error instanceof Error ? error.message : 'Select a skeletal model before importing animation clips.');
            }
            return;
        }
        const importWithOptions = assetActions.importModelWithOptions;
        for (const file of files) {
            if (!isModelFileName(file.name)) {
                notifyError(`${file.name} is not a supported model file (${MODEL_FILE_ACCEPT.split(',').filter((entry) => entry.startsWith('.')).join(', ')}).`);
                continue;
            }
            if (!importWithOptions) {
                await addModel(file, category);
                continue;
            }
            const settings = await requestImportSettings(file);
            // Cancel stops the rest of the batch.
            if (!settings) break;
            try {
                await importWithOptions(file, settings, category);
            } catch (error) {
                notifyError(`Could not import ${file.name}`, error);
            }
        }
    };

    const handleTextureImport = async (files: File[]) => {
        for (const file of files) {
            await addTexture(file);
        }
    };

    const handleAudioImport = async (files: File[]) => {
        for (const file of files) {
            await addAudio(file);
        }
    };

    // --- Reimport ---
    const reimportInputRef = useRef<HTMLInputElement>(null);
    const reimportTargetRef = useRef<string | null>(null);

    const startReimport = (modelId: string) => {
        reimportTargetRef.current = modelId;
        reimportInputRef.current?.click();
    };

    // --- Import size: an imported model read again from its source at another size ---
    const [sizeTarget, setSizeTarget] = useState<LoadedModelData | null>(null);

    const applyImportSize = async (settings: ModelImportSettings) => {
        const model = sizeTarget;
        setSizeTarget(null);
        const reimport = assetActions.reimportModel;
        if (!model || !reimport) return;
        try {
            await reimport(model.id, null, settings);
        } catch (error) {
            notifyError(`Could not resize ${model.name}`, error);
        }
    };

    const handleReimportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        const modelId = reimportTargetRef.current;
        reimportTargetRef.current = null;
        const reimport = assetActions.reimportModel;
        if (!file || !modelId || !reimport) return;
        if (!isModelFileName(file.name)) {
            notifyError(`${file.name} is not a supported model file.`);
            return;
        }
        try {
            await reimport(modelId, file);
        } catch (error) {
            notifyError(`Could not reimport ${file.name}`, error);
        }
    };

    // --- Filtering Logic ---
    const trimmedQuery = searchQuery.trim().toLowerCase();
    const isSearching = trimmedQuery.length > 0;

    const filteredLibraryItems = useMemo(() => libraryItems.filter((item) => {
        if (!isWithinFolder(item.folder, currentFolder, isSearching)) return false;
        const matchesFilter = filter === 'All' || item.category === filter;
        const matchesSearch = item.name.toLowerCase().includes(trimmedQuery);
        return matchesFilter && matchesSearch;
    }), [libraryItems, currentFolder, isSearching, filter, trimmedQuery]);

    const visibleSubfolders = useMemo(
        () => (isSearching ? [] : childFolderPaths(folders, currentFolder)),
        [isSearching, folders, currentFolder],
    );

    const filteredBlueprints = useMemo(() => blueprints.filter(bp =>
        bp.name.toLowerCase().includes(searchQuery.toLowerCase())
    ), [blueprints, searchQuery]);

    const hasPlayerCharacter = useMemo(() => blueprints.some(bp => bp.type === 'Player Character'), [blueprints]);

    const renderLibraryItem = (item: LibraryItem) => {
        const isRenamingItem = renaming?.kind === item.kind && renaming.id === item.id;
        let card: React.ReactNode;
        if (item.kind === 'model') {
            card = (
                <ModelCard
                    model={item.model}
                    onSelect={() => selectModel(item.id)}
                    onPlaceInScene={() => placeInScene(item.id)}
                    onRemoveFromScene={() => removeFromScene(item.id)}
                    onHoverStart={handleHoverStart}
                    onHoverEnd={handleHoverEnd}
                    nameEditor={nameEditorFor(item)}
                    onRenameRequest={() => beginRename(item)}
                />
            );
        } else if (item.kind === 'texture') {
            card = (
                <TextureCard
                    texture={item.texture}
                    onDelete={() => removeTexture(item.id)}
                    nameEditor={nameEditorFor(item)}
                    onRenameRequest={() => beginRename(item)}
                />
            );
        } else {
            card = (
                <AudioCard
                    audio={item.audio}
                    onDelete={() => removeAudio(item.id)}
                    nameEditor={nameEditorFor(item)}
                    onRenameRequest={() => beginRename(item)}
                />
            );
        }
        return (
            <div
                key={`${item.kind}:${item.id}`}
                draggable={!isRenamingItem}
                onDragStart={(event) => handleDragStart(event, item)}
                onContextMenu={(event) => openMenu(event, item)}
            >
                {card}
            </div>
        );
    };

    const isFolderEmpty = filteredLibraryItems.length === 0 && visibleSubfolders.length === 0;

    return (
        <div
            className="h-64 bg-gray-900/95 border-t border-white/10 flex flex-col shadow-[0_-4px_16px_rgba(0,0,0,0.5)] z-10"
            onMouseMove={handleMouseMove}
        >
            <BrowserToolbar
                activeTab={activeTab}
                onTabChange={setActiveTab}
                filter={filter}
                onFilterChange={setFilter}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                onImport={handleImport}
                onImportTexture={handleTextureImport}
                onImportAudio={handleAudioImport}
                onAddBlueprint={addBlueprint}
                onCreateFolder={beginCreateFolder}
                isLoading={isLoading}
                hasPlayerCharacter={hasPlayerCharacter}
                isCreatingPlayerBlueprint={isCreatingPlayerBlueprint}
                animationTargetName={animationTarget?.name}
            />

            <div className="flex-1 min-h-0 flex">
                {activeTab === 'models' && (
                    <FolderTree
                        folders={folders}
                        currentFolder={currentFolder}
                        onNavigate={navigateTo}
                        onDropAsset={handleFolderDrop}
                        creatingIn={creatingFolderIn}
                        createError={createFolderError}
                        onCreateCommit={commitCreateFolder}
                        onCreateCancel={cancelCreateFolder}
                        canRemoveFolder={canRemoveFolder}
                        onRemoveFolder={removeFolder}
                    />
                )}

                <div className="flex-1 min-w-0 flex flex-col">
                    {activeTab === 'models' && (
                        <BreadcrumbBar
                            currentFolder={currentFolder}
                            isSearching={isSearching}
                            onNavigate={navigateTo}
                            onDropAsset={handleFolderDrop}
                        />
                    )}

                    {/* Grid Content */}
                    <div className="flex-1 overflow-y-auto p-4 bg-transparent custom-scrollbar">
                        {activeTab === 'models' && (
                            isFolderEmpty ? (
                                <div className="h-full flex flex-col items-center justify-center text-gray-600 gap-2">
                                    {isSearching || filter !== 'All' || currentFolder === ROOT_FOLDER
                                        ? <Filter size={32} className="opacity-20" />
                                        : <FolderOpen size={32} className="opacity-20" />}
                                    <p className="text-sm">
                                        {isSearching || filter !== 'All' || currentFolder === ROOT_FOLDER ? 'No items found.' : 'This folder is empty. Drag assets here to move them.'}
                                    </p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-4">
                                    {visibleSubfolders.map((path) => (
                                        <FolderCard
                                            key={`folder:${path}`}
                                            path={path}
                                            itemCount={itemCountByFolder.get(path) || 0}
                                            onOpen={() => navigateTo(path)}
                                            onDropAsset={(event) => handleFolderDrop(event, path)}
                                        />
                                    ))}
                                    {filteredLibraryItems.map(renderLibraryItem)}
                                </div>
                            )
                        )}

                        {activeTab === 'blueprints' && (
                            filteredBlueprints.length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center text-gray-600 gap-2">
                                    <FileCode size={32} className="opacity-20" />
                                    <p className="text-sm">No blueprints created.</p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
                                    {filteredBlueprints.map(bp => (
                                        <BlueprintCard
                                            key={bp.id}
                                            blueprint={bp}
                                            onSelect={() => selectBlueprint(bp.id)}
                                        />
                                    ))}
                                </div>
                            )
                        )}
                    </div>
                </div>
            </div>

            {/* Status Bar */}
            <div className="h-6 bg-gray-950/80 border-t border-white/10 flex items-center px-3 justify-between shrink-0">
                <div className="text-2xs text-gray-500">
                    {activeTab === 'models'
                        ? `${filteredLibraryItems.length} Items${visibleSubfolders.length ? `, ${visibleSubfolders.length} Folders` : ''}`
                        : `${blueprints.length} Blueprints`
                    }
                </div>
                {isLoading && (
                    <div className="flex items-center gap-2 text-2xs text-white">
                        <span className="w-2 h-2 rounded-full bg-white animate-pulse"></span>
                        Processing...
                    </div>
                )}
            </div>

            {/* Render Live 3D Tooltip (Portal) */}
            {hoveredModel && activeTab === 'models' && !menu && (
                <ThumbnailTooltip model={hoveredModel} position={cursorPos} />
            )}

            {menu && menuItem && (
                <AssetContextMenu
                    position={{ x: menu.x, y: menu.y }}
                    assetName={menuItem.name}
                    assetFolder={menuItem.folder}
                    folders={folders}
                    rename={actionState(Boolean(updaterFor(menuItem.kind)), `Renaming ${KIND_LABEL[menuItem.kind]} is not available yet.`)}
                    move={folders.length === 0
                        ? actionState(false, 'Create a folder first.')
                        : actionState(Boolean(updaterFor(menuItem.kind)), `Moving ${KIND_LABEL[menuItem.kind]} between folders is not available yet.`)}
                    reimport={menuItem.kind === 'model'
                        ? actionState(Boolean(assetActions.reimportModel) && !isLoading, isLoading ? 'Wait for the current import to finish.' : 'Reimport is not available yet.')
                        : undefined}
                    onRename={() => { closeMenu(); beginRename(menuItem); }}
                    onMove={(folder) => { closeMenu(); void moveAsset(menuItem.kind, menuItem.id, folder); }}
                    onReimport={() => { closeMenu(); startReimport(menuItem.id); }}
                    importSize={menuItem.kind === 'model' && menuItem.model.category !== 'Animation'
                        ? actionState(Boolean(assetActions.reimportModel) && !isLoading, isLoading ? 'Wait for the current import to finish.' : 'Changing a model\'s size is not available yet.')
                        : undefined}
                    onImportSize={() => { closeMenu(); if (menuItem.kind === 'model') setSizeTarget(menuItem.model); }}
                    onClose={closeMenu}
                />
            )}

            {sizeTarget && (
                <ImportOptionsDialog
                    name={sizeTarget.name}
                    initialSettings={sizeTarget.importSettings}
                    confirmLabel="Apply"
                    onConfirm={(settings) => { void applyImportSize(settings); }}
                    onCancel={() => setSizeTarget(null)}
                />
            )}

            {importPromptFile && (
                <ImportOptionsDialog
                    name={importPromptFile.name}
                    onConfirm={settleImportPrompt}
                    onCancel={cancelImportPrompt}
                />
            )}

            <input
                ref={reimportInputRef}
                type="file"
                accept={MODEL_FILE_ACCEPT}
                className="hidden"
                aria-hidden="true"
                tabIndex={-1}
                onChange={handleReimportFile}
            />
        </div>
    );
};
