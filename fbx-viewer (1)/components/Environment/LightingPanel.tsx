import React, { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Lightbulb, Flashlight, Plus, Power } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import type { LevelComponent, LevelObject } from '../../types';
import { createComponent, getComponentDefinition } from '../../runtime/components/registry';
import { editorSession } from '../../utils/editorSession';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { ScrubbableInput } from '../UI/Properties/ScrubbableInput';
import { BakedLightingSection } from './BakedLightingSection';

type Vec3 = [number, number, number];

/** Component types this panel creates and lists. */
export type LightKind = 'pointLight' | 'spotLight';

const LIGHT_KINDS: readonly LightKind[] = ['pointLight', 'spotLight'];

const LIGHT_LABELS: Record<LightKind, string> = { pointLight: 'Point Light', spotLight: 'Spot Light' };

/**
 * Height above the placement point. A light at the camera target would sit in the floor; a spot
 * shines down its local -Y, so it goes higher to light a useful patch of ground.
 */
const LIGHT_LIFT: Record<LightKind, number> = { pointLight: 2, spotLight: 4 };

const ORIGIN: Vec3 = [0, 0, 0];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const isLightKind = (type: string): type is LightKind => (LIGHT_KINDS as readonly string[]).includes(type);

export interface LevelLight {
    object: LevelObject;
    component: LevelComponent;
}

/** Every light component on objects of `levelId`, in level order (an object may carry several). */
export const collectLevelLights = (objects: readonly LevelObject[], levelId: string | null): LevelLight[] => {
    if (!levelId) return [];
    const lights: LevelLight[] = [];
    for (const object of objects) {
        if (object.levelId !== levelId) continue;
        for (const component of object.components ?? []) {
            if (isLightKind(component.type)) lights.push({ object, component });
        }
    }
    return lights;
};

/** `base`, or `base N` with the smallest N >= 2 that no object in `objects` is already named. */
export const nextLightName = (objects: readonly LevelObject[], base: string): string => {
    const used = new Set(objects.map(object => object.name));
    if (!used.has(base)) return base;
    let index = 2;
    while (used.has(`${base} ${index}`)) index += 1;
    return `${base} ${index}`;
};

/**
 * A new root object for the level add API: an empty prop (no model) carrying one light component
 * at its defaults, placed above `target` (the origin when there is none).
 */
export const createLightObject = (
    kind: LightKind,
    levelId: string,
    existing: readonly LevelObject[],
    target?: Vec3 | null,
): LevelObject => {
    const [x, y, z] = target ?? ORIGIN;
    return {
        id: crypto.randomUUID(),
        levelId,
        modelId: '',
        name: nextLightName(existing.filter(object => object.levelId === levelId), LIGHT_LABELS[kind]),
        type: 'prop',
        position: [x, y + LIGHT_LIFT[kind], z],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        parentId: null,
        components: [createComponent(kind)],
    };
};

/** `object`'s components with `changes` merged into the one with `componentId`. */
export const withComponentChanges = (
    object: LevelObject,
    componentId: string,
    changes: Partial<Omit<LevelComponent, 'id' | 'type'>>,
): LevelComponent[] =>
    (object.components ?? []).map(component => component.id === componentId ? { ...component, ...changes } : component);

const schemaFor = (type: string, key: string) =>
    getComponentDefinition(type)?.props.find(prop => prop.key === key);

const readIntensity = (component: LevelComponent): number => {
    const value = component.props.intensity;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const fallback = schemaFor(component.type, 'intensity')?.default;
    return typeof fallback === 'number' ? fallback : 0;
};

const clampIntensity = (type: string, value: number): number => {
    const schema = schemaFor(type, 'intensity');
    return Math.min(schema?.max ?? Infinity, Math.max(schema?.min ?? 0, value));
};

const readColor = (component: LevelComponent): string => {
    const value = component.props.color;
    if (typeof value === 'string' && HEX_COLOR.test(value)) return value;
    const fallback = schemaFor(component.type, 'color')?.default;
    return typeof fallback === 'string' && HEX_COLOR.test(fallback) ? fallback : '#ffffff';
};

