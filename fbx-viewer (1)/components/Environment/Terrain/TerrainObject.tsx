import React, { useRef, useLayoutEffect, useMemo, forwardRef, useImperativeHandle, useEffect } from 'react';
import * as THREE from 'three';
import { LevelObject } from '../../../types';
import { isTerrainHeightfieldPending, terrainSamplesPerSide } from '../../../utils/terrainHeightfieldCodec';
import { useGameContent } from '../../../runtime/GameContentContext';
import { raycastTerrainMesh } from '../../../utils/surfacePlacement';
import type { TerrainPaintTarget } from './TerrainBrushTool';
import { TerrainLiveEdit } from './terrainLiveEdit';
import { TerrainLodMesh } from './TerrainLodMesh';
import {
    createDefaultTerrainSplat,
    fillDefaultTerrainSplat,
    isTerrainSplat2Pending,
    isTerrainSplatPending,
    normalizeTerrainLayers,
    terrainLayerTileSize,
    TERRAIN_SPLAT_CHANNELS,
    type TerrainPaintState,
} from './terrainSplatCodec';
import {
    bindTerrainLayers,
    createTerrainLayerMaterial,
    createTerrainSplatTexture,
    getNeutralAlbedoArray,
    getNeutralDetailArray,
    getNeutralSurfaceArray,
    setTerrainSplatTextures,
    createTerrainGroundMaterial,
    type TerrainLayerLook,
} from './terrainLayerMaterial';
import { useTerrainLayerArrays, type TerrainLayerSources } from './terrainLayerTextures';
import { TerrainGrass } from './terrainGrass';
import { editLayerBlock } from './terrainEditLayers';

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
    useEffect(() => () => live.clearRegion(), [live]);
    const chunked = lod && resolution >= MIN_LOD_SEGMENTS;

    // --- Texture Layers ---
    // Up to eight layers blended by the splat maps. Without layers the terrain
    // shades itself by slope.
    const storedLayers = paintState?.textureLayers;
    const layers = useMemo(() => normalizeTerrainLayers(storedLayers), [storedLayers]);
    const splat = paintState?.splat;
    const splat2 = paintState?.splat2;
    const holes = data.terrainData?.holes;
    // Weights stored in a splat map asset are loaded after the level opens.
    // Until then layer 0 is shown and the terrain must not be painted.
    const splatPending = isTerrainSplatPending(paintState) || isTerrainSplat2Pending(paintState);

    const { textures, models } = useGameContent();
    const hasGrass = layers.some(layer => layer.grass?.length);
    const layerSources = useMemo<TerrainLayerSources[]>(() => {
        // A deep picture is read from its file, at its own depth, not its 8-bit preview.
        const urlOf = (id: string | undefined) => { const texture = id ? textures.find(candidate => candidate.id === id) : undefined; return texture ? texture.sourceUrl ?? texture.url : undefined; };
        return layers.map(layer => ({
            // The textures' ids too: the arrays keep their compressed slices with them (terrainLayerTextures.ts).
            ids: { albedo: layer.textureId, normal: layer.normalTextureId, roughness: layer.roughnessTextureId, height: layer.heightTextureId },
            albedo: urlOf(layer.textureId),
            normal: urlOf(layer.normalTextureId),
            roughness: urlOf(layer.roughnessTextureId),
            height: urlOf(layer.heightTextureId),
        }));
    }, [layers, textures]);
    const layerArrays = useTerrainLayerArrays(layerSources);

    // The live splat weights (painted in place by the brush) and their textures.
    const splatResources = useMemo(() => {
        const weights = createDefaultTerrainSplat(samplesPerSide, samplesPerSide);
        return { weights, texture: createTerrainSplatTexture(weights, samplesPerSide, samplesPerSide) };
    }, [samplesPerSide]);
    useEffect(() => () => splatResources.texture.dispose(), [splatResources]);

    // The second map only exists once a terrain has more than four layers.
    const needsSecondMap = layers.length > TERRAIN_SPLAT_CHANNELS;
    const secondSplat = useMemo(() => {
        if (!needsSecondMap) return null;
        const weights = new Uint8Array(samplesPerSide * samplesPerSide * TERRAIN_SPLAT_CHANNELS);
        return { weights, texture: createTerrainSplatTexture(weights, samplesPerSide, samplesPerSide) };
    }, [samplesPerSide, needsSecondMap]);
    useEffect(() => () => secondSplat?.texture.dispose(), [secondSplat]);

    useLayoutEffect(() => {
        const { weights, texture } = splatResources;
        if (splat && splat.length === weights.length) weights.set(splat);
        else fillDefaultTerrainSplat(weights);
        texture.needsUpdate = true;
    }, [splat, splatResources]);

    useLayoutEffect(() => {
        if (!secondSplat) return;
        if (splat2 && splat2.length === secondSplat.weights.length) secondSplat.weights.set(splat2);
        else secondSplat.weights.fill(0);
        secondSplat.texture.needsUpdate = true;
    }, [splat2, secondSplat]);

    // --- Material ---
    // Unpainted terrain: grass, earth and rock by slope (see createTerrainGroundMaterial).
    const material = useMemo(() => createTerrainGroundMaterial(), []);
    useEffect(() => () => material.dispose(), [material]);

    const layered = layers.length > 0;
    // The splat texture is (re)bound in the layout effect below, so it is not a dependency here.
    const layerMaterial = useMemo(() => (layered ? createTerrainLayerMaterial(splatResources.texture) : null), [layered]);
    useEffect(() => () => layerMaterial?.dispose(), [layerMaterial]);

    // The grass grows again when anything it grows from changes.
    const grassVersion = useMemo(() => ({}), [heights, splat, splat2, holes]);

    const scaleX = data.scale[0];
    useLayoutEffect(() => {
        if (!layerMaterial) return;
        setTerrainSplatTextures(layerMaterial, splatResources.texture, secondSplat?.texture ?? null);
        const looks = layers.map((layer): TerrainLayerLook => ({
            tileSize: terrainLayerTileSize(layer, width * scaleX),
            rotation: layer.rotation,
            tint: layer.tint,
            roughness: layer.roughness ?? (layer.roughnessTextureId ? 1 : undefined),
            normalStrength: layer.normalStrength,
            heightContrast: layer.heightContrast,
            cliffProjection: layer.cliffProjection,
            variation: layer.variation,
        }));
        bindTerrainLayers(layerMaterial, {
            albedo: layerArrays?.albedo ?? getNeutralAlbedoArray(),
            detail: layerArrays?.detail ?? getNeutralDetailArray(),
            surface: layerArrays?.surface ?? getNeutralSurfaceArray(),
            layers: looks,
            width,
            depth,
            rayMaps: layerArrays?.rayMaps,
        });
    }, [layerMaterial, splatResources, secondSplat, layerArrays, layers, width, depth, scaleX]);

    // Exposed on the mesh for the brush.
    const paintTarget = useMemo<TerrainPaintTarget>(() => ({
        columns: samplesPerSide,
        rows: samplesPerSide,
        width,
        depth,
        weights: splatResources.weights,
        weights2: secondSplat?.weights ?? null,
        layerCount: layers.length,
        layerNames: layers.map((layer, index) => layer.name || `Layer ${index + 1}`),
        pending: splatPending,
        markDirty: () => {
            splatResources.texture.needsUpdate = true;
            if (secondSplat) secondSplat.texture.needsUpdate = true;
        },
    }), [samplesPerSide, width, depth, splatResources, secondSplat, layers, splatPending]);

    // --- Geometry Init ---
    useLayoutEffect(() => {
        // Heights a tool just committed are the ones the mesh already shows.
        if (heights && heights.length > 0 && heights === live.committed) return;
        live.setAll(heights);
    }, [heights, live]);

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
                userData={{ levelObjectId: data.id, isTerrain: true, heightsPending, terrainPaint: paintTarget, terrainEdit: live, terrainEditBlock: editLayerBlock(data.terrainData) }}
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
            {hasGrass && (
                <TerrainGrass
                    live={live}
                    layers={layers}
                    models={models}
                    weights={splatResources.weights}
                    weights2={secondSplat?.weights ?? null}
                    version={grassVersion}
                />
            )}
        </group>
    );
});

TerrainObject.displayName = 'TerrainObject';
