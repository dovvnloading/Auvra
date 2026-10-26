import { useRef, useLayoutEffect, useMemo, forwardRef, useImperativeHandle, useState, useEffect } from 'react';
import * as THREE from 'three';
import { ThreeEvent } from '@react-three/fiber';
import { LevelObject } from '../../../types';
import { isTerrainHeightfieldPending, terrainSamplesPerSide } from '../../../utils/terrainHeightfieldCodec';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { useGameContent } from '../../../runtime/GameContentContext';
import { TerrainBrushSettings, TerrainPaintTarget, TERRAIN_PAINT_CURSOR_COLOR } from './TerrainSculptor';
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
    TERRAIN_FLAT_COLOR,
} from './terrainLayerMaterial';

interface TerrainObjectProps {
    data: LevelObject;
    isSelected: boolean;
    visible: boolean;
    receiveShadow?: boolean;
    castShadow?: boolean;
    onClick?: (e: any) => void;
    // Sculpting Props
    sculptingEnabled?: boolean;
    sculptSettings?: TerrainBrushSettings;
    onHeightUpdate?: (id: string, heights: number[]) => void;
}

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

export const TerrainObject = forwardRef<THREE.Group, TerrainObjectProps>(({
    data,
    isSelected,
    visible,
    receiveShadow,
    castShadow,
    onClick,
    sculptingEnabled: sculptingRequested,
    sculptSettings,
    onHeightUpdate
}, ref) => {
    // Heights stored in a heightfield asset are loaded after the level opens.
    // Until then the flat placeholder must not be sculpted and committed.
    const heightsPending = isTerrainHeightfieldPending(data.terrainData);
    const sculptingEnabled = Boolean(sculptingRequested) && !heightsPending;
    const meshRef = useRef<THREE.Mesh>(null);
    const groupRef = useRef<THREE.Group>(null);
    const geometryRef = useRef<THREE.PlaneGeometry>(null);
    
    // Sculpting State
    const [hoverPoint, setHoverPoint] = useState<THREE.Vector3 | null>(null);
    const isSculpting = useRef(false);

    useImperativeHandle(ref, () => groupRef.current!, []);

    const { resolution, width, depth, heights } = data.terrainData || { resolution: 64, width: 100, depth: 100, heights: [] };
    const paintState: TerrainPaintState | undefined = data.terrainData;
    const samplesPerSide = terrainSamplesPerSide(resolution);

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
    const material = useMemo(() => new THREE.MeshStandardMaterial({
        color: TERRAIN_FLAT_COLOR,
        roughness: 0.9,
        metalness: 0.1,
        flatShading: true,
        side: THREE.DoubleSide,
        vertexColors: false
    }), []);
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
        if (!geometryRef.current) return;
        
        const geom = geometryRef.current;
        const posAttr = geom.attributes.position;
        
        if (heights && heights.length > 0) {
            if (heights.length !== posAttr.count) {
                // If resolution changed, mismatch might occur briefly. Safe to ignore or reset.
                return;
            }
            
            for (let i = 0; i < posAttr.count; i++) {
                posAttr.setZ(i, heights[i]);
            }
            posAttr.needsUpdate = true;
            geom.computeVertexNormals();
            geom.computeBoundingSphere();
        }
    }, [heights, resolution, width, depth]);

    // --- Sculpting Logic ---
    // Painting is done by the TerrainSculptor; this mesh only sculpts heights.
    const sculptsHeights = sculptSettings?.tool !== 'paint';

    const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
        if (!sculptingEnabled || !sculptSettings || !meshRef.current || !geometryRef.current) return;
        
        // Always stop propagation in sculpt mode to prevent selecting objects behind terrain
        e.stopPropagation();
        
        // Update Brush Visual
        setHoverPoint(e.point.clone());

        // Perform Sculpt
        if (isSculpting.current && sculptsHeights) {
            applySculpt(e.point);
        }
    };

    const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
        if (!sculptingEnabled) {
            if(onClick) onClick(e);
            return;
        }
        
        // Only allow Left Click (0) for sculpting. Middle (1) and Right (2) should fall through for camera controls.
        if (e.button !== 0) return;

        e.stopPropagation();
        if (!sculptsHeights) return;
        // R3F automatically captures pointer on the target mesh
        isSculpting.current = true;
        
        // Initial sculpt on click
        if (sculptSettings) {
            applySculpt(e.point);
        }
    };

    const handlePointerUp = (_e: ThreeEvent<PointerEvent>) => {
        if (isSculpting.current) {
            isSculpting.current = false;
            
            // Commit changes to global state
            if (geometryRef.current && onHeightUpdate) {
                const posAttr = geometryRef.current.attributes.position;
                const newHeights: number[] = [];
                for(let i=0; i<posAttr.count; i++) {
                    newHeights.push(posAttr.getZ(i));
                }
                onHeightUpdate(data.id, newHeights);
            }
        }
    };

    const handlePointerOut = () => {
        setHoverPoint(null);
        if (isSculpting.current) {
            // End sculpt if we drag off the mesh entirely (failsafe)
            // Ideally pointer capture prevents this, but good to have.
            // We DON'T set isSculpting false here because R3F pointer capture keeps events firing on this mesh
            // even if mouse is outside, which is what we want. 
            // So we only hide the cursor.
        }
    };

    const applySculpt = (worldPoint: THREE.Vector3) => {
        const mesh = meshRef.current;
        const geom = geometryRef.current;
        if (!mesh || !geom || !sculptSettings) return;

        mesh.worldToLocal(worldPoint); // Modifies worldPoint in place to be local

        const posAttr = geom.attributes.position;
        const count = posAttr.count;
        
        // Retrieve settings
        const { radius, strength, tool, flattenHeight } = sculptSettings;
        
        // Adjust radius for local space scaling (average of X/Y scale since plane is X/Y in local)
        const avgScale = (mesh.scale.x + mesh.scale.y) / 2; 
        const localRadius = radius / avgScale;
        const radiusSq = localRadius * localRadius;
        
        // Power factor for smoothness
        const effectStrength = strength * 0.5;

        let modified = false;

        for (let i = 0; i < count; i++) {
            const x = posAttr.getX(i);
            const y = posAttr.getY(i); // Local Y is vertical on the plane geometry before rotation
            
            // Calc distance in 2D plane
            const dx = x - worldPoint.x;
            const dy = y - worldPoint.y;
            const distSq = dx*dx + dy*dy;

            if (distSq < radiusSq) {
                const dist = Math.sqrt(distSq);
                // Smooth falloff: (1 - r^2)^2 or Cosine falloff
                const falloff = Math.pow(1 - (dist / localRadius), 2); 
                const influence = falloff * effectStrength;

                const currentZ = posAttr.getZ(i); // Z is the displacement/height
                let newZ = currentZ;

                switch (tool) {
                    case 'raise':
                        newZ += influence;
                        break;
                    case 'lower':
                        newZ -= influence;
                        break;
                    case 'flatten':
                        // Lerp towards target height
                        newZ = THREE.MathUtils.lerp(currentZ, flattenHeight, influence * 0.5);
                        break;
                    case 'smooth':
                        // Simple smooth: Move towards average of neighbors (approximated by moving towards 0 relative to brush center or keeping inertia)
                        // Better simple smooth: Average current with pre-stroke average? 
                        // For now, just dampening peaks:
                        newZ = THREE.MathUtils.lerp(currentZ, currentZ * 0.9, influence);
                        break;
                }

                if (newZ !== currentZ) {
                    posAttr.setZ(i, newZ);
                    modified = true;
                }
            }
        }

        if (modified) {
            posAttr.needsUpdate = true;
            geom.computeVertexNormals();
            geom.computeBoundingSphere();
        }
    };

    // --- Cursor Color ---
    const cursorColor = useMemo(() => {
        if (!sculptSettings) return '#ffffff';
        switch(sculptSettings.tool) {
            case 'raise': return '#4ade80';
            case 'lower': return '#ef4444';
            case 'flatten': return '#3b82f6';
            case 'smooth': return '#f59e0b';
            case 'paint': return TERRAIN_PAINT_CURSOR_COLOR;
            default: return '#ffffff';
        }
    }, [sculptSettings?.tool]);

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
                material={layerMaterial ?? material}
                onPointerMove={handlePointerMove}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onPointerOut={handlePointerOut}
                userData={{ levelObjectId: data.id, isTerrain: true, heightsPending, terrainPaint: paintTarget }}
            >
                <planeGeometry 
                    ref={geometryRef} 
                    args={[width, depth, resolution, resolution]} 
                />
            </mesh>
            
            {/* Sculpt Brush Cursor - Rendered in WORLD space relative to group, or projected? 
                Actually, simpler to put it in the scene. 
                But putting it here makes it follow the terrain object transforms easily.
            */}
            {sculptingEnabled && hoverPoint && sculptSettings && (
                <mesh 
                    position={[hoverPoint.x - data.position[0], hoverPoint.y - data.position[1] + 0.1, hoverPoint.z - data.position[2]]} 
                    rotation={[-Math.PI / 2, 0, 0]}
                    // Undo the terrain rotation for the cursor to stay flat relative to world up?
                    // No, we want it flat on the ground. The Terrain Mesh is rotated -90 X. 
                    // So its local system has Z up. 
                    // We need to match.
                >
                    <ringGeometry args={[sculptSettings.radius - 0.2, sculptSettings.radius, 64]} />
                    <meshBasicMaterial color={cursorColor} transparent opacity={0.8} depthTest={false} depthWrite={false} toneMapped={false} />
                </mesh>
            )}

            {/* Selection Grid Overlay */}
            {isSelected && !sculptingEnabled && (
                <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} raycast={() => undefined}>
                    <planeGeometry args={[width, depth, resolution, resolution]} />
                    <meshBasicMaterial color="#3b82f6" wireframe transparent opacity={0.15} depthTest={false} />
                </mesh>
            )}
        </group>
    );
});

TerrainObject.displayName = 'TerrainObject';