const isTextEntry = (target: EventTarget | null) => {
    const element = target as HTMLElement | null;
    if (!element) return false;
    if (element.tagName === 'TEXTAREA' || element.isContentEditable) return true;
    return element.tagName === 'INPUT' && ['text', 'number', 'search'].includes((element as HTMLInputElement).type);
};

interface LightingPanelProps {
    /** Level whose lights are listed; adding is only offered while it is the open level. */
    levelId: string | null;
    /** Called with an object id when a light is added or its row is clicked. */
    onSelect: (id: string) => void;
    /** Where new lights go (e.g. the viewport camera target); defaults to the origin. */
    placementTarget?: Vec3 | null;
    /** Highlights the row of the selected object. */
    selectedObjectId?: string | null;
}

/**
 * Sidebar panel for level lighting: add point/spot lights (empty props with a light component)
 * and tweak each light's colour, intensity and on/off state without opening the inspector.
 */
export const LightingPanel: React.FC<LightingPanelProps> = ({ levelId, onSelect, placementTarget, selectedObjectId }) => {
    const { levelObjects, currentLevelId, addLevelObjects, updateLevelObject, snapshotHistory } = useScene();
    const session = useSyncExternalStore(editorSession.subscribe, editorSession.getSnapshot, editorSession.getSnapshot);
    const [isAdding, setIsAdding] = useState(false);
    // One undo snapshot per gesture (scrub drag, colour picking, a typing session), as in the inspector.
    const armedRef = useRef(true);

    const lights = useMemo(() => collectLevelLights(levelObjects, levelId), [levelObjects, levelId]);
    const lightCountByObject = useMemo(() => {
        const counts = new Map<string, number>();
        for (const { object } of lights) counts.set(object.id, (counts.get(object.id) ?? 0) + 1);
        return counts;
    }, [lights]);

    const isOpenLevel = Boolean(levelId) && levelId === currentLevelId && session.phase === 'ready' && session.levelId === levelId;
    const canAdd = isOpenLevel && !isAdding;

    const handleAdd = async (kind: LightKind) => {
        if (!canAdd || !levelId || !editorSession.captureReady()) return;
        const object = createLightObject(kind, levelId, levelObjects, placementTarget);
        setIsAdding(true);
        try {
            const [id] = await addLevelObjects([object]);
            if (id) onSelect(id);
        } catch (error) {
            // A failed write has already been reported to the user by the level add API.
            frontendDiagnostics.failure('light_add_failed', error);
        } finally {
            setIsAdding(false);
        }
    };

    const applyChanges = (
        light: LevelLight,
        changes: Partial<Omit<LevelComponent, 'id' | 'type'>>,
        continuous: boolean,
    ) => {
        if (!isOpenLevel || !editorSession.captureReady()) return;
        try {
            if (!continuous || armedRef.current) snapshotHistory();
            armedRef.current = false;
            updateLevelObject(light.object.id, { components: withComponentChanges(light.object, light.component.id, changes) });
        } catch (error) {
            frontendDiagnostics.failure('light_edit_failed', error);
        }
    };

    const setProp = (light: LevelLight, key: string, value: unknown) =>
        applyChanges(light, { props: { ...light.component.props, [key]: value } }, true);

    const arm = () => { armedRef.current = true; };

    return (
        <div
            className="flex flex-col h-full min-h-0"
            onPointerDownCapture={arm}
            onFocusCapture={arm}
            onKeyDownCapture={(event) => { if (!isTextEntry(event.target)) arm(); }}
        >
            <div className="flex items-center justify-between p-3 border-b border-gray-800 bg-gray-950 shrink-0">
                <span className="text-xs font-bold text-gray-300 flex items-center gap-2">
                    <Lightbulb size={14} className="text-amber-400" /> Lights
                    <span className="text-[10px] font-normal text-gray-500">{lights.length}</span>
                </span>
                <div className="flex items-center gap-1">
                    {LIGHT_KINDS.map(kind => (
                        <button
                            key={kind}
                            onClick={() => void handleAdd(kind)}
                            disabled={!canAdd}
                            className="flex items-center gap-1 px-1.5 py-1 rounded text-[10px] font-bold uppercase text-amber-300 hover:text-white hover:bg-amber-700 disabled:text-gray-600 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                            title={isOpenLevel
                                ? `Add a ${LIGHT_LABELS[kind].toLowerCase()} ${placementTarget ? 'above the camera target' : 'above the origin'}`
                                : 'Open this level to add lights'}
                            aria-label={`Add ${LIGHT_LABELS[kind]}`}
                        >
                            <Plus size={10} /> {kind === 'pointLight' ? 'Point' : 'Spot'}
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
                {lights.length === 0 && (
                    <div className="text-[11px] text-gray-500 text-center py-6 px-2">
                        No lights in this level. Add a point or spot light above.
                    </div>
                )}
                {lights.map((light) => {
                    const { object, component } = light;
                    const kind = component.type as LightKind;
                    const Icon = kind === 'spotLight' ? Flashlight : Lightbulb;
                    const color = readColor(component);
                    const intensity = readIntensity(component);
                    const shared = (lightCountByObject.get(object.id) ?? 0) > 1;
                    const isSelected = selectedObjectId === object.id;
                    const name = object.name || LIGHT_LABELS[kind];
                    return (
                        <div
                            key={`${object.id}:${component.id}`}
                            className={`px-2 py-1.5 rounded border space-y-1 ${isSelected ? 'bg-gray-800 border-amber-600/60' : 'bg-gray-800/40 border-transparent hover:bg-gray-800 hover:border-gray-700'}`}
                        >
                            <div className="flex items-center gap-2">
                                <Icon size={12} className="shrink-0" style={{ color: component.enabled ? color : undefined }} />
                                <button
                                    onClick={() => onSelect(object.id)}
                                    className={`flex-1 min-w-0 text-left text-xs truncate ${component.enabled ? 'text-gray-200' : 'text-gray-500'} hover:text-white`}
                                    title={`Select ${name}`}
                                >
                                    {name}
                                    {shared && <span className="text-[10px] text-gray-500"> ({LIGHT_LABELS[kind]})</span>}
                                </button>
                                <button
                                    onClick={() => applyChanges(light, { enabled: !component.enabled }, false)}
                                    disabled={!isOpenLevel}
                                    className={`p-1 rounded transition-colors disabled:cursor-not-allowed ${component.enabled ? 'text-amber-300 hover:bg-gray-700' : 'text-gray-600 hover:text-gray-300 hover:bg-gray-700'}`}
                                    title={component.enabled ? 'Turn light off' : 'Turn light on'}
                                    aria-label={`${component.enabled ? 'Turn off' : 'Turn on'} ${name}`}
                                    aria-pressed={component.enabled}
                                >
                                    <Power size={11} />
                                </button>
                            </div>
                            <div className="flex items-center gap-2">
                                <input
                                    type="color"
                                    value={color}
                                    disabled={!isOpenLevel}
                                    onChange={(e) => {
                                        const next = e.target.value;
                                        if (HEX_COLOR.test(next) && next.toLowerCase() !== color.toLowerCase()) setProp(light, 'color', next);
                                    }}
                                    className="w-8 h-5 bg-transparent border-none p-0 cursor-pointer shrink-0 disabled:cursor-not-allowed"
                                    title="Light colour"
                                    aria-label={`${name} colour`}
                                />
                                <div className="flex-1 min-w-0">
                                    <ScrubbableInput
                                        label="Int"
                                        labelWidth="w-7"
                                        value={intensity}
                                        step={1}
                                        onChange={(value) => {
                                            if (!Number.isFinite(value) || !isOpenLevel) return;
                                            const next = clampIntensity(component.type, value);
                                            if (next !== intensity) setProp(light, 'intensity', next);
                                        }}
                                    />
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
            <BakedLightingSection levelId={levelId} />
        </div>
    );
};
