import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { AuvraCanvas } from '../../renderer/AuvraCanvas';
import { LocalEnvironment } from '../Scene/LocalEnvironment';
import { materialLibrary } from '../../runtime/materials/materialLibrary';
import { MaterialNodePreviewer, nodePreviewImages } from '../../runtime/materials/materialPreviews';
import type { MaterialGraph } from '../../runtime/materials/materialGraph';
import { frontendDiagnostics } from '../../diagnostics/runtime';

/**
 * The material editor's preview: the asset on a shape (sphere, cube, plane, cylinder or knot) under
 * an environment that shows off reflections, casting its shadow onto a floor so cut-outs and vertex
 * offsets show there too; drag to turn it, scroll to zoom. The same canvas draws every node's
 * preview (materialPreviews.ts) and reports a shader that does not compile.
 */

export type PreviewShape = 'sphere' | 'cube' | 'plane' | 'cylinder' | 'knot';

export const PREVIEW_SHAPES: ReadonlyArray<[PreviewShape, string]> = [
    ['sphere', 'Sphere'], ['cube', 'Cube'], ['plane', 'Plane'], ['cylinder', 'Cylinder'], ['knot', 'Knot'],
];

// ---------------------------------------------------------------------------
// Shader errors
// ---------------------------------------------------------------------------

let shaderError: string | null = null;
const errorListeners = new Set<() => void>();
const setShaderError = (message: string | null) => {
    if (message === shaderError) return;
    shaderError = message;
    for (const listener of errorListeners) listener();
};
const subscribeErrors = (listener: () => void) => {
    errorListeners.add(listener);
    return () => { errorListeners.delete(listener); };
};

/** The last shader compile error of the preview (the GLSL compiler's lines, each with the line it names). */
export const useMaterialShaderError = (): string | null => useSyncExternalStore(subscribeErrors, () => shaderError);
/** Forgets the error: the graph changed, so its next compile reports afresh. */
export const clearMaterialShaderError = (): void => setShaderError(null);

const describeShaderError = (gl: WebGLRenderingContext, shader: WebGLShader): string[] => {
    const log = gl.getShaderInfoLog(shader) ?? '';
    const source = (gl.getShaderSource(shader) ?? '').split('\n');
    return log.split('\n').filter(line => /ERROR/.test(line)).slice(0, 6).map((line) => {
        const at = /ERROR:\s*\d+:(\d+):/.exec(line);
        const code = at ? source[Number(at[1]) - 1]?.trim() : undefined;
        return code ? `${line.trim()}\n    at: ${code.slice(0, 160)}` : line.trim();
    });
};

/** Catches the preview canvas's shader compile errors for the editor to show. */
const ShaderErrorCatcher: React.FC = () => {
    const renderer = useThree(state => state.gl);
    useEffect(() => {
        const debug = renderer.debug;
        const previous = debug.onShaderError;
        debug.onShaderError = (gl, program, vertex, fragment) => {
            const lines = [...describeShaderError(gl, vertex), ...describeShaderError(gl, fragment)];
            if (!lines.length) lines.push((gl.getProgramInfoLog(program) ?? 'The shader did not link.').trim());
            frontendDiagnostics.warning('material_shader_error');
            setShaderError(lines.join('\n'));
        };
        return () => { debug.onShaderError = previous; };
    }, [renderer]);
    return null;
};

// ---------------------------------------------------------------------------
// Node previews
// ---------------------------------------------------------------------------

const subscribeLibrary = (listener: () => void) => materialLibrary.subscribe(listener);
const libraryVersion = () => materialLibrary.version;
/** Animated previews redraw at this rate. */
const ANIMATED_PREVIEW_FPS = 15;

const NodePreviewPass: React.FC<{ graph: MaterialGraph; nodeIds: readonly string[] }> = ({ graph, nodeIds }) => {
    const renderer = useThree(state => state.gl);
    const previewer = useMemo(() => new MaterialNodePreviewer(), []);
    const version = useSyncExternalStore(subscribeLibrary, libraryVersion);
    const dirty = useRef(true);
    const last = useRef(0);
    useEffect(() => () => previewer.dispose(), [previewer]);
    useEffect(() => {
        // Textures that finish loading change the library's version, and reach the previews here.
        previewer.setGraph(graph, nodeIds, materialLibrary.textureLookup());
        dirty.current = true;
    }, [graph, nodeIds, version, previewer]);
    useFrame((state) => {
        const now = state.clock.elapsedTime;
        if (!dirty.current && !(previewer.animated && now - last.current >= 1 / ANIMATED_PREVIEW_FPS)) return;
        const images = previewer.render(renderer);
        // Still compiling: the old images stay, and it tries again next frame.
        if (!images) return;
        dirty.current = false;
        last.current = now;
        nodePreviewImages.publish(images);
    });
    return null;
};

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const shapeGeometry = (shape: PreviewShape): THREE.BufferGeometry => {
    switch (shape) {
        // Finely divided, so vertex offsets have vertices to move.
        case 'cube': return new THREE.BoxGeometry(1.45, 1.45, 1.45, 48, 48, 48);
        case 'plane': return new THREE.PlaneGeometry(2.3, 2.3, 160, 160);
        case 'cylinder': return new THREE.CylinderGeometry(0.75, 0.75, 1.8, 128, 64);
        case 'knot': return new THREE.TorusKnotGeometry(0.62, 0.22, 384, 64);
        default: return new THREE.SphereGeometry(1, 128, 96);
    }
};

