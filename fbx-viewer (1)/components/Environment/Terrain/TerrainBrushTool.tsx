import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { castTerrainMeshes } from '../../../utils/surfacePlacement';
import { useGameContent } from '../../../runtime/GameContentContext';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { brushMask, pictureFromImage, unionRect, type TerrainBrushPicture, type TerrainBrushStamp, type TerrainGridRect } from './terrainBrush';
import { getNoRegion, hideTerrainBrush, hideTerrainRect, hideTerrainWorkingViews, showTerrainBrush, showTerrainRect, TERRAIN_BRUSH_UNIFORMS } from './terrainBrushOverlay';
import type { TerrainLiveEdit } from './terrainLiveEdit';
import { applyFlattenLayer, applyNoiseLayer, applyPaintLayer, applySmoothLayer, layerWeightNear, type TerrainWeightGrid, type WeightToolContext } from './terrainWeightTools';
import {
    applyErosion, applyFlatten, applyHoles, applyHydroErosion, applyMirror, applyNoise, applyRamp, applySculpt, applySmooth, applyTerrace,
    copyRegion, heightAt, pasteClip, slopeAt,
    type HeightToolContext, type TerrainHeightGrid,
} from './terrainSculptTools';
import { terrainToolStore, useTerrainToolState, type TerrainToolCommand, type TerrainToolSettings } from './terrainTool';

/**
 * What a TerrainObject exposes on its mesh (userData.terrainPaint) for the
 * paint brush: the live splat weights backing its layer material.
 */
export interface TerrainPaintTarget {
    columns: number;
    rows: number;
    width: number;
    depth: number;
    /** RGBA weights of layers 1 to 4, (columns * rows * 4), row-major in PlaneGeometry order. */
    weights: Uint8Array;
    /** The same for layers 5 to 8, once there are more than four. */
    weights2: Uint8Array | null;
    layerCount: number;
    /** The stored weights are still loading; painting would overwrite them. */
    pending: boolean;
    /** Each layer's name, for foliage that only grows on some. */
    layerNames: readonly string[];
    /** Upload the edited weights to the GPU. */
    markDirty(): void;
}

export const getTerrainPaintTarget = (mesh: THREE.Object3D | null | undefined): TerrainPaintTarget | null => {
    const target = mesh?.userData.terrainPaint as TerrainPaintTarget | undefined;
    return target && target.weights instanceof Uint8Array ? target : null;
};

const canPaint = (target: TerrainPaintTarget | null, layer: number): target is TerrainPaintTarget => (
    Boolean(target && !target.pending && layer >= 0 && layer < target.layerCount)
);

const liveEditOf = (mesh: THREE.Object3D | null | undefined): TerrainLiveEdit | null => (mesh?.userData.terrainEdit as TerrainLiveEdit | undefined) ?? null;

const BRUSH_COLOUR = '#ffb454';
const INVERT_COLOUR = '#ff6b5e';
const OFF_COLOUR = '#7a8088';

/** Fraction of the brush's radius between applications along a fast stroke. */
const STROKE_SPACING = 0.25;
const MAX_STROKE_STEPS = 16;
/** Longest time one frame counts for: a hitch must not make a stroke jump. */
const MAX_FRAME_TIME = 0.05;
const REFRESH_INTERVAL = 0.5;
/** How fast the Region tool chooses ground at full strength: the whole way in about a tenth of a second. */
const REGION_SPEED = 10;

const isTyping = (target: EventTarget | null): boolean => {
    const element = target as HTMLElement | null;
    return Boolean(element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable));
};

/** The picture of a stamp or pattern brush, once it has loaded. */
const useBrushPicture = (url: string | undefined): TerrainBrushPicture | null => {
    const [loaded, setLoaded] = useState<{ url: string; picture: TerrainBrushPicture } | null>(null);
    useEffect(() => {
        if (!url) return;
        let active = true;
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => { if (active) setLoaded({ url, picture: pictureFromImage(image) }); };
        image.onerror = (error) => frontendDiagnostics.failure('terrain_brush_picture_failed', error);
        image.src = url;
        return () => { active = false; };
    }, [url]);
    return url && loaded?.url === url ? loaded.picture : null;
};

