import { newSkyConfig } from '../../runtime/sky/skyPresets';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Trees, Box, Image, MousePointer2, Layers, Trash2, Plus, ChevronDown, ChevronRight, Crosshair, CornerLeftUp, Skull, Music, Sun, PersonStanding, Axis3d, Spline } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { LevelObject } from '../../types';
import { editorSession } from '../../utils/editorSession';
import { appAlert, appConfirm, appPrompt } from '../../utils/appDialogs';
import { reparentPreservingWorld, wouldCreateCycle } from '../../utils/sceneGraph';
import { uniqueObjectName } from '../../utils/levelClipboard';
import { createComponent } from '../../runtime/components/registry';
import { SPLINE_COMPONENT_TYPE } from '../../runtime/splines';
import { PrefabPanel } from './PrefabPanel';
import { LightingPanel } from './LightingPanel';

const PLAYER_START_NAME = 'Player Start';

/** dataTransfer type for outliner rows being dragged (payload: JSON array of object ids). */
const OUTLINER_DRAG_TYPE = 'application/x-auvra-outliner';
/** Drop-target key for the outliner's root area (unparent). */
const ROOT_DROP_TARGET = '__root__';

interface EnvironmentSidebarProps {
    selectedModelId: string | null;
    onSelectModel: (id: string | null) => void;
    selectedObjectId: string | null;
    onSelectObject: (id: string | null) => void;
    /** Full multi-selection; `selectedObjectId` stays the primary. Defaults to just the primary. */
    selectedObjectIds?: string[];
    /** Replace the selection (shift range). `primary` becomes `selectedObjectId`. */
    onSetSelection?: (ids: string[], primary?: string) => void;
    /** Add or remove one object from the selection (ctrl/cmd click). */
    onToggleSelection?: (id: string) => void;
    /** Ask the viewport camera to frame an object. */
    onRequestFocus?: (id: string) => void;
}

interface OutlinerRow {
    object: LevelObject;
    depth: number;
    hasChildren: boolean;
}

const objectDisplayName = (obj: LevelObject) => {
    if (obj.name) return obj.name;
    switch (obj.type) {
        case 'spawn_point': return 'Enemy Spawner';
        case 'audio_emitter': return 'Audio Emitter';
        case 'sky_sphere': return 'Sky Sphere';
        case 'player_start': return PLAYER_START_NAME;
        default: return 'Object';
    }
};

/** Parent id that resolves within `index` (missing or self parents make the object a root, as in sceneGraph). */
const resolveParentId = (index: Map<string, LevelObject>, obj: LevelObject): string | null => {
    const parentId = obj.parentId;
    if (!parentId || parentId === obj.id || !index.has(parentId)) return null;
    return parentId;
};

