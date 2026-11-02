import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { TransformControls } from '@react-three/drei';
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js';
import type { LevelObject } from '../../../types';
import {
    editFoliageInstances, FOLIAGE_INSTANCE_FLOATS, foliageInstanceCount, foliageInstanceMatrix, isFoliageTypePending, MAX_FOLIAGE_INSTANCES,
    writeFoliageMatrix, type FoliageType,
} from '../../../runtime/foliage';
import type { FoliageViews, FoliageTypeView } from '../../../runtime/foliageLayer';
import { createPlacementQuery, type PlacementHit, type PlacementQuery } from '../../../utils/surfacePlacement';
import { gizmoPointer } from '../gizmoPointer';
import { hideTerrainBrush, showTerrainBrush } from '../Terrain/terrainBrushOverlay';
import { layerWeightNear } from '../Terrain/terrainWeightTools';
import type { TerrainPaintTarget } from '../Terrain/TerrainBrushTool';
import type { TransformSettings } from '../types';
import { foliageFits, foliageHashOf, instancesWanted, placeFoliageInstance, type FoliageGround, type FoliageHash } from './foliagePlacement';
import { foliageToolStore, useFoliageToolState, type FoliageToolCommand, type FoliageToolSettings } from './foliageSettings';

const PAINT_COLOUR = '#5fd38a';
const ERASE_COLOUR = '#ff6b5e';
const OTHER_COLOUR = '#ffb454';
/** Most instances one type gains in a frame: a large brush fills over a few frames rather than stalling one. */
const MAX_PER_FRAME = 400;
const CURSOR_LIFT = 0.05;

const _down = new THREE.Vector3(0, -1, 0);
const _origin = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _matrix = new THREE.Matrix4();
const _delta = new THREE.Matrix4();
const _closest = new THREE.Vector3();
const _centre = new THREE.Vector3();

const isTyping = (target: EventTarget | null): boolean => {
    const element = target as HTMLElement | null;
    return Boolean(element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable));
};

/** What a stroke has done to one type so far. */
interface TypeStroke {
    hash: FoliageHash;
    nextId: number;
    baseCount: number;
    added: number[];
    removed: Set<number>;
    reapplied: Set<number>;
}

interface FoliageToolProps {
    settings: FoliageToolSettings;
    onSettingsChange: (settings: FoliageToolSettings) => void;
    set: LevelObject | null;
    levelObjects: LevelObject[];
    transformSettings: TransformSettings;
    enabled: boolean;
    /** Runs before an edit changes the level (the undo snapshot). */
    onSnapshot: () => void;
    /** A stroke or action ended: the set's types with their new instances. */
    onTypesChange: (types: FoliageType[]) => void;
}

/**
 * The Foliage tool in the viewport: the brush, and painting, erasing, reapplying, placing, filling and
 * selecting instances. A stroke draws its changes as it goes and reaches the level as one undo step when
 * the button comes up.
 */
