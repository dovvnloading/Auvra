import React, { useRef, useLayoutEffect, useMemo, forwardRef, useImperativeHandle, useState, useEffect } from 'react';
import * as THREE from 'three';
import { LevelObject } from '../../../types';
import { isTerrainHeightfieldPending, terrainSamplesPerSide } from '../../../utils/terrainHeightfieldCodec';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { useGameContent } from '../../../runtime/GameContentContext';
import { raycastTerrainMesh } from '../../../utils/surfacePlacement';
import type { TerrainPaintTarget } from './TerrainBrushTool';
import { TerrainLiveEdit } from './terrainLiveEdit';
import { TerrainLodMesh } from './TerrainLodMesh';
import {
    createDefaultTerrainSplat,
    fillDefaultTerrainSplat,
    isTerrainSplatPending,
    normalizeTerrainLayers,
    type TerrainPaintState,
} from './terrainSplatCodec';
import {
    bindTerrainLayers,
    createTerrainLayerMaterial,
    createTerrainSplatTexture,
    prepareTerrainLayerTexture,
    setTerrainSplatTexture,
    createTerrainGroundMaterial,
} from './terrainLayerMaterial';

interface TerrainObjectProps {
    data: LevelObject;
    isSelected: boolean;
    visible: boolean;
    receiveShadow?: boolean;
    castShadow?: boolean;
    onClick?: (e: any) => void;
    /**
     * Draw distant parts with fewer vertices (TerrainLodMesh). Tools still edit the full-resolution
     * heights, which every chunk shares.
     */
    lod?: boolean;
}

/** Below this many cells per side one mesh is cheap enough; chunking would only add draw calls. */
const MIN_LOD_SEGMENTS = 64;

/**
 * Layer textures by URL. Each URL is loaded once and disposed when no layer
 * uses it any more (or the terrain unmounts); a layer still loading is null.
 */
const useTerrainLayerTextures = (urls: readonly (string | undefined)[]): (THREE.Texture | null)[] => {
    const cacheRef = useRef(new Map<string, THREE.Texture | null>());
    const [version, setVersion] = useState(0);
    const key = urls.map(url => url ?? '').join('\n');

    useEffect(() => {
        const cache = cacheRef.current;
        const wanted = new Set(urls.filter((url): url is string => Boolean(url)));
        for (const [url, texture] of cache) {
            if (!wanted.has(url)) {
                texture?.dispose();
                cache.delete(url);
            }
        }
        for (const url of wanted) {
            if (cache.has(url)) continue;
            cache.set(url, null);
            new THREE.TextureLoader().load(url, (texture) => {
                // The layer changed (or the terrain unmounted) while this loaded.
                if (!cache.has(url) || cache.get(url) !== null) {
                    texture.dispose();
                    return;
                }
                cache.set(url, prepareTerrainLayerTexture(texture));
                setVersion(value => value + 1);
            }, undefined, (error) => {
                frontendDiagnostics.failure('terrain_layer_texture_load_failed', error);
            });
        }
    }, [key]);

    useEffect(() => () => {
        for (const texture of cacheRef.current.values()) texture?.dispose();
        cacheRef.current.clear();
    }, []);

    // `key` stands for `urls`; `version` changes when a texture finishes loading.
    return useMemo(() => urls.map(url => (url ? cacheRef.current.get(url) ?? null : null)), [key, version]);
};

/** The terrain's edge, following the ground: how a selected terrain shows, whatever its size. */
const TerrainOutline: React.FC<{ live: TerrainLiveEdit; version: unknown }> = ({ live, version }) => {
    const line = useMemo(() => {
        const { columns, rows, width, depth, heights } = live;
        const points: number[] = [];
        const add = (column: number, row: number) => points.push(
            (column * width) / (columns - 1) - width / 2,
            depth / 2 - (row * depth) / (rows - 1),
            heights[row * columns + column] + 0.05,
        );
        for (let column = 0; column < columns; column++) add(column, 0);
        for (let row = 1; row < rows; row++) add(columns - 1, row);
        for (let column = columns - 2; column >= 0; column--) add(column, rows - 1);
        for (let row = rows - 2; row > 0; row--) add(0, row);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
        const outline = new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color: '#3b82f6', transparent: true, opacity: 0.9, depthTest: false, toneMapped: false }));
        outline.raycast = () => undefined;
        outline.renderOrder = 998;
        outline.userData.ignorePlacement = true;
        return outline;
    }, [live, version]);
    useEffect(() => () => {
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
    }, [line]);
    return <group rotation={[-Math.PI / 2, 0, 0]}><primitive object={line} /></group>;
};