export const EnvironmentSidebar: React.FC<EnvironmentSidebarProps> = ({
    selectedModelId,
    onSelectModel,
    selectedObjectId,
    onSelectObject,
    selectedObjectIds,
    onSetSelection,
    onToggleSelection,
    onRequestFocus
}) => {
    const { models, levelObjects, removeLevelObject, levels, currentLevelId, createLevel, loadLevel, deleteLevel, addLevelObject, addLevelObjects, updateLevelObject, snapshotHistory } = useScene();
    const [activeTab, setActiveTab] = useState<'assets' | 'outliner'>('assets');
    const [search, setSearch] = useState('');
    const [showLevelMenu, setShowLevelMenu] = useState(false);
    const pendingPlayerStartName = useRef<string | null>(null);

    // Outliner tree state
    const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingName, setEditingName] = useState('');
    // Mirrors editingId so a blur fired while the input unmounts (after Enter/Escape) never commits twice.
    const editingRef = useRef<string | null>(null);
    const [draggingIds, setDraggingIds] = useState<string[]>([]);
    const [dropTarget, setDropTarget] = useState<{ id: string; valid: boolean } | null>(null);
    const selectionAnchor = useRef<string | null>(null);
    const rowElements = useRef(new Map<string, HTMLDivElement>());

    // Filter models suitable for environment placement
    const filteredModels = models.filter(m =>
        (m.category === 'Prop' || m.category === 'Environment') &&
        m.name.toLowerCase().includes(search.toLowerCase())
    );

    const selectedIds = useMemo(() => {
        const ids = selectedObjectIds ?? (selectedObjectId ? [selectedObjectId] : []);
        return new Set(ids);
    }, [selectedObjectIds, selectedObjectId]);

    // Hierarchy derived from parentId. Orphans (missing parent) and members of a corrupt
    // parent cycle are shown as roots so nothing ever disappears from the outliner.
    const hierarchy = useMemo(() => {
        const index = new Map<string, LevelObject>();
        for (const obj of levelObjects) index.set(obj.id, obj);
        const children = new Map<string | null, LevelObject[]>();
        for (const obj of levelObjects) {
            const parentId = resolveParentId(index, obj);
            const siblings = children.get(parentId);
            if (siblings) siblings.push(obj);
            else children.set(parentId, [obj]);
        }
        const reachable = new Set<string>();
        const stack = [...(children.get(null) ?? [])];
        while (stack.length > 0) {
            const obj = stack.pop()!;
            if (reachable.has(obj.id)) continue;
            reachable.add(obj.id);
            stack.push(...(children.get(obj.id) ?? []));
        }
        const roots = [...(children.get(null) ?? []), ...levelObjects.filter(o => !reachable.has(o.id) && resolveParentId(index, o) !== null)];
        return { index, children, roots };
    }, [levelObjects]);

    const searchTerm = search.trim().toLowerCase();

    // Objects matching the search, plus their ancestors so matches keep their context.
    const visibleIds = useMemo(() => {
        if (!searchTerm) return null;
        const visible = new Set<string>();
        for (const obj of levelObjects) {
            if (!objectDisplayName(obj).toLowerCase().includes(searchTerm)) continue;
            let current: LevelObject | undefined = obj;
            while (current && !visible.has(current.id)) {
                visible.add(current.id);
                const parentId = resolveParentId(hierarchy.index, current);
                current = parentId ? hierarchy.index.get(parentId) : undefined;
            }
        }
        return visible;
    }, [levelObjects, hierarchy, searchTerm]);

    const matchCount = useMemo(() => (
        searchTerm ? levelObjects.filter(o => objectDisplayName(o).toLowerCase().includes(searchTerm)).length : levelObjects.length
    ), [levelObjects, searchTerm]);

    // Flattened, visible rows in display order (also the order shift-range selection uses).
    const rows = useMemo(() => {
        const out: OutlinerRow[] = [];
        const visited = new Set<string>();
        const walk = (obj: LevelObject, depth: number) => {
            if (visited.has(obj.id)) return;
            if (visibleIds && !visibleIds.has(obj.id)) return;
            visited.add(obj.id);
            const kids = (hierarchy.children.get(obj.id) ?? []).filter(k => !visited.has(k.id) && (!visibleIds || visibleIds.has(k.id)));
            out.push({ object: obj, depth, hasChildren: kids.length > 0 });
            // Searching force-expands so every match is visible.
            if (!visibleIds && collapsedIds.has(obj.id)) return;
            for (const kid of kids) walk(kid, depth + 1);
        };
        for (const root of hierarchy.roots) walk(root, 0);
        return out;
    }, [hierarchy, visibleIds, collapsedIds]);

    const currentLevel = levels.find(l => l.id === currentLevelId);
    const canEdit = () => editorSession.captureReady() !== null;

    // Reveal the primary selection (e.g. picked in the viewport): expand its ancestors and scroll to it.
    useEffect(() => {
        if (!selectedObjectId) return;
        const ancestors: string[] = [];
        const visited = new Set<string>();
        let current = hierarchy.index.get(selectedObjectId);
        while (current && !visited.has(current.id)) {
            visited.add(current.id);
            const parentId = resolveParentId(hierarchy.index, current);
            if (parentId) ancestors.push(parentId);
            current = parentId ? hierarchy.index.get(parentId) : undefined;
        }
        setCollapsedIds(prev => {
            if (!ancestors.some(id => prev.has(id))) return prev;
            const next = new Set(prev);
            ancestors.forEach(id => next.delete(id));
            return next;
        });
    }, [selectedObjectId, hierarchy]);

    useEffect(() => {
        if (activeTab !== 'outliner' || !selectedObjectId) return;
        rowElements.current.get(selectedObjectId)?.scrollIntoView?.({ block: 'nearest' });
    }, [activeTab, selectedObjectId, rows]);

    const handleCreateLevel = async () => {
        if (!canEdit()) return;
        const name = (await appPrompt('New level', { message: 'Name the new level.', acceptLabel: 'Create' }))?.trim();
        if (name && canEdit()) {
            await createLevel(name);
        }
    };

    const handleAddSpawner = async () => {
        if (!canEdit()) return;
        // Add a spawn point at origin
        const newId = await addLevelObject(
            '', // No model ID
            [0, 1, 0],
            [0, 0, 0],
            [1, 1, 1],
            'spawn_point'
        );

        if (newId) {
            onSelectObject(newId);
        }
    };

    // An object with no model: a place for components (trigger volumes, timelines, level streaming,
    // cameras) and a parent to group other objects under.
    const handleAddEmpty = async () => {
        if (!canEdit() || !currentLevelId) return;
        try {
            const [id] = await addLevelObjects([{
                id: crypto.randomUUID(),
                levelId: currentLevelId,
                modelId: '',
                name: uniqueObjectName('Empty', new Set(levelObjects.map(object => object.name))),
                type: 'prop',
                position: [0, 1, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
                parentId: null,
            }]);
            if (id) onSelectObject(id);
        } catch {
            // addLevelObjects has already reported the failure.
        }
    };

    // A spline in front of the origin: an empty object carrying a Spline component.
    const handleAddSpline = async () => {
        if (!canEdit() || !currentLevelId) return;
        try {
            const [id] = await addLevelObjects([{
                id: crypto.randomUUID(),
                levelId: currentLevelId,
                modelId: '',
                name: uniqueObjectName('Spline', new Set(levelObjects.map(object => object.name))),
                type: 'prop',
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
                parentId: null,
                components: [createComponent(SPLINE_COMPONENT_TYPE)],
            }]);
            if (id) onSelectObject(id);
        } catch {
            // addLevelObjects has already reported the failure.
        }
    };

    const handleAddAudioEmitter = async () => {
        if (!canEdit()) return;
        const newId = await addLevelObject(
            '',
            [0, 1, 0],
            [0, 0, 0],
            [1, 1, 1],
            'audio_emitter'
        );
        if (newId) onSelectObject(newId);
    };

    const handleAddPlayerStart = async () => {
        if (!canEdit()) return;
        // One Player Start per level: re-adding selects the existing one.
        const existing = levelObjects.find(o => o.type === 'player_start');
        if (existing) {
            onSelectObject(existing.id);
            return;
        }

        const newId = await addLevelObject(
            '',
            [0, 0, 0], // Marker origin is the player's feet
            [0, 0, 0],
            [1, 1, 1],
            'player_start'
        );
        if (newId) {
            pendingPlayerStartName.current = newId;
            onSelectObject(newId);
        }
    };

    // The level manager names objects it has no explicit case for after their model
    // ("undefined_Prop" here). Rename a freshly created Player Start once it lands in state.
    useEffect(() => {
        const id = pendingPlayerStartName.current;
        if (!id) return;
        const created = levelObjects.find(o => o.id === id);
        if (!created) return;
        pendingPlayerStartName.current = null;
        if (created.name !== PLAYER_START_NAME && canEdit()) {
            updateLevelObject(id, { name: PLAYER_START_NAME });
        }
    }, [levelObjects, updateLevelObject]);

    const handleAddSkySphere = async () => {
        if (!canEdit()) return;
        // Check if one already exists
        const existing = levelObjects.find(o => o.type === 'sky_sphere');
        if (existing) {
            void appAlert('A Sky Sphere already exists in this level.', 'It is selected now.');
            onSelectObject(existing.id);
            return;
        }

        const newId = await addLevelObject(
            '',
            [0, 5, 0], // Put it up in the air so icon is visible
            [0, 0, 0],
            [1, 1, 1],
            'sky_sphere',
            newSkyConfig()
        );
        if (newId) onSelectObject(newId);
    };

    // --- Outliner: selection ---

    const selectOnly = (id: string) => {
        selectionAnchor.current = id;
        onSelectObject(id);
        onSetSelection?.([id], id);
    };

    const handleRowClick = (e: React.MouseEvent, id: string) => {
        const additive = e.ctrlKey || e.metaKey;
        if (e.shiftKey && onSetSelection) {
            const order = rows.map(r => r.object.id);
            const anchor = selectionAnchor.current && order.includes(selectionAnchor.current)
                ? selectionAnchor.current
                : selectedObjectId;
            const from = anchor ? order.indexOf(anchor) : -1;
            const to = order.indexOf(id);
            if (from !== -1 && to !== -1) {
                const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
                const ids = additive ? [...new Set([...selectedIds, ...range])] : range;
                onSetSelection(ids, id);
                return;
            }
        }
        if (additive && onToggleSelection) {
            selectionAnchor.current = id;
            onToggleSelection(id);
            return;
        }
        selectOnly(id);
    };

    const handleFocus = (id: string) => {
        if (!selectedIds.has(id)) selectOnly(id);
        onRequestFocus?.(id);
    };

    const toggleCollapsed = (id: string) => {
        setCollapsedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    // --- Outliner: inline rename ---

    const beginRename = (obj: LevelObject) => {
        if (!canEdit()) return;
        editingRef.current = obj.id;
        setEditingId(obj.id);
        setEditingName(objectDisplayName(obj));
    };

    const cancelRename = () => {
        editingRef.current = null;
        setEditingId(null);
    };

    const commitRename = () => {
        const id = editingRef.current;
        cancelRename();
        if (!id) return;
        const obj = hierarchy.index.get(id);
        const name = editingName.trim();
        if (!obj || !name || name === obj.name || !canEdit()) return;
        snapshotHistory();
        updateLevelObject(id, { name });
    };

    // --- Outliner: drag-and-drop reparenting ---

    /** Dragged ids minus any whose ancestor is also dragged (moving the ancestor carries them). */
    const topLevelIds = (ids: string[]) => {
        const set = new Set(ids);
        return ids.filter(id => {
            const visited = new Set<string>();
            let current = hierarchy.index.get(id);
            while (current && !visited.has(current.id)) {
                visited.add(current.id);
                const parentId = resolveParentId(hierarchy.index, current);
                if (parentId && set.has(parentId)) return false;
                current = parentId ? hierarchy.index.get(parentId) : undefined;
            }
            return hierarchy.index.has(id);
        });
    };

    /** True when dropping the dragged objects onto `newParentId` would change at least one parent without a cycle. */
    const canReparent = (ids: string[], newParentId: string | null) => topLevelIds(ids).some(id => {
        const obj = hierarchy.index.get(id)!;
        if (resolveParentId(hierarchy.index, obj) === newParentId) return false;
        return !wouldCreateCycle(levelObjects, id, newParentId);
    });

    const applyReparent = (ids: string[], newParentId: string | null) => {
        if (!canEdit()) return;
        let working = levelObjects;
        const moved: LevelObject[] = [];
        for (const id of topLevelIds(ids)) {
            const obj = working.find(o => o.id === id);
            if (!obj) continue;
            const index = new Map(working.map(o => [o.id, o] as const));
            if (resolveParentId(index, obj) === newParentId) continue;
            if (wouldCreateCycle(working, id, newParentId)) continue; // refuse cycles
            const next = reparentPreservingWorld(working, id, newParentId);
            working = working.map(o => o.id === id ? next : o);
            moved.push(next);
        }
        if (moved.length === 0) return;
        snapshotHistory();
        for (const obj of moved) {
            updateLevelObject(obj.id, {
                parentId: obj.parentId ?? null,
                position: obj.position,
                rotation: obj.rotation,
                scale: obj.scale
            });
        }
        if (newParentId) {
            setCollapsedIds(prev => {
                if (!prev.has(newParentId)) return prev;
                const next = new Set(prev);
                next.delete(newParentId);
                return next;
            });
        }
    };

    const isOutlinerDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes(OUTLINER_DRAG_TYPE);

    const readDraggedIds = (e: React.DragEvent): string[] => {
        if (draggingIds.length > 0) return draggingIds;
        try {
            const parsed: unknown = JSON.parse(e.dataTransfer.getData(OUTLINER_DRAG_TYPE) || '[]');
            return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
        } catch {
            return [];
        }
    };

    const handleRowDragStart = (e: React.DragEvent, id: string) => {
        if (!canEdit() || editingId) {
            e.preventDefault();
            return;
        }
        const ids = selectedIds.has(id) ? levelObjects.filter(o => selectedIds.has(o.id)).map(o => o.id) : [id];
        e.dataTransfer.setData(OUTLINER_DRAG_TYPE, JSON.stringify(ids));
        e.dataTransfer.effectAllowed = 'move';
        setDraggingIds(ids);
    };

    const handleDragEnd = () => {
        setDraggingIds([]);
        setDropTarget(null);
    };

    const handleRowDragOver = (e: React.DragEvent, id: string) => {
        if (!isOutlinerDrag(e)) return;
        e.stopPropagation();
        const valid = draggingIds.length > 0 && canReparent(draggingIds, id);
        if (valid) e.preventDefault();
        e.dataTransfer.dropEffect = valid ? 'move' : 'none';
        if (dropTarget?.id !== id || dropTarget.valid !== valid) setDropTarget({ id, valid });
    };

    const handleRowDrop = (e: React.DragEvent, id: string) => {
        if (!isOutlinerDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const ids = readDraggedIds(e);
        handleDragEnd();
        if (canReparent(ids, id)) applyReparent(ids, id);
    };

    const handleRootDragOver = (e: React.DragEvent) => {
        if (!isOutlinerDrag(e)) return;
        const valid = draggingIds.length > 0 && canReparent(draggingIds, null);
        if (valid) e.preventDefault();
        e.dataTransfer.dropEffect = valid ? 'move' : 'none';
        if (dropTarget?.id !== ROOT_DROP_TARGET || dropTarget.valid !== valid) setDropTarget({ id: ROOT_DROP_TARGET, valid });
    };

    const handleRootDrop = (e: React.DragEvent) => {
        if (!isOutlinerDrag(e)) return;
        e.preventDefault();
        const ids = readDraggedIds(e);
        handleDragEnd();
        if (canReparent(ids, null)) applyReparent(ids, null);
    };

    const isRootDropActive = dropTarget?.id === ROOT_DROP_TARGET && dropTarget.valid;

    return (
        <div className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0 z-20 shadow-xl">
            {/* Header / Level Selector */}
            <div className="p-3 border-b border-gray-800 shrink-0 bg-gray-950">
                <div className="flex items-center justify-between mb-2">
                    <h1 className="text-sm font-bold text-gray-200 tracking-wide flex items-center gap-2">
                        <Trees size={14} className="text-green-400" /> World editor
                    </h1>
                </div>

                {/* Level Dropdown */}
                <div className="relative">
                    <button
                        onClick={() => setShowLevelMenu(!showLevelMenu)}
                        className="w-full flex items-center justify-between bg-gray-900 border border-gray-700 hover:border-gray-600 px-3 py-1.5 rounded text-xs text-white transition-colors"
                        title="Switch Level"
                    >
                        <span className="truncate font-medium">{currentLevel ? currentLevel.name : 'Select Level'}</span>
                        <ChevronDown size={12} className="text-gray-500" />
                    </button>

                    {showLevelMenu && (
                        <>
                            <div className="fixed inset-0 z-30" onClick={() => setShowLevelMenu(false)} />
                            <div className="absolute top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-700 rounded-md shadow-xl z-40 overflow-hidden">
                                <div className="max-h-48 overflow-y-auto custom-scrollbar p-1">
                                    {levels.map(lvl => (
                                        <div
                                            key={lvl.id}
                                            onClick={() => { if (!canEdit()) return; void loadLevel(lvl.id); setShowLevelMenu(false); }}
                                            className={`flex items-center justify-between px-2 py-1.5 rounded cursor-pointer group ${currentLevelId === lvl.id ? 'bg-blue-900/30 text-blue-400' : 'hover:bg-gray-700 text-gray-300'}`}
                                            title={`Load level: ${lvl.name}`}
                                        >
                                            <span className="text-xs truncate">{lvl.name}</span>
                                            {levels.length > 1 && (
                                                <button
                                                    onClick={async (e) => {
                                                        e.stopPropagation();
                                                        if (!canEdit()) return;
                                                        if (await appConfirm(`Delete level "${lvl.name}"?`, { message: 'Its objects are deleted with it.', acceptLabel: 'Delete', danger: true }) && canEdit()) void deleteLevel(lvl.id);
                                                    }}
                                                    className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400"
                                                    title="Delete Level"
                                                >
                                                    <Trash2 size={10} />
                                                </button>
                                            )}
                                        </div>
                                    ))}
                                </div>
                                <div className="border-t border-gray-700 p-1">
                                    <button
                                        onClick={() => { setShowLevelMenu(false); void handleCreateLevel(); }}
                                        className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                                        title="Create a new empty level"
                                    >
                                        <Plus size={12} /> New Level
                                    </button>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-800 bg-gray-900">
                <button
                    onClick={() => setActiveTab('assets')}
                    className={`flex-1 py-2 text-2xs font-bold transition-colors border-b-2 ${activeTab === 'assets' ? 'border-green-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                    title="Browse models to place"
                >
                    Browser
                </button>
                <button
                    onClick={() => setActiveTab('outliner')}
                    className={`flex-1 py-2 text-2xs font-bold transition-colors border-b-2 ${activeTab === 'outliner' ? 'border-green-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                    title="View hierarchy of placed objects"
                >
                    Outliner
                </button>
            </div>

            {/* Search Toolbar */}
            <div className="p-2 border-b border-gray-800 bg-gray-900">
                <div className="relative">
                    <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                    <input
                        type="text"
                        placeholder={activeTab === 'assets' ? "Filter assets..." : "Search hierarchy..."}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full bg-gray-900 border border-gray-700 rounded-md py-1.5 pl-8 pr-4 text-xs text-gray-300 focus:outline-none focus:border-green-500 transition-colors placeholder-gray-600"
                    />
                </div>
            </div>

            <div
                className={`flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1 ${isRootDropActive ? 'bg-green-900/10' : ''}`}
                onDragOver={activeTab === 'outliner' ? handleRootDragOver : undefined}
                onDrop={activeTab === 'outliner' ? handleRootDrop : undefined}
                onDragLeave={activeTab === 'outliner' ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null); } : undefined}
            >

                {/* --- ASSETS TAB --- */}
                {activeTab === 'assets' && (
                    <>
                        {/* Selection Tool Option */}
                        <div
                            onClick={() => onSelectModel(null)}
                            className={`
                                flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-all border
                                ${selectedModelId === null
                                    ? 'bg-blue-900/20 border-blue-500/30 text-white'
                                    : 'hover:bg-gray-800 border-transparent text-gray-400'
                                }
                            `}
                            title="Selection Mode (Q)"
                        >
                            <MousePointer2 size={16} />
                            <div className="text-xs font-bold">Select / Edit Mode</div>
                        </div>

                        {/* Special Actors */}
                        <div className="mt-2">
                            <div className="text-2xs text-gray-500 font-bold px-1 mb-1">Logic Actors</div>
                            <div
                                onClick={handleAddPlayerStart}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-all border border-transparent hover:bg-gray-800 hover:text-white text-gray-400 group"
                                title="Add Player Start (one per level)"
                            >
                                <div className="w-8 h-8 rounded bg-gray-800 border border-gray-700 flex items-center justify-center shrink-0 text-green-500 group-hover:bg-green-900/20 group-hover:border-green-500/50">
                                    <PersonStanding size={16} />
                                </div>
                                <div className="text-xs font-bold">Add Player Start</div>
                            </div>
                            <div
                                onClick={handleAddSpawner}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-all border border-transparent hover:bg-gray-800 hover:text-white text-gray-400 group"
                                title="Add Enemy Spawn Point"
                            >
                                <div className="w-8 h-8 rounded bg-gray-800 border border-gray-700 flex items-center justify-center shrink-0 text-red-500 group-hover:bg-red-900/20 group-hover:border-red-500/50">
                                    <Skull size={16} />
                                </div>
                                <div className="text-xs font-bold">Enemy Spawner</div>
                            </div>
                            <div
                                onClick={handleAddAudioEmitter}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-all border border-transparent hover:bg-gray-800 hover:text-white text-gray-400 group"
                                title="Add Audio Emitter"
                            >
                                <div className="w-8 h-8 rounded bg-gray-800 border border-gray-700 flex items-center justify-center shrink-0 text-amber-500 group-hover:bg-amber-900/20 group-hover:border-amber-500/50">
                                    <Music size={16} />
                                </div>
                                <div className="text-xs font-bold">Audio Emitter</div>
                            </div>
                            <div
                                onClick={handleAddEmpty}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-all border border-transparent hover:bg-gray-800 hover:text-white text-gray-400 group"
                                title="Add an empty object, for components such as trigger colliders, timelines and level streaming, or to group objects"
                            >
                                <div className="w-8 h-8 rounded bg-gray-800 border border-gray-700 flex items-center justify-center shrink-0 text-slate-300 group-hover:bg-slate-700/40 group-hover:border-slate-400/50">
                                    <Axis3d size={16} />
                                </div>
                                <div className="text-xs font-bold">Empty Object</div>
                            </div>
                            <div
                                onClick={handleAddSpline}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-all border border-transparent hover:bg-gray-800 hover:text-white text-gray-400 group"
                                title="Add a spline: a curve to bend roads, rails and fences along (Spline Mesh), place copies along (Spline Scatter) or move objects along (Follow Spline)"
                            >
                                <div className="w-8 h-8 rounded bg-gray-800 border border-gray-700 flex items-center justify-center shrink-0 text-fuchsia-400 group-hover:bg-fuchsia-900/20 group-hover:border-fuchsia-500/50">
                                    <Spline size={16} />
                                </div>
                                <div className="text-xs font-bold">Spline</div>
                            </div>
                            <div
                                onClick={handleAddSkySphere}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-all border border-transparent hover:bg-gray-800 hover:text-white text-gray-400 group"
                                title="Add Sky Atmosphere System"
                            >
                                <div className="w-8 h-8 rounded bg-gray-800 border border-gray-700 flex items-center justify-center shrink-0 text-cyan-500 group-hover:bg-cyan-900/20 group-hover:border-cyan-500/50">
                                    <Sun size={16} />
                                </div>
                                <div className="text-xs font-bold">Sky Sphere</div>
                            </div>
                        </div>

                        <div className="h-px bg-gray-800 my-2 mx-1" />

                        {filteredModels.length === 0 && (
                            <div className="text-center py-8 text-gray-600 text-xs italic px-4">
                                No environment assets found. Import 'Prop' or 'Environment' types.
                            </div>
                        )}

                        {filteredModels.map(m => (
                            <div
                                key={m.id}
                                onClick={() => onSelectModel(m.id)}
                                className={`
                                    flex items-center gap-3 px-2 py-2 rounded-md cursor-pointer transition-all border
                                    ${selectedModelId === m.id
                                        ? 'bg-green-900/20 border-green-500/30'
                                        : 'hover:bg-gray-800 border-transparent'
                                    }
                                `}
                                title={`Select ${m.name} to place`}
                            >
                                <div className="w-10 h-10 rounded bg-gray-800 overflow-hidden border border-gray-700 flex items-center justify-center shrink-0">
                                    {m.thumbnail ? (
                                        <img src={m.thumbnail} className="w-full h-full object-cover opacity-80" />
                                    ) : (
                                        m.category === 'Environment' ? <Image size={16} className="text-gray-600" /> : <Box size={16} className="text-gray-600" />
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className={`text-xs font-bold truncate ${selectedModelId === m.id ? 'text-white' : 'text-gray-400'}`}>{m.name}</div>
                                    <div className="text-2xs text-gray-600 ">{m.category}</div>
                                </div>
                            </div>
                        ))}
                    </>
                )}

                {/* --- OUTLINER TAB --- */}
                {activeTab === 'outliner' && (
                    <>
                        <div className="flex items-center gap-2 px-2 py-1 text-2xs font-bold text-gray-500 ">
                            <Layers size={10} />
                            <span>{searchTerm ? `${matchCount} of ${levelObjects.length}` : levelObjects.length} Objects</span>
                            {selectedIds.size > 1 && <span className="ml-auto text-blue-400 normal-case">{selectedIds.size} selected</span>}
                        </div>

                        {levelObjects.length === 0 && (
                            <div className="text-center py-8 text-gray-600 text-xs italic px-4">
                                Level is empty. Switch to Browser to paint assets.
                            </div>
                        )}

                        {levelObjects.length > 0 && rows.length === 0 && (
                            <div className="text-center py-8 text-gray-600 text-xs italic px-4">
                                No objects match "{search.trim()}".
                            </div>
                        )}

                        <div role="tree" aria-multiselectable="true" className="space-y-px">
                            {rows.map(({ object: obj, depth, hasChildren }) => {
                                const isSelected = selectedIds.has(obj.id);
                                const isPrimary = selectedObjectId === obj.id;
                                const isSpawner = obj.type === 'spawn_point';
                                const isAudio = obj.type === 'audio_emitter';
                                const isSky = obj.type === 'sky_sphere';
                                const isPlayerStart = obj.type === 'player_start';
                                const isCollapsed = !visibleIds && collapsedIds.has(obj.id);
                                const isEditing = editingId === obj.id;
                                const isDragged = draggingIds.includes(obj.id);
                                const rowDrop = dropTarget?.id === obj.id ? dropTarget : null;
                                const searchMatch = !searchTerm || objectDisplayName(obj).toLowerCase().includes(searchTerm);

                                return (
                                    <div
                                        key={obj.id}
                                        ref={(el) => { if (el) rowElements.current.set(obj.id, el); else rowElements.current.delete(obj.id); }}
                                        role="treeitem"
                                        aria-selected={isSelected}
                                        aria-level={depth + 1}
                                        aria-expanded={hasChildren ? !isCollapsed : undefined}
                                        draggable={!isEditing}
                                        onDragStart={(e) => handleRowDragStart(e, obj.id)}
                                        onDragEnd={handleDragEnd}
                                        onDragOver={(e) => handleRowDragOver(e, obj.id)}
                                        onDrop={(e) => handleRowDrop(e, obj.id)}
                                        onClick={(e) => handleRowClick(e, obj.id)}
                                        style={{ paddingLeft: 4 + depth * 12 }}
                                        className={`
                                            group flex items-center gap-1.5 pr-2 py-1.5 rounded cursor-pointer transition-all border select-none
                                            ${rowDrop
                                                ? (rowDrop.valid ? 'border-green-500/60 bg-green-900/20 text-white' : 'border-red-500/40 text-gray-400')
                                                : isSelected
                                                    ? `bg-blue-900/30 ${isPrimary ? 'border-blue-500/50' : 'border-blue-500/20'} text-white`
                                                    : 'border-transparent text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                                            }
                                            ${isDragged ? 'opacity-50' : ''}
                                            ${searchMatch ? '' : 'opacity-60'}
                                        `}
                                        title="Ctrl/Cmd+click: toggle | Shift+click: range | Drag onto an object: parent | Double-click: rename"
                                    >
                                        {hasChildren ? (
                                            <button
                                                onClick={(e) => { e.stopPropagation(); toggleCollapsed(obj.id); }}
                                                className="p-0.5 rounded text-gray-500 hover:text-white shrink-0"
                                                title={isCollapsed ? 'Expand' : 'Collapse'}
                                                aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                                            >
                                                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                                            </button>
                                        ) : (
                                            <span className="w-4 shrink-0" />
                                        )}

                                        <span className="shrink-0">
                                            {isSpawner ? <Skull size={14} className="text-red-400" /> :
                                             isAudio ? <Music size={14} className="text-amber-400" /> :
                                             isSky ? <Sun size={14} className="text-cyan-400" /> :
                                             isPlayerStart ? <PersonStanding size={14} className="text-green-400" /> :
                                             <Box size={14} className={isSelected ? "text-blue-400" : "text-gray-600"} />}
                                        </span>

                                        {isEditing ? (
                                            <input
                                                autoFocus
                                                value={editingName}
                                                onChange={(e) => setEditingName(e.target.value)}
                                                onFocus={(e) => e.target.select()}
                                                onClick={(e) => e.stopPropagation()}
                                                onDoubleClick={(e) => e.stopPropagation()}
                                                onKeyDown={(e) => {
                                                    e.stopPropagation();
                                                    if (e.key === 'Enter') commitRename();
                                                    else if (e.key === 'Escape') cancelRename();
                                                }}
                                                onBlur={commitRename}
                                                className="flex-1 min-w-0 bg-gray-950 border border-blue-500 rounded px-1 py-0 text-xs text-white focus:outline-none"
                                                aria-label="Object name"
                                            />
                                        ) : (
                                            <span
                                                className="text-xs truncate flex-1 font-medium"
                                                onDoubleClick={(e) => { e.stopPropagation(); beginRename(obj); }}
                                            >
                                                {objectDisplayName(obj)}
                                            </span>
                                        )}

                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleFocus(obj.id); }}
                                            className={`p-1 rounded hover:text-white ${isPrimary ? 'text-blue-300' : 'text-gray-600 opacity-0 group-hover:opacity-100'}`}
                                            title="Focus Object"
                                        >
                                            <Crosshair size={12} />
                                        </button>

                                        <button
                                            onClick={async (e) => {
                                                e.stopPropagation();
                                                if (await appConfirm(`Delete "${obj.name}"?`, { acceptLabel: 'Delete', danger: true })) removeLevelObject(obj.id);
                                            }}
                                            className="p-1 rounded text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                            title="Delete Object"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Root drop zone: dropping here (or on empty list space) unparents the dragged objects. */}
                        {draggingIds.length > 0 && (
                            <div className={`mt-1 flex items-center justify-center gap-1.5 rounded border border-dashed py-2 text-2xs ${isRootDropActive ? 'border-green-500/60 text-green-300' : 'border-gray-700 text-gray-500'}`}>
                                <CornerLeftUp size={10} /> Drop here to move to root
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Prefabs (outliner tab), below the scrolling tree */}
            {activeTab === 'outliner' && (
                <div className="h-56 shrink-0 border-t border-gray-800 flex flex-col min-h-0">
                    <PrefabPanel
                        selectedObjectIds={selectedObjectIds ?? (selectedObjectId ? [selectedObjectId] : [])}
                        primaryObjectId={selectedObjectId}
                        placementTarget={null}
                        onPlaced={(id) => {
                            if (onSetSelection) onSetSelection([id], id);
                            else onSelectObject(id);
                        }}
                    />
                </div>
            )}

            {/* Lights and baked lighting (outliner tab) */}
            {activeTab === 'outliner' && (
                <div className="h-80 shrink-0 border-t border-gray-800 flex flex-col min-h-0">
                    <LightingPanel
                        levelId={currentLevelId}
                        selectedObjectId={selectedObjectId}
                        placementTarget={null}
                        onSelect={(id) => {
                            if (onSetSelection) onSetSelection([id], id);
                            else onSelectObject(id);
                        }}
                    />
                </div>
            )}
        </div>
    );
};