interface TerrainBrushToolProps {
    settings: TerrainToolSettings;
    onSettingsChange: (settings: TerrainToolSettings) => void;
    enabled: boolean;
    /** A stroke ended: the terrain's new heights, and the ones it had. */
    onHeightsCommit: (objectId: string, heights: number[], before: Float32Array | null) => void;
    /** A paint stroke ended: the terrain's splat weights (0-255 RGBA per sample) and, past four layers, its second map's. */
    onPaintCommit: (objectId: string, splat: number[], splat2: number[] | undefined) => void;
    /** A holes stroke ended: the cells cut out, or undefined when none are. */
    onHolesCommit: (objectId: string, holes: number[] | undefined) => void;
    /** The first edit of a stroke, before it is committed (take an undo snapshot). */
    onStrokeStart: () => void;
    /** The brush moved onto this terrain, or a stroke began on it: it becomes the one the panel shows. */
    onTerrainTouched: (objectId: string) => void;
}

interface Stroke {
    mesh: THREE.Mesh;
    live: TerrainLiveEdit;
    changed: boolean;
    dirty: TerrainGridRect | null;
    flattenTarget: number;
    flattenSlope: { x: number; y: number };
    origin: THREE.Vector3;
    /** A press with the region tool: where the drag began. */
    regionStart: THREE.Vector3 | null;
    /** The layer's weight under the first click, for the paint Flatten tool. */
    weightTarget: number;
    /** The heights when the stroke began: what stands on the ground moves with the change. */
    before: Float32Array | null;
}

const _scale = new THREE.Vector3();
const _step = new THREE.Vector3();

/**
 * The brush of the Terrain tool, in the viewport: finds the ground under the pointer, draws the brush
 * on it, and while the left button is held runs the tool every frame. A stroke edits the terrain's
 * live heights and reaches the level as one undo step when the button comes up.
 */