export const TerrainObject = forwardRef<THREE.Group, TerrainObjectProps>(({
    data,
    isSelected,
    visible,
    receiveShadow,
    castShadow,
    onClick,
    lod = false
}, ref) => {
    // Heights stored in a heightfield asset are loaded after the level opens.
    // Until then the flat placeholder must not be sculpted and committed.
    const heightsPending = isTerrainHeightfieldPending(data.terrainData);
    const meshRef = useRef<THREE.Mesh>(null);
    const groupRef = useRef<THREE.Group>(null);

    useImperativeHandle(ref, () => groupRef.current!, []);

    const { resolution, width, depth, heights } = data.terrainData || { resolution: 64, width: 100, depth: 100, heights: [] };
    const paintState: TerrainPaintState | undefined = data.terrainData;
    const samplesPerSide = terrainSamplesPerSide(resolution);
    // Built here rather than in JSX so LOD chunks can share its vertex buffers.
    const planeGeometry = useMemo(() => new THREE.PlaneGeometry(width, depth, resolution, resolution), [width, depth, resolution]);
    useEffect(() => () => planeGeometry.dispose(), [planeGeometry]);
    const live = useMemo(() => new TerrainLiveEdit(planeGeometry, resolution, width, depth), [planeGeometry, resolution, width, depth]);
    const chunked = lod && resolution >= MIN_LOD_SEGMENTS;

    // --- Texture Layers ---
    // Up to four layers blended by the splat map. Without layers the terrain
    // keeps the flat material.
    const storedLayers = paintState?.textureLayers;
    const layers = useMemo(() => normalizeTerrainLayers(storedLayers), [storedLayers]);
    const splat = paintState?.splat;
    // Weights stored in a splat map asset are loaded after the level opens.
    // Until then layer 0 is shown and the terrain must not be painted.
    const splatPending = isTerrainSplatPending(paintState);

    const { textures } = useGameContent();
    const layerUrls = useMemo(
        () => layers.map(layer => (layer.textureId ? textures.find(texture => texture.id === layer.textureId)?.url : undefined)),
        [layers, textures],
    );
    const layerTextures = useTerrainLayerTextures(layerUrls);

    // The live splat weights (painted in place by the sculptor) and their texture.
    const splatResources = useMemo(() => {
        const weights = createDefaultTerrainSplat(samplesPerSide, samplesPerSide);
        return { weights, texture: createTerrainSplatTexture(weights, samplesPerSide, samplesPerSide) };
    }, [samplesPerSide]);
    useEffect(() => () => splatResources.texture.dispose(), [splatResources]);

    useLayoutEffect(() => {
        const { weights, texture } = splatResources;
        if (splat && splat.length === weights.length) weights.set(splat);
        else fillDefaultTerrainSplat(weights);
        texture.needsUpdate = true;
    }, [splat, splatResources]);

    // --- Material ---
    // Unpainted terrain: grass, earth and rock by slope (see createTerrainGroundMaterial).
    const material = useMemo(() => createTerrainGroundMaterial(), []);
    useEffect(() => () => material.dispose(), [material]);

    const layered = layers.length > 0;
    // The splat texture is (re)bound in the layout effect below, so it is not a dependency here.
    const layerMaterial = useMemo(() => (layered ? createTerrainLayerMaterial(splatResources.texture) : null), [layered]);
    useEffect(() => () => layerMaterial?.dispose(), [layerMaterial]);

    useLayoutEffect(() => {
        if (!layerMaterial) return;
        setTerrainSplatTexture(layerMaterial, splatResources.texture);
        bindTerrainLayers(layerMaterial, {
            textures: layerTextures,
            tilings: layers.map(layer => layer.tiling),
            aspect: width > 0 ? depth / width : 1,
        });
    }, [layerMaterial, splatResources, layerTextures, layers, width, depth]);

    // Exposed on the mesh for the sculptor's paint brush.
    const paintTarget = useMemo<TerrainPaintTarget>(() => ({
        columns: samplesPerSide,
        rows: samplesPerSide,
        width,
        depth,
        weights: splatResources.weights,
        layerCount: layers.length,
        pending: splatPending,
        markDirty: () => { splatResources.texture.needsUpdate = true; },
    }), [samplesPerSide, width, depth, splatResources, layers.length, splatPending]);

    // --- Geometry Init ---
    useLayoutEffect(() => {
        // Heights a tool just committed are the ones the mesh already shows.
        if (heights && heights.length > 0 && heights === live.committed) return;
        live.setAll(heights);
    }, [heights, live]);

    const holes = data.terrainData?.holes;
    useLayoutEffect(() => {
        if (holes && holes === live.committedHoles) return;
        live.setHoles(holes);
    }, [holes, live]);

    return (
        <group 
            ref={groupRef}
            position={data.position} 
            rotation={data.rotation} 
            scale={data.scale}
            visible={visible}
            userData={{ levelObjectId: data.id, isTerrain: true }}
        >
            <mesh 
                ref={meshRef} 
                rotation={[-Math.PI / 2, 0, 0]} // Rotate to face up
                receiveShadow={receiveShadow}
                castShadow={castShadow}
                visible={!chunked}
                geometry={planeGeometry}
                material={layerMaterial ?? material}
                raycast={raycastTerrainMesh}
                onPointerDown={onClick}
                userData={{ levelObjectId: data.id, isTerrain: true, heightsPending, terrainPaint: paintTarget, terrainEdit: live }}
            />
            {chunked && (
                <group rotation={[-Math.PI / 2, 0, 0]}>
                    <TerrainLodMesh
                        source={planeGeometry}
                        segments={resolution}
                        version={heights}
                        live={live}
                        material={layerMaterial ?? material}
                        castShadow={castShadow}
                        receiveShadow={receiveShadow}
                    />
                </group>
            )}
            
            {isSelected && <TerrainOutline live={live} version={heights} />}
        </group>
    );
});

TerrainObject.displayName = 'TerrainObject';