const PreviewMesh: React.FC<{ assetId: string; shape: PreviewShape }> = ({ assetId, shape }) => {
    const material = useMemo(() => new THREE.MeshStandardMaterial(), []);
    const geometry = useMemo(() => shapeGeometry(shape), [shape]);
    useEffect(() => {
        materialLibrary.assign(material, assetId);
        return () => { materialLibrary.assign(material, null); };
    }, [material, assetId]);
    useEffect(() => () => material.dispose(), [material]);
    useEffect(() => () => geometry.dispose(), [geometry]);
    return <mesh geometry={geometry} material={material} castShadow receiveShadow />;
};

export const MaterialPreview: React.FC<{
    assetId: string;
    graph: MaterialGraph;
    /** Nodes whose previews to draw; none when previews are off. */
    previewNodeIds: readonly string[];
}> = ({ assetId, graph, previewNodeIds }) => {
    const [shape, setShape] = useState<PreviewShape>(() => {
        try {
            const stored = localStorage.getItem('auvra.materialPreviewShape');
            return PREVIEW_SHAPES.some(([value]) => value === stored) ? stored as PreviewShape : 'sphere';
        } catch {
            return 'sphere';
        }
    });
    const [spin, setSpin] = useState(true);
    const pick = (next: PreviewShape) => {
        setShape(next);
        try { localStorage.setItem('auvra.materialPreviewShape', next); } catch { /* the choice just is not remembered */ }
    };
    return (
        <div className="relative h-64 w-full shrink-0 overflow-hidden rounded border border-gray-800 bg-gradient-to-b from-gray-800 to-gray-950">
            <AuvraCanvas surfaceId="preview-material-graph" role="preview" shadows camera={{ position: [0, 0.35, 3.6], fov: 40 }}>
                <ShaderErrorCatcher />
                <LocalEnvironment intensity={1} />
                <hemisphereLight args={['#dfe9ff', '#2a2420', 0.35]} />
                <directionalLight position={[3, 5, 2.5]} intensity={2.2} castShadow shadow-mapSize={[1024, 1024]} shadow-bias={-0.0004}>
                    <orthographicCamera attach="shadow-camera" args={[-2.5, 2.5, 2.5, -2.5, 0.5, 15]} />
                </directionalLight>
                <directionalLight position={[-3, 1, -2]} intensity={0.45} color="#9fb4ff" />
                <PreviewMesh assetId={assetId} shape={shape} />
                <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.3, 0]} receiveShadow>
                    <planeGeometry args={[12, 12]} />
                    <shadowMaterial opacity={0.4} />
                </mesh>
                <OrbitControls makeDefault enablePan={false} minDistance={1.8} maxDistance={9} autoRotate={spin} autoRotateSpeed={1.2} />
                {previewNodeIds.length > 0 && <NodePreviewPass graph={graph} nodeIds={previewNodeIds} />}
            </AuvraCanvas>
            <div className="absolute left-1.5 top-1.5 flex gap-1">
                {PREVIEW_SHAPES.map(([value, label]) => (
                    <button key={value} onClick={() => pick(value)} aria-pressed={shape === value}
                        className={`rounded px-1.5 py-0.5 text-2xs ${shape === value ? 'bg-blue-600 text-accent-ink' : 'bg-gray-900/80 text-gray-300 hover:bg-gray-800'}`}>
                        {label}
                    </button>
                ))}
            </div>
            <button onClick={() => setSpin(value => !value)} aria-pressed={spin}
                className={`absolute right-1.5 top-1.5 rounded px-1.5 py-0.5 text-2xs ${spin ? 'bg-gray-700 text-white' : 'bg-gray-900/80 text-gray-400'}`}>
                Spin
            </button>
        </div>
    );
};