export const FoliageTool: React.FC<FoliageToolProps> = ({
    settings, onSettingsChange, set, levelObjects, transformSettings, enabled, onSnapshot, onTypesChange,
}) => {
    const { camera, raycaster, pointer, scene, gl, events } = useThree();
    const toolState = useFoliageToolState();
    const cursorRef = useRef<THREE.Group>(null);
    const types = set?.foliageData?.types;

    const latest = useRef({ settings, onSettingsChange, types, onSnapshot, onTypesChange, enabled, levelObjects, set });
    latest.current = { settings, onSettingsChange, types, onSnapshot, onTypesChange, enabled, levelObjects, set };

    const stroking = useRef(false);
    const shiftHeld = useRef(false);
    const strokes = useRef(new Map<string, TypeStroke>());
    const lasso = useRef<{ remove: boolean } | null>(null);
    const sampleRaycaster = useMemo(() => new THREE.Raycaster(), []);
    const singleCycle = useRef(0);

    const viewsOf = (): FoliageViews | null => {
        let views: FoliageViews | null = null;
        scene.traverse((node) => {
            if (!views && node.userData?.foliageViews) views = node.userData.foliageViews as FoliageViews;
        });
        return views;
    };

    const querySurfaces = (): PlacementQuery => {
        const current = latest.current.settings;
        return createPlacementQuery(scene, latest.current.levelObjects, {
            ignore: cursorRef.current ? [cursorRef.current] : [],
            groundPlane: false,
            terrain: current.onTerrain,
            meshes: current.onMeshes,
            foliage: current.onFoliage,
            translucent: current.onTranslucent,
        });
    };

    /** The ground at a placement hit, with the terrain layers there if it is a terrain. */
    const groundOf = (hit: PlacementHit): FoliageGround => {
        const paint = hit.object?.userData?.terrainPaint as (TerrainPaintTarget & { layerNames?: readonly string[] }) | undefined;
        if (!paint || !hit.object) return { point: hit.point, normal: hit.normal };
        const local = hit.object.worldToLocal(hit.point.clone());
        return {
            point: hit.point,
            normal: hit.normal,
            layerWeight: (name) => {
                const layer = paint.layerNames?.indexOf(name) ?? -1;
                return layer < 0 ? null : layerWeightNear(paint, local.x, local.y, layer);
            },
        };
    };

    const castDown = (query: PlacementQuery, x: number, y: number, z: number, reach: number): PlacementHit | null => {
        sampleRaycaster.layers.mask = raycaster.layers.mask;
        sampleRaycaster.near = 0;
        sampleRaycaster.far = reach * 2;
        _origin.set(x, y + reach, z);
        sampleRaycaster.set(_origin, _down);
        return query(sampleRaycaster);
    };

    const strokeOf = (type: FoliageType): TypeStroke => {
        let stroke = strokes.current.get(type.id);
        if (!stroke) {
            const baseCount = foliageInstanceCount(type);
            stroke = {
                hash: foliageHashOf(type.instances, Math.max(type.radius, 1)),
                nextId: baseCount,
                baseCount,
                added: [],
                removed: new Set(),
                reapplied: new Set(),
            };
            strokes.current.set(type.id, stroke);
        }
        return stroke;
    };

    const activeTypes = (): FoliageType[] => (latest.current.types ?? []).filter(type => type.active && !isFoliageTypePending(type));

    const paintAt = (point: THREE.Vector3, normal: THREE.Vector3, query: PlacementQuery, views: FoliageViews | null) => {
        const current = latest.current.settings;
        const radius = Math.max(current.radius, 0.25);
        const area = Math.PI * radius * radius;
        for (const type of activeTypes()) {
            const stroke = strokeOf(type);
            const view = views?.get(type.id);
            const wanted = instancesWanted(type.density, area, current.paintDensity, Math.random);
            const here = stroke.hash.count(point.x, point.z, radius);
            const missing = Math.min(MAX_PER_FRAME, wanted - here);
            if (missing <= 0) continue;
            _quaternion.setFromUnitVectors(_up, normal);
            let placed = 0;
            for (let attempt = 0; attempt < missing * 4 && placed < missing; attempt++) {
                if (stroke.baseCount + stroke.added.length / FOLIAGE_INSTANCE_FLOATS >= MAX_FOLIAGE_INSTANCES) break;
                const distance = radius * Math.sqrt(Math.random());
                const angle = Math.random() * Math.PI * 2;
                _offset.set(distance * Math.cos(angle), 0, distance * Math.sin(angle)).applyQuaternion(_quaternion);
                // Projected along the ground's normal under the brush, so it paints up a cliff as well as across a field.
                sampleRaycaster.layers.mask = raycaster.layers.mask;
                sampleRaycaster.near = 0;
                sampleRaycaster.far = radius * 3;
                _origin.copy(point).add(_offset).addScaledVector(normal, radius * 1.5);
                sampleRaycaster.set(_origin, _closest.copy(normal).negate());
                const hit = query(sampleRaycaster);
                if (!hit) continue;
                if (stroke.hash.occupied(hit.point.x, hit.point.z, type.radius)) continue;
                const ground = groundOf(hit);
                if (!foliageFits(type, ground)) continue;
                const start = stroke.added.length;
                const position = placeFoliageInstance(type, ground, Math.random, stroke.added);
                stroke.hash.add(stroke.nextId++, position.x, position.y, position.z);
                view?.addPending(new Float32Array(stroke.added.slice(start, start + FOLIAGE_INSTANCE_FLOATS)));
                placed++;
            }
        }
    };

    const eraseAt = (point: THREE.Vector3, views: FoliageViews | null) => {
        const current = latest.current.settings;
        const radius = Math.max(current.radius, 0.25);
        const area = Math.PI * radius * radius;
        for (const type of activeTypes()) {
            const stroke = strokeOf(type);
            const view = views?.get(type.id);
            const found: number[] = [];
            stroke.hash.near(point.x, point.z, radius, (id) => { found.push(id); });
            if (found.length === 0) continue;
            const keep = current.eraseDensity > 0 ? instancesWanted(type.density, area, current.eraseDensity, Math.random) : 0;
            let excess = found.length - keep;
            for (let pick = found.length - 1; pick >= 0 && excess > 0; pick--, excess--) {
                const other = Math.floor(Math.random() * (pick + 1));
                const id = found[other];
                found[other] = found[pick];
                stroke.hash.remove(id);
                if (id < stroke.baseCount) {
                    stroke.removed.add(id);
                    view?.hide(id);
                }
            }
        }
    };

    /** Applies each type's current rules to the instances under the brush, once each in a stroke. */
    const reapplyAt = (point: THREE.Vector3, query: PlacementQuery, views: FoliageViews | null) => {
        const radius = Math.max(latest.current.settings.radius, 0.25);
        for (const type of activeTypes()) {
            const stroke = strokeOf(type);
            const view = views?.get(type.id);
            const instances = type.instances;
            if (!instances) continue;
            const found: Array<{ id: number; x: number; y: number; z: number }> = [];
            stroke.hash.near(point.x, point.z, radius, (id, x, y, z) => {
                if (id < stroke.baseCount && !stroke.reapplied.has(id)) found.push({ id, x, y, z });
            });
            for (const { id, x, y, z } of found) {
                stroke.reapplied.add(id);
                const hit = castDown(query, x, y, z, Math.max(4, radius));
                if (!hit) continue;
                const ground = groundOf(hit);
                // Off the ground it may grow on, or now too close to one already looked at: it goes.
                stroke.hash.remove(id);
                stroke.removed.add(id);
                view?.hide(id);
                if (!foliageFits(type, ground) || stroke.hash.occupied(x, z, type.radius)) continue;
                const start = stroke.added.length;
                const position = placeFoliageInstance(type, ground, Math.random, stroke.added);
                stroke.reapplied.add(stroke.nextId);
                stroke.hash.add(stroke.nextId++, position.x, position.y, position.z);
                view?.addPending(new Float32Array(stroke.added.slice(start, start + FOLIAGE_INSTANCE_FLOATS)));
            }
        }
    };

    const lassoAt = (point: THREE.Vector3, remove: boolean) => {
        const radius = Math.max(latest.current.settings.radius, 0.25);
        const selection = new Map(foliageToolStore.get().selection);
        let changed = false;
        for (const type of activeTypes()) {
            const stroke = strokeOf(type);
            const ids = new Set(selection.get(type.id) ?? []);
            stroke.hash.near(point.x, point.z, radius, (id) => {
                if (remove ? ids.delete(id) : !ids.has(id)) {
                    if (!remove) ids.add(id);
                    changed = true;
                }
            });
            selection.set(type.id, ids);
        }
        if (changed) foliageToolStore.set({ selection });
    };

    const commitStrokes = () => {
        const { types: currentTypes } = latest.current;
        const done = strokes.current;
        strokes.current = new Map();
        if (!currentTypes) return;
        let changed = false;
        for (const stroke of done.values()) if (stroke.added.length || stroke.removed.size) changed = true;
        if (!changed) return;
        latest.current.onSnapshot();
        foliageToolStore.clearSelection();
        latest.current.onTypesChange(currentTypes.map((type) => {
            const stroke = done.get(type.id);
            if (!stroke || (!stroke.added.length && !stroke.removed.size)) return type;
            return { ...type, instances: editFoliageInstances(type.instances, stroke.removed, stroke.added) };
        }));
    };

    /** The instance under the ray: the nearest whose bounds it passes through. */
    const pick = (): { typeId: string; index: number } | null => {
        raycaster.setFromCamera(pointer, camera);
        const views = viewsOf();
        let best: { typeId: string; index: number; distance: number } | null = null;
        for (const type of latest.current.types ?? []) {
            const instances = type.instances;
            const view = views?.get(type.id);
            if (!instances || !view) continue;
            const bounds = view.modelBounds;
            const middle = bounds.getCenter(_centre);
            const size = view.modelRadius;
            const count = Math.floor(instances.length / FOLIAGE_INSTANCE_FLOATS);
            for (let index = 0; index < count; index++) {
                const at = index * FOLIAGE_INSTANCE_FLOATS;
                const scale = Math.max(instances[at + 7], instances[at + 8], instances[at + 9]);
                _origin.set(instances[at] + middle.x * scale, instances[at + 1] + middle.y * scale, instances[at + 2] + middle.z * scale);
                const along = raycaster.ray.closestPointToPoint(_origin, _closest).distanceTo(raycaster.ray.origin);
                if (_closest.distanceToSquared(_origin) > (size * scale * 0.6) ** 2) continue;
                if (!best || along < best.distance) best = { typeId: type.id, index, distance: along };
            }
        }
        return best ? { typeId: best.typeId, index: best.index } : null;
    };

    const placeSingle = (hit: PlacementHit) => {
        const active = activeTypes();
        const currentTypes = latest.current.types;
        if (active.length === 0 || !currentTypes) return;
        const type = active[singleCycle.current++ % active.length];
        const added: number[] = [];
        placeFoliageInstance(type, groundOf(hit), Math.random, added);
        latest.current.onSnapshot();
        foliageToolStore.clearSelection();
        latest.current.onTypesChange(currentTypes.map(entry => (entry.id === type.id
            ? { ...entry, instances: editFoliageInstances(entry.instances, new Set(), added) }
            : entry)));
    };

    /** Fills the whole terrain or mesh under the click at each active type's density. */
    const fill = (hit: PlacementHit) => {
        const currentTypes = latest.current.types;
        const target = hit.object as THREE.Mesh | undefined;
        if (!currentTypes || !target) return;
        const query = querySurfaces();
        const current = latest.current.settings;
        const changed = new Map<string, number[]>();
        const paint = target.userData?.terrainPaint as TerrainPaintTarget | undefined;
        for (const type of activeTypes()) {
            const stroke = strokeOf(type);
            const added: number[] = [];
            if (paint) {
                target.updateWorldMatrix(true, false);
                const scale = target.getWorldScale(new THREE.Vector3());
                const area = paint.width * scale.x * paint.depth * scale.y;
                const wanted = Math.min(MAX_FOLIAGE_INSTANCES, Math.round((type.density / 100) * area * current.paintDensity));
                for (let attempt = 0; attempt < wanted * 2 && added.length / FOLIAGE_INSTANCE_FLOATS < wanted; attempt++) {
                    _origin.set((Math.random() - 0.5) * paint.width, (Math.random() - 0.5) * paint.depth, 0);
                    target.localToWorld(_origin);
                    const below = castDown(query, _origin.x, 100000, _origin.z, 100000);
                    if (!below) continue;
                    if (stroke.hash.occupied(below.point.x, below.point.z, type.radius)) continue;
                    const ground = groundOf(below);
                    if (!foliageFits(type, ground)) continue;
                    const position = placeFoliageInstance(type, ground, Math.random, added);
                    stroke.hash.add(stroke.nextId++, position.x, position.y, position.z);
                }
            } else if (target.isMesh && !(target as unknown as THREE.InstancedMesh).isInstancedMesh && target.geometry) {
                const sampler = new MeshSurfaceSampler(target).build();
                target.updateWorldMatrix(true, false);
                const box = new THREE.Box3().setFromObject(target).getSize(new THREE.Vector3());
                const area = (box.x * box.y + box.y * box.z + box.x * box.z) * 2;
                const wanted = Math.min(MAX_FOLIAGE_INSTANCES, Math.round((type.density / 100) * area * current.paintDensity));
                const position = new THREE.Vector3();
                const normal = new THREE.Vector3();
                const normalMatrix = new THREE.Matrix3().getNormalMatrix(target.matrixWorld);
                for (let attempt = 0; attempt < wanted * 2 && added.length / FOLIAGE_INSTANCE_FLOATS < wanted; attempt++) {
                    sampler.sample(position, normal);
                    position.applyMatrix4(target.matrixWorld);
                    normal.applyMatrix3(normalMatrix).normalize();
                    if (stroke.hash.occupied(position.x, position.z, type.radius)) continue;
                    const ground: FoliageGround = { point: position.clone(), normal: normal.clone() };
                    if (!foliageFits(type, ground)) continue;
                    placeFoliageInstance(type, ground, Math.random, added);
                    stroke.hash.add(stroke.nextId++, position.x, position.y, position.z);
                }
            }
            if (added.length) changed.set(type.id, added);
        }
        strokes.current = new Map();
        if (changed.size === 0) return;
        latest.current.onSnapshot();
        foliageToolStore.clearSelection();
        latest.current.onTypesChange(currentTypes.map((type) => {
            const added = changed.get(type.id);
            return added ? { ...type, instances: editFoliageInstances(type.instances, new Set(), added) } : type;
        }));
    };

    // One-off actions from the panel.
    useEffect(() => {
        const handle = (command: FoliageToolCommand) => {
            const currentTypes = latest.current.types ?? [];
            if (command.kind === 'deselect') {
                foliageToolStore.clearSelection();
            } else if (command.kind === 'select-all') {
                const selection = new Map<string, Set<number>>();
                for (const type of activeTypes()) {
                    const count = foliageInstanceCount(type);
                    selection.set(type.id, new Set(Array.from({ length: count }, (_, index) => index)));
                }
                foliageToolStore.set({ selection });
            } else if (command.kind === 'select-invalid') {
                // Instances with nothing under them, the first thing to look for after moving the ground or what they stood on.
                const query = querySurfaces();
                const selection = new Map<string, Set<number>>();
                for (const type of activeTypes()) {
                    const instances = type.instances;
                    if (!instances) continue;
                    const ids = new Set<number>();
                    const count = Math.floor(instances.length / FOLIAGE_INSTANCE_FLOATS);
                    const slack = Math.max(Math.abs(type.zOffset[0]), Math.abs(type.zOffset[1])) + 0.5;
                    for (let index = 0; index < count; index++) {
                        const at = index * FOLIAGE_INSTANCE_FLOATS;
                        if (!castDown(query, instances[at], instances[at + 1], instances[at + 2], slack)) ids.add(index);
                    }
                    if (ids.size) selection.set(type.id, ids);
                }
                foliageToolStore.set({ selection });
            } else if (command.kind === 'remove-selected') {
                const { selection } = foliageToolStore.get();
                if (selection.size === 0) return;
                latest.current.onSnapshot();
                foliageToolStore.clearSelection();
                latest.current.onTypesChange(currentTypes.map((type) => {
                    const ids = selection.get(type.id);
                    return ids?.size ? { ...type, instances: editFoliageInstances(type.instances, ids, []) } : type;
                }));
            }
        };
        foliageToolStore.handleCommands(handle);
        return () => foliageToolStore.handleCommands(null);
    }, []);

    const cursorNormal = useRef(new THREE.Vector3(0, 1, 0));

    useFrame(() => {
        if (!enabled) {
            hideTerrainBrush();
            if (cursorRef.current) cursorRef.current.visible = false;
            return;
        }
        const current = latest.current.settings;
        raycaster.setFromCamera(pointer, camera);
        const query = querySurfaces();
        const hit = query(raycaster);
        const brushTool = current.tool === 'paint' || current.tool === 'erase' || current.tool === 'reapply' || current.tool === 'lasso';
        const erasing = current.tool === 'erase' || (current.tool === 'paint' && shiftHeld.current);
        const colour = erasing || (current.tool === 'lasso' && shiftHeld.current) ? ERASE_COLOUR : current.tool === 'paint' ? PAINT_COLOUR : OTHER_COLOUR;
        const onTerrain = Boolean(hit?.object?.userData?.terrainEdit);
        const radius = brushTool ? current.radius : 0.6;
        if (hit && onTerrain) showTerrainBrush(hit.point.x, hit.point.z, radius, 0, colour);
        else hideTerrainBrush();

        const cursor = cursorRef.current;
        if (cursor) {
            cursor.visible = Boolean(hit && !onTerrain);
            if (hit && !onTerrain) {
                cursor.position.copy(hit.point).addScaledVector(hit.normal, CURSOR_LIFT);
                cursor.quaternion.setFromUnitVectors(_up, hit.normal);
                cursor.scale.setScalar(radius);
                ((cursor.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(colour);
            }
        }
        if (hit) cursorNormal.current.copy(hit.normal);

        if (!stroking.current || !hit) return;
        const views = viewsOf();
        if (current.tool === 'paint' && !shiftHeld.current) paintAt(hit.point, hit.normal, query, views);
        else if (erasing) eraseAt(hit.point, views);
        else if (current.tool === 'reapply') reapplyAt(hit.point, query, views);
        else if (current.tool === 'lasso' && lasso.current) lassoAt(hit.point, lasso.current.remove);
    });

    // Input
    useEffect(() => {
        // The editor's canvas takes no pointer events (pointer-events: none); input arrives on the
        // element R3F's events are connected to, the viewport's event source.
        const domElement: HTMLElement = events.connected ?? gl.domElement;

        const endStroke = () => {
            if (!stroking.current) return;
            stroking.current = false;
            lasso.current = null;
            if (latest.current.settings.tool === 'lasso') strokes.current = new Map();
            else commitStrokes();
        };

        const handleDown = (event: PointerEvent) => {
            shiftHeld.current = event.shiftKey;
            const { enabled: isEnabled, settings: current } = latest.current;
            if (!isEnabled || event.button !== 0 || event.altKey || gizmoPointer.owns()) return;
            if (current.tool === 'select') {
                const found = pick();
                const previous = foliageToolStore.get().selection;
                if (!found) {
                    if (!event.ctrlKey) foliageToolStore.clearSelection();
                    return;
                }
                const selection = new Map(event.ctrlKey ? previous : []);
                const ids = new Set(selection.get(found.typeId) ?? []);
                if (event.ctrlKey && ids.has(found.index)) ids.delete(found.index);
                else ids.add(found.index);
                selection.set(found.typeId, ids);
                foliageToolStore.set({ selection, focusedTypeId: found.typeId });
                return;
            }
            if (current.tool === 'single' || current.tool === 'fill') {
                raycaster.setFromCamera(pointer, camera);
                const hit = querySurfaces()(raycaster);
                if (!hit) return;
                if (current.tool === 'single') placeSingle(hit);
                else fill(hit);
                return;
            }
            strokes.current = new Map();
            if (current.tool === 'lasso') lasso.current = { remove: event.shiftKey };
            stroking.current = true;
        };

        const handleMove = (event: PointerEvent) => { shiftHeld.current = event.shiftKey; };

        const handleKey = (event: KeyboardEvent) => {
            shiftHeld.current = event.shiftKey;
            if (event.type !== 'keydown' || isTyping(event.target) || !latest.current.enabled) return;
            const current = latest.current.settings;
            if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
                event.preventDefault();
                latest.current.onSettingsChange({ ...current, radius: Math.max(0.25, Math.min(2000, current.radius * (event.code === 'BracketRight' ? 1.1 : 1 / 1.1))) });
            } else if ((event.key === 'Delete' || event.key === 'Backspace') && foliageToolStore.get().selection.size > 0) {
                event.preventDefault();
                foliageToolStore.command({ kind: 'remove-selected' });
            } else if (event.key === 'Escape') {
                foliageToolStore.clearSelection();
            }
        };

        const handleBlur = () => {
            shiftHeld.current = false;
            endStroke();
        };

        domElement.addEventListener('pointerdown', handleDown);
        domElement.addEventListener('pointermove', handleMove);
        window.addEventListener('pointerup', endStroke);
        window.addEventListener('keydown', handleKey);
        window.addEventListener('keyup', handleKey);
        window.addEventListener('blur', handleBlur);
        return () => {
            domElement.removeEventListener('pointerdown', handleDown);
            domElement.removeEventListener('pointermove', handleMove);
            window.removeEventListener('pointerup', endStroke);
            window.removeEventListener('keydown', handleKey);
            window.removeEventListener('keyup', handleKey);
            window.removeEventListener('blur', handleBlur);
            endStroke();
        };
    }, [gl, events.connected, camera, raycaster, pointer]);

    // The brush leaves with the tool; so does the selection, which only means something here.
    useEffect(() => () => {
        hideTerrainBrush();
        foliageToolStore.clearSelection();
    }, []);

    // Selected instances, outlined, and a gizmo at their middle.
    const { selection } = toolState;
    const [proxy] = useState(() => new THREE.Object3D());
    const hasSelection = selection.size > 0 && [...selection.values()].some(ids => ids.size > 0);
    useEffect(() => {
        const views = viewsOf();
        if (!views) return;
        for (const type of types ?? []) views.get(type.id)?.showSelection(type.instances, selection.get(type.id) ?? new Set());
        if (!hasSelection) return;
        let x = 0, y = 0, z = 0, total = 0;
        for (const type of types ?? []) {
            const ids = selection.get(type.id);
            const instances = type.instances;
            if (!ids || !instances) continue;
            for (const index of ids) {
                const at = index * FOLIAGE_INSTANCE_FLOATS;
                x += instances[at];
                y += instances[at + 1];
                z += instances[at + 2];
                total++;
            }
        }
        if (total > 0) {
            proxy.position.set(x / total, y / total, z / total);
            proxy.quaternion.identity();
            proxy.scale.setScalar(1);
            proxy.updateMatrixWorld(true);
        }
    }, [selection, types, proxy, hasSelection]);

    const dragStart = useRef<{ inverse: THREE.Matrix4 } | null>(null);
    const dragViews = useRef<FoliageViews | null>(null);

    const onGizmoDown = () => {
        gizmoPointer.take();
        proxy.updateMatrixWorld(true);
        dragStart.current = { inverse: proxy.matrixWorld.clone().invert() };
        dragViews.current = viewsOf();
    };

    /** Where each selected instance goes for the gizmo's move so far. */
    const eachMoved = (visit: (type: FoliageType, view: FoliageTypeView | undefined, index: number, matrix: THREE.Matrix4) => void) => {
        if (!dragStart.current) return;
        proxy.updateMatrixWorld(true);
        _delta.multiplyMatrices(proxy.matrixWorld, dragStart.current.inverse);
        for (const type of types ?? []) {
            const ids = selection.get(type.id);
            const instances = type.instances;
            if (!ids || !instances) continue;
            const view = dragViews.current?.get(type.id);
            for (const index of ids) {
                foliageInstanceMatrix(instances, index, _matrix);
                _matrix.premultiply(_delta);
                visit(type, view, index, _matrix);
            }
        }
    };

    const onGizmoChange = () => {
        if (!dragStart.current) return;
        eachMoved((_type, view, index, matrix) => view?.move(index, matrix));
    };

    const onGizmoUp = () => {
        if (!dragStart.current || !types) return;
        const next = new Map<string, Float32Array>();
        eachMoved((type, _view, index, matrix) => {
            let instances = next.get(type.id);
            if (!instances) {
                instances = type.instances!.slice();
                next.set(type.id, instances);
            }
            writeFoliageMatrix(instances, index, matrix);
        });
        dragStart.current = null;
        if (next.size === 0) return;
        latest.current.onSnapshot();
        latest.current.onTypesChange(types.map(type => (next.has(type.id) ? { ...type, instances: next.get(type.id)! } : type)));
    };

    return (
        <>
            {/* On a mesh the brush is a ring on its surface; on a terrain it is drawn into the ground. */}
            <group ref={cursorRef} visible={false} userData={{ ignorePlacement: true }}>
                <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={() => undefined} renderOrder={999}>
                    <ringGeometry args={[0.96, 1, 64]} />
                    <meshBasicMaterial color={PAINT_COLOUR} transparent opacity={0.9} side={THREE.DoubleSide} depthTest={false} toneMapped={false} />
                </mesh>
            </group>
            {enabled && settings.tool === 'select' && hasSelection && (
                <>
                    <primitive object={proxy} />
                    <TransformControls
                        object={proxy}
                        mode={transformSettings.tool}
                        space="world"
                        onMouseDown={onGizmoDown}
                        onChange={onGizmoChange}
                        onMouseUp={onGizmoUp}
                        translationSnap={transformSettings.snapEnabled && transformSettings.tool === 'translate' ? transformSettings.snapGrid : null}
                        rotationSnap={transformSettings.snapEnabled && transformSettings.tool === 'rotate' ? THREE.MathUtils.degToRad(transformSettings.snapAngle) : null}
                        size={0.8}
                    />
                </>
            )}
        </>
    );
};