export const TerrainBrushTool: React.FC<TerrainBrushToolProps> = ({
    settings,
    onSettingsChange,
    enabled,
    onHeightsCommit,
    onPaintCommit,
    onHolesCommit,
    onStrokeStart,
    onTerrainTouched,
}) => {
    const { camera, raycaster, pointer, scene, gl, events } = useThree();
    const { textures } = useGameContent();
    const toolState = useTerrainToolState();

    const pictureUrl = useMemo(
        () => (settings.shape !== 'circle' && settings.pictureTextureId ? textures.find(texture => texture.id === settings.pictureTextureId)?.url : undefined),
        [settings.shape, settings.pictureTextureId, textures],
    );
    const picture = useBrushPicture(pictureUrl);

    const meshes = useRef<THREE.Mesh[]>([]);
    const sinceRefresh = useRef(Infinity);
    /** A stroke works on every terrain the brush reaches: the one pressed on comes first. */
    const stroke = useRef<Stroke[] | null>(null);
    const strokeWorld = useRef(new THREE.Vector3());
    const snapshotTaken = useRef(false);
    const shiftHeld = useRef(false);
    const pressedAt = useRef<{ pressure: number }>({ pressure: 1 });
    const hoverPoint = useRef<THREE.Vector3 | null>(null);
    const hoverMesh = useRef<THREE.Mesh | null>(null);
    const rampMarkers = useRef<THREE.Group>(null);

    // Input handlers are bound once per canvas; they read the latest props here.
    const latest = useRef({ settings, onSettingsChange, onHeightsCommit, onPaintCommit, onHolesCommit, onStrokeStart, onTerrainTouched, enabled, toolState });
    latest.current = { settings, onSettingsChange, onHeightsCommit, onPaintCommit, onHolesCommit, onStrokeStart, onTerrainTouched, enabled, toolState };

    const stampAt = (mesh: THREE.Mesh, x: number, y: number): TerrainBrushStamp => {
        mesh.getWorldScale(_scale);
        const scaleX = Math.max(1e-6, _scale.x);
        const scaleY = Math.max(1e-6, _scale.y);
        const { radius, falloff, falloffType, shape, pictureRotation, patternSize, regionLimit, regionInvert, tab, tool } = latest.current.settings;
        const limited = regionLimit && terrainToolStore.get().hasRegion && !(tab === 'sculpt' && tool === 'region');
        return {
            x, y,
            region: limited ? { data: liveEditOf(mesh)?.regionData ?? null, invert: regionInvert } : null,
            radiusX: radius / scaleX,
            radiusY: radius / scaleY,
            falloff, falloffType,
            shape: picture ? shape : 'circle',
            picture,
            rotation: pictureRotation,
            patternSize: patternSize / scaleX,
        };
    };

    const contextFor = (active: Stroke, x: number, y: number, dt: number, invert: boolean): HeightToolContext => {
        active.mesh.getWorldScale(_scale);
        const { strength } = latest.current.settings;
        return {
            grid: active.live,
            stamp: stampAt(active.mesh, x, y),
            strength: strength * pressedAt.current.pressure,
            dt,
            invert,
            metres: 1 / Math.max(1e-6, _scale.z),
        };
    };

    /** One application of the current tool at a plane-local point. */
    const applyTool = (active: Stroke, x: number, y: number, dt: number, invert: boolean): TerrainGridRect | null => {
        const current = latest.current.settings;
        const context = contextFor(active, x, y, dt, invert);
        const grid = context.grid;
        switch (current.tool) {
            case 'sculpt': return applySculpt(context);
            case 'smooth': return applySmooth(context, current.smoothKernel);
            case 'flatten': {
                if (current.flattenEachMoment && !current.flattenUseHeight) active.flattenTarget = heightAt(grid, x, y);
                return applyFlatten(context, {
                    mode: current.flattenMode,
                    target: active.flattenTarget,
                    slopeX: current.flattenAlongSlope ? active.flattenSlope.x : 0,
                    slopeY: current.flattenAlongSlope ? active.flattenSlope.y : 0,
                    originX: active.origin.x,
                    originY: active.origin.y,
                });
            }
            case 'erosion': return applyErosion(context, {
                threshold: current.erosionThreshold, thickness: current.erosionThickness, iterations: current.erosionIterations,
            });
            case 'hydro': return applyHydroErosion(context, {
                rain: current.hydroRain, sediment: current.hydroSediment, iterations: current.hydroIterations,
            });
            case 'noise': return applyNoise(context, current.noiseScale, current.noiseMode);
            case 'terrace': return applyTerrace(context, current.terraceHeight, current.terraceSharpness);
            default: return null;
        }
    };

    const noteChange = (active: Stroke) => {
        active.changed = true;
        if (snapshotTaken.current) return;
        snapshotTaken.current = true;
        latest.current.onStrokeStart();
    };

    const commitStroke = (active: Stroke) => {
        if (!active.changed) return;
        const objectId = active.mesh.userData.levelObjectId as string;
        if (latest.current.settings.tab === 'paint') {
            const target = getTerrainPaintTarget(active.mesh);
            if (target && !target.pending) {
                latest.current.onPaintCommit(objectId, Array.from(target.weights), target.weights2 ? Array.from(target.weights2) : undefined);
            }
            return;
        }
        if (latest.current.settings.tool === 'holes') {
            const holes = active.live.holesForLevel();
            active.live.committedHoles = holes ?? null;
            active.live.writeHoleIndices();
            latest.current.onHolesCommit(objectId, holes);
            return;
        }
        active.live.settle();
        const heights = Array.from(active.live.heights);
        // The level will hand these same heights back: the mesh already shows them.
        active.live.committed = heights;
        latest.current.onHeightsCommit(objectId, heights, active.before);
    };

    const applyOnce = (mesh: THREE.Mesh, run: (grid: TerrainHeightGrid, live: TerrainLiveEdit) => TerrainGridRect | null) => {
        const live = liveEditOf(mesh);
        if (!live || mesh.userData.heightsPending) return;
        latest.current.onStrokeStart();
        const before = live.heights.slice();
        const rect = run(live, live);
        if (rect) live.writeRegion(rect);
        live.settle();
        const heights = Array.from(live.heights);
        live.committed = heights;
        latest.current.onHeightsCommit(mesh.userData.levelObjectId as string, heights, before);
    };

    const meshOf = (terrainId: string): THREE.Mesh | null => {
        return meshes.current.find(mesh => mesh.userData.levelObjectId === terrainId) ?? null;
    };

    const collectMeshes = () => {
        const found: THREE.Mesh[] = [];
        scene.traverse((child) => {
            if ((child as THREE.Mesh).isMesh && child.userData.terrainEdit) found.push(child as THREE.Mesh);
        });
        meshes.current = found;
        noteRegions();
    };

    /** The terrains can change under the tool, and a region goes with its terrain. */
    const noteRegions = () => {
        const hasRegion = meshes.current.some(mesh => liveEditOf(mesh)?.regionData);
        if (hasRegion !== terrainToolStore.get().hasRegion) terrainToolStore.set({ hasRegion });
    };

    // One-off actions from the panel.
    useEffect(() => {
        const handle = (command: TerrainToolCommand) => {
            collectMeshes();
            const current = latest.current.settings;
            const state = terrainToolStore.get();
            if (command.kind === 'ramp') {
                const { rampStart, rampEnd } = state;
                if (!rampStart || !rampEnd) return;
                const mesh = hoverMesh.current ?? meshes.current[0];
                if (!mesh) return;
                const a = mesh.worldToLocal(new THREE.Vector3(rampStart.x, rampStart.y, rampStart.z));
                const b = mesh.worldToLocal(new THREE.Vector3(rampEnd.x, rampEnd.y, rampEnd.z));
                mesh.getWorldScale(_scale);
                const width = current.rampWidth / Math.max(1e-6, (_scale.x + _scale.y) / 2);
                applyOnce(mesh, grid => applyRamp(grid, {
                    start: { x: a.x, y: a.y, z: a.z }, end: { x: b.x, y: b.y, z: b.z }, width, sideFalloff: current.rampSideFalloff,
                }));
                terrainToolStore.set({ rampStart: null, rampEnd: null });
            } else if (command.kind === 'mirror') {
                const mesh = meshOf(command.terrainId);
                if (!mesh) return;
                mesh.getWorldScale(_scale);
                const lengthwise = current.mirrorOperation.startsWith('x');
                const scale = Math.max(1e-6, lengthwise ? _scale.x : _scale.y);
                applyOnce(mesh, grid => applyMirror(grid, current.mirrorOperation, current.mirrorOffset / scale, current.mirrorBlend / scale));
            } else if (command.kind === 'copy') {
                const { region } = state;
                if (!region) return;
                const mesh = meshOf(region.terrainId);
                const live = liveEditOf(mesh);
                if (!mesh || !live) return;
                mesh.getWorldScale(_scale);
                const a = mesh.worldToLocal(new THREE.Vector3(region.minX, 0, region.minZ));
                const b = mesh.worldToLocal(new THREE.Vector3(region.maxX, 0, region.maxZ));
                const cellX = live.width / (live.columns - 1);
                const cellY = live.depth / (live.rows - 1);
                const toColumn = (x: number) => Math.min(live.columns - 1, Math.max(0, Math.round((x + live.width / 2) / cellX)));
                const toRow = (y: number) => Math.min(live.rows - 1, Math.max(0, Math.round((live.depth / 2 - y) / cellY)));
                const rect: TerrainGridRect = {
                    c0: Math.min(toColumn(a.x), toColumn(b.x)), c1: Math.max(toColumn(a.x), toColumn(b.x)),
                    r0: Math.min(toRow(a.y), toRow(b.y)), r1: Math.max(toRow(a.y), toRow(b.y)),
                };
                if (rect.c1 - rect.c0 < 1 || rect.r1 - rect.r0 < 1) return;
                const clip = copyRegion(live, rect, 1 / Math.max(1e-6, _scale.z), _scale.x, _scale.y);
                terrainToolStore.set({ clip, pasting: true });
            } else if (command.kind === 'clear-region') {
                for (const mesh of meshes.current) liveEditOf(mesh)?.clearRegion();
                noteRegions();
            }
        };
        terrainToolStore.handleCommands(handle);
        return () => terrainToolStore.handleCommands(null);
    }, []);

    useFrame((_state, delta) => {
        if (!enabled) {
            hideTerrainBrush();
            hideTerrainWorkingViews();
            return;
        }
        sinceRefresh.current += delta;
        if (sinceRefresh.current >= REFRESH_INTERVAL || meshes.current.length === 0) {
            sinceRefresh.current = 0;
            collectMeshes();
        }

        raycaster.setFromCamera(pointer, camera);
        const hit = castTerrainMeshes(meshes.current, raycaster);
        const current = latest.current.settings;
        const strokes = stroke.current;
        const regionTool = current.tab === 'sculpt' && current.tool === 'region';
        TERRAIN_BRUSH_UNIFORMS.terrainRegionShow.value = regionTool || current.regionLimit ? 1 : 0;
        TERRAIN_BRUSH_UNIFORMS.terrainShowLayerUsage.value = current.tab === 'paint' && current.showLayerUsage ? 1 : 0;
        for (const mesh of meshes.current) {
            const uniform = (mesh.material as THREE.Material).userData.terrainRegion as THREE.IUniform<THREE.Texture> | undefined;
            if (uniform) uniform.value = liveEditOf(mesh)?.regionTexture ?? getNoRegion();
        }
        hoverPoint.current = hit ? hit.point : null;
        if (hit && !strokes && hit.mesh !== hoverMesh.current) latest.current.onTerrainTouched(hit.mesh.userData.levelObjectId as string);
        hoverMesh.current = hit ? hit.mesh : hoverMesh.current;

        if (hit) {
            const painting = current.tab === 'paint';
            const paintable = !painting || canPaint(getTerrainPaintTarget(hit.mesh), current.paintLayer);
            const editable = !hit.mesh.userData.heightsPending && paintable && (painting || regionTool || !hit.mesh.userData.terrainEditBlock);
            const colour = !editable ? OFF_COLOUR : shiftHeld.current ? INVERT_COLOUR : BRUSH_COLOUR;
            const discrete = !painting && (current.tool === 'ramp' || current.tool === 'mirror' || (current.tool === 'copy' && !toolState.pasting));
            const radius = discrete ? 0.6 : current.radius;
            const inner = discrete ? 0 : current.radius * (1 - Math.min(1, Math.max(0, current.falloff)));
            showTerrainBrush(hit.point.x, hit.point.z, radius, inner, colour);
        } else {
            hideTerrainBrush();
        }

        const regionStart = strokes?.[0]?.regionStart;
        if (regionStart && hit) {
            const b = hit.point;
            showTerrainRect(Math.min(regionStart.x, b.x), Math.min(regionStart.z, b.z), Math.max(regionStart.x, b.x), Math.max(regionStart.z, b.z));
            return;
        }

        if (!strokes || regionStart || !hit) return;

        const dt = Math.min(MAX_FRAME_TIME, delta);
        const travelled = Math.hypot(hit.point.x - strokeWorld.current.x, hit.point.z - strokeWorld.current.z);
        const steps = Math.max(1, Math.min(MAX_STROKE_STEPS, Math.ceil(travelled / Math.max(1e-6, current.radius * STROKE_SPACING))));
        const invert = shiftHeld.current;
        const painting = current.tab === 'paint';
        for (const active of strokes) {
            let dirty: TerrainGridRect | null = null;
            for (let step = 1; step <= steps; step++) {
                _step.lerpVectors(strokeWorld.current, hit.point, step / steps);
                active.mesh.worldToLocal(_step);
                if (painting) {
                    const target = getTerrainPaintTarget(active.mesh);
                    if (!canPaint(target, current.paintLayer)) break;
                    const context: WeightToolContext = {
                        grid: target,
                        stamp: stampAt(active.mesh, _step.x, _step.y),
                        layer: current.paintLayer,
                        strength: current.strength * pressedAt.current.pressure,
                        dt: dt / steps,
                        invert,
                    };
                    let modified: TerrainGridRect | null = null;
                    switch (current.paintTool) {
                        case 'paint': modified = applyPaintLayer(context, current.paintTarget); break;
                        case 'smooth': modified = applySmoothLayer(context, current.smoothKernel); break;
                        case 'flatten': modified = applyFlattenLayer(context, active.weightTarget); break;
                        case 'noise': modified = applyNoiseLayer(context, current.paintNoiseScale / Math.max(1e-6, _scale.x)); break;
                    }
                    if (modified) {
                        noteChange(active);
                        target.markDirty();
                    }
                } else if (current.tool === 'holes') {
                    if (applyHoles(active.live, stampAt(active.mesh, _step.x, _step.y), invert, (rect, weights, cut) => active.live.markHoles(rect, weights, cut))) noteChange(active);
                } else if (regionTool) {
                    const mask = brushMask(active.live, stampAt(active.mesh, _step.x, _step.y));
                    if (mask) active.live.markRegion(mask, current.strength * pressedAt.current.pressure * REGION_SPEED * (dt / steps), invert);
                } else {
                    dirty = unionRect(dirty, applyTool(active, _step.x, _step.y, dt / steps, invert));
                }
            }
            if (dirty) {
                noteChange(active);
                active.live.writeRegion(dirty);
                active.dirty = unionRect(active.dirty, dirty);
            }
        }
        strokeWorld.current.copy(hit.point);
        if (regionTool) noteRegions();
    });

    // Input
    useEffect(() => {
        // The editor's canvas takes no pointer events (pointer-events: none); input arrives on the
        // element R3F's events are connected to, the viewport's event source.
        const domElement: HTMLElement = events.connected ?? gl.domElement;

        const endStroke = () => {
            const strokes = stroke.current;
            if (!strokes) return;
            stroke.current = null;
            snapshotTaken.current = false;
            const active = strokes[0];
            if (active.regionStart) {
                const point = hoverPoint.current;
                const a = active.regionStart;
                if (point && Math.abs(point.x - a.x) > 0.01 && Math.abs(point.z - a.z) > 0.01) {
                    terrainToolStore.set({
                        region: {
                            terrainId: active.mesh.userData.levelObjectId as string,
                            minX: Math.min(a.x, point.x), minZ: Math.min(a.z, point.z),
                            maxX: Math.max(a.x, point.x), maxZ: Math.max(a.z, point.z),
                        },
                        pasting: false,
                    });
                    terrainToolStore.command({ kind: 'copy' });
                } else {
                    hideTerrainRect();
                    terrainToolStore.set({ region: null });
                }
                return;
            }
            const { tab, tool } = latest.current.settings;
            if (tab === 'sculpt' && tool === 'region') {
                for (const { live } of strokes) live.settleRegion();
                noteRegions();
                return;
            }
            strokes.forEach(commitStroke);
        };

        const handleDown = (event: PointerEvent) => {
            shiftHeld.current = event.shiftKey;
            const { enabled: isEnabled, settings: current, toolState: tool } = latest.current;
            if (!isEnabled || event.button !== 0 || event.altKey) return;
            raycaster.setFromCamera(pointer, camera);
            const hit = castTerrainMeshes(meshes.current, raycaster);
            if (!hit) return;
            const live = liveEditOf(hit.mesh);
            if (!live || hit.mesh.userData.heightsPending) return;
            const objectId = hit.mesh.userData.levelObjectId as string;
            latest.current.onTerrainTouched(objectId);
            const local = hit.mesh.worldToLocal(hit.point.clone());
            const painting = current.tab === 'paint';

            // Ctrl with Flatten takes the height under the click as the height to level to.
            if (event.ctrlKey) {
                if (!painting && current.tool === 'flatten') {
                    latest.current.onSettingsChange({ ...current, flattenHeight: hit.point.y, flattenUseHeight: true });
                }
                return;
            }

            if (!painting && current.tool === 'ramp') {
                const point = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
                if (!tool.rampStart || tool.rampEnd) terrainToolStore.set({ rampStart: point, rampEnd: null });
                else terrainToolStore.set({ rampEnd: point });
                return;
            }
            if (!painting && current.tool === 'mirror') return;
            if (!painting && current.tool === 'copy') {
                if (tool.pasting && tool.clip) {
                    hit.mesh.getWorldScale(_scale);
                    const metres = 1 / Math.max(1e-6, _scale.z);
                    const clip = tool.clip;
                    applyOnce(hit.mesh, grid => pasteClip(grid, clip, {
                        x: local.x,
                        y: local.y,
                        rotation: current.pasteRotation,
                        metresX: 1 / Math.max(1e-6, _scale.x),
                        metresY: 1 / Math.max(1e-6, _scale.y),
                        metres,
                        floor: current.pasteKeepHeight
                            ? hit.mesh.worldToLocal(new THREE.Vector3(hit.point.x, clip.base, hit.point.z)).z
                            : local.z,
                        edge: current.pasteEdge,
                        mode: current.pasteMode,
                    }));
                    return;
                }
                terrainToolStore.set({ region: null });
                stroke.current = [{
                    mesh: hit.mesh, live, changed: false, dirty: null,
                    flattenTarget: 0, flattenSlope: { x: 0, y: 0 }, origin: local.clone(),
                    regionStart: hit.point.clone(),
                    weightTarget: 0,
                    before: null,
                }];
                return;
            }

            const regionTool = !painting && current.tool === 'region';
            if (!painting && !regionTool && current.tool !== 'holes' && hit.mesh.userData.terrainEditBlock) return;
            const grid = live;
            const paintTarget = getTerrainPaintTarget(hit.mesh);
            hit.mesh.getWorldScale(_scale);
            const worldTarget = current.flattenUseHeight ? current.flattenHeight : hit.point.y;
            const flattenSlope = slopeAt(grid, local.x, local.y);
            const weightTarget = paintTarget && canPaint(paintTarget, current.paintLayer)
                ? layerWeightNear(paintTarget as TerrainWeightGrid, local.x, local.y, current.paintLayer)
                : 0;
            pressedAt.current.pressure = event.pointerType === 'pen' && event.pressure > 0 ? event.pressure : 1;
            snapshotTaken.current = false;
            strokeWorld.current.copy(hit.point);
            // Neighbouring terrains take the stroke too, so it does not stop at a seam.
            const editable = [hit.mesh, ...meshes.current.filter(mesh => mesh !== hit.mesh && !mesh.userData.heightsPending && (painting || regionTool || current.tool === 'holes' || !mesh.userData.terrainEditBlock))];
            stroke.current = editable.flatMap((mesh): Stroke[] => {
                const edit = liveEditOf(mesh);
                if (!edit) return [];
                return [{
                    mesh,
                    live: edit,
                    changed: false,
                    dirty: null,
                    flattenTarget: mesh.worldToLocal(new THREE.Vector3(hit.point.x, worldTarget, hit.point.z)).z,
                    flattenSlope,
                    origin: mesh.worldToLocal(hit.point.clone()),
                    regionStart: null,
                    weightTarget,
                    before: painting || regionTool ? null : edit.heights.slice(),
                }];
            });
        };

        const handleMove = (event: PointerEvent) => {
            shiftHeld.current = event.shiftKey;
            if (stroke.current && event.pointerType === 'pen' && event.pressure > 0) pressedAt.current.pressure = event.pressure;
        };

        const handleKey = (event: KeyboardEvent) => {
            shiftHeld.current = event.shiftKey;
            if (event.type !== 'keydown' || isTyping(event.target) || !latest.current.enabled) return;
            const current = latest.current.settings;
            const change = (changes: Partial<TerrainToolSettings>) => latest.current.onSettingsChange({ ...current, ...changes });
            // [ and ] set the size, with Shift the falloff, and , and . the strength.
            if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
                const up = event.code === 'BracketRight';
                event.preventDefault();
                if (event.shiftKey) change({ falloff: Math.min(1, Math.max(0, current.falloff + (up ? 0.05 : -0.05))) });
                else change({ radius: Math.max(0.25, Math.min(2000, current.radius * (up ? 1.1 : 1 / 1.1))) });
            } else if (event.code === 'Comma' || event.code === 'Period') {
                const up = event.code === 'Period';
                event.preventDefault();
                change({ strength: Math.min(1, Math.max(0.01, current.strength + (up ? 0.05 : -0.05))) });
            } else if (event.key === 'Escape') {
                if (terrainToolStore.get().pasting) terrainToolStore.set({ pasting: false });
                if (terrainToolStore.get().rampStart) terrainToolStore.set({ rampStart: null, rampEnd: null });
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

    // The brush leaves with the tool.
    useEffect(() => () => {
        hideTerrainBrush();
        hideTerrainRect();
        hideTerrainWorkingViews();
    }, []);

    // The picked region stays outlined while the Copy tool is up.
    useEffect(() => {
        const { region } = toolState;
        if (enabled && settings.tab === 'sculpt' && settings.tool === 'copy' && region && !toolState.pasting) {
            showTerrainRect(region.minX, region.minZ, region.maxX, region.maxZ);
        } else {
            hideTerrainRect();
        }
    }, [enabled, settings.tab, settings.tool, toolState]);

    const showRamp = enabled && settings.tab === 'sculpt' && settings.tool === 'ramp';
    const rampLine = useMemo(() => {
        const { rampStart, rampEnd } = toolState;
        if (!rampStart || !rampEnd) return null;
        const geometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(rampStart.x, rampStart.y + 0.1, rampStart.z),
            new THREE.Vector3(rampEnd.x, rampEnd.y + 0.1, rampEnd.z),
        ]);
        return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: BRUSH_COLOUR, depthTest: false, transparent: true }));
    }, [toolState.rampStart, toolState.rampEnd]);
    useEffect(() => () => {
        rampLine?.geometry.dispose();
        (rampLine?.material as THREE.Material | undefined)?.dispose();
    }, [rampLine]);

    return (
        <group ref={rampMarkers} userData={{ ignorePlacement: true }}>
            {showRamp && toolState.rampStart && (
                <mesh position={[toolState.rampStart.x, toolState.rampStart.y, toolState.rampStart.z]} raycast={() => undefined} renderOrder={999}>
                    <sphereGeometry args={[0.5, 16, 12]} />
                    <meshBasicMaterial color={BRUSH_COLOUR} depthTest={false} transparent toneMapped={false} />
                </mesh>
            )}
            {showRamp && toolState.rampEnd && (
                <mesh position={[toolState.rampEnd.x, toolState.rampEnd.y, toolState.rampEnd.z]} raycast={() => undefined} renderOrder={999}>
                    <sphereGeometry args={[0.5, 16, 12]} />
                    <meshBasicMaterial color={BRUSH_COLOUR} depthTest={false} transparent toneMapped={false} />
                </mesh>
            )}
            {showRamp && rampLine && <primitive object={rampLine} />}
        </group>
    );
};
