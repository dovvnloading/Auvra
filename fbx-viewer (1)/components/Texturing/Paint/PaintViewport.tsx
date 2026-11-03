import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { GpuImage, TextureGpu } from '../../../texturing/gpu/textureGpu';
import { tileGeometry } from '../../../texturing/mesh/partMesh';
import type { MeshMapName } from '../../../texturing/graph/nodes/io';
import { renderDepth, Stroke, type BrushSettings, type StrokeTarget } from '../../../texturing/paint/strokes';
import type { PaintChannel } from '../../../texturing/paint/paintTypes';
import type { PaintSession } from './paintSession';
import type { UvSession } from './uvSession';

/**
 * The painting view: the model in its rest pose, the texture set being painted drawn with its live
 * pictures and the rest of the model as it is. Left button paints (or fills an island, or picks a
 * colour), right button turns round the model, middle button (or Shift+right) pans, the wheel comes
 * closer. [ and ] change the brush size.
 */

export type PaintTool = 'paint' | 'erase' | 'island' | 'pick' | 'seam';
export type ViewMode = 'material' | PaintChannel | 'ambientOcclusion' | `mesh:${MeshMapName}` | 'mask' | 'uvChecker' | 'uvStretch';

interface Preview { base: GpuImage | null; orm: GpuImage | null; emissive: GpuImage | null; single: GpuImage | null }

const FIELD_OF_VIEW = 32;

const environments = new WeakMap<TextureGpu, THREE.Texture>();
const environmentOf = (gpu: TextureGpu): THREE.Texture => {
    let texture = environments.get(gpu);
    if (!texture) {
        const pmrem = new THREE.PMREMGenerator(gpu.renderer);
        texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        pmrem.dispose();
        environments.set(gpu, texture);
    }
    return texture;
};

/** How far back the camera stands to see a model of this box diagonal whole, in a view of this aspect. */
const fitDistance = (diagonal: number, aspect: number): number => (diagonal / 2) / Math.sin(THREE.MathUtils.degToRad(FIELD_OF_VIEW / 2)) * 1.05 / Math.min(1, aspect);

const NO_SUBSCRIBE = () => () => undefined;
const ZERO = () => 0;

/** A checker laid on by texture coordinates (to judge a layout), or each triangle coloured by its stretch. */
const LAYOUT_VIEW = new THREE.ShaderMaterial({
    uniforms: { stretchView: { value: 0 } },
    vertexShader: 'attribute float stretch; varying vec2 vUv; varying float vStretch; varying vec3 vNormal; void main() { vUv = uv; vStretch = stretch; vNormal = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform int stretchView; varying vec2 vUv; varying float vStretch; varying vec3 vNormal;
void main() {
    float light = 0.55 + 0.45 * max(0.0, dot(normalize(vNormal), normalize(vec3(0.4, 0.8, 0.6))));
    if (stretchView == 1) {
        vec3 c = vStretch < 0.0 ? vec3(0.9, 0.1, 0.6) : mix(vec3(0.2, 0.45, 0.95), mix(vec3(0.25, 0.85, 0.35), vec3(0.95, 0.25, 0.15), smoothstep(0.15, 1.0, vStretch)), smoothstep(0.0, 0.15, vStretch));
        gl_FragColor = vec4(c * light, 1.0);
        return;
    }
    vec2 cell = floor(vUv * 32.0);
    float checker = mod(cell.x + cell.y, 2.0);
    vec3 c = mix(vec3(0.85), vec3(0.25), checker);
    vec2 big = floor(vUv * 4.0);
    c *= mix(vec3(1.0, 0.85, 0.8), vec3(0.8, 0.9, 1.0), mod(big.x + big.y, 2.0));
    // Each UDIM tile past the first (1001) has a tint of its own, to see which tile an island is on.
    vec2 tile = floor(vUv);
    float id = tile.x + tile.y * 10.0;
    if (id > 0.5) c *= 0.55 + 0.45 * cos(6.28318 * (id * 0.618 + vec3(0.0, 0.33, 0.67)));
    gl_FragColor = vec4(c * light, 1.0);
}`,
    side: THREE.DoubleSide,
});
LAYOUT_VIEW.toneMapped = false;

const SINGLE_VIEW = new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, gray: { value: 0 }, encodeNormal: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform sampler2D map; uniform int gray; varying vec2 vUv; void main() { vec4 c = texture2D(map, vUv); gl_FragColor = vec4(gray == 1 ? c.rrr : c.rgb, 1.0); }',
});
SINGLE_VIEW.toneMapped = false;

export const PaintViewport: React.FC<{
    session: PaintSession;
    tool: PaintTool;
    brush: BrushSettings;
    target: StrokeTarget | null;
    view: ViewMode;
    maskImage: (tile: number) => GpuImage | null;
    onBrushSize: (size: number) => void;
    onPick: (color: [number, number, number]) => void;
    onMessage: (message: string | null) => void;
    frameSignal: number;
    /** The UV editing session, for seams and the layout views. */
    uv: UvSession | null;
}> = ({ session, tool, brush, target, view, maskImage, onBrushSize, onPick, onMessage, frameSignal, uv }) => {
    const uvVersion = useSyncExternalStore(uv?.subscribe ?? NO_SUBSCRIBE, uv?.getVersion ?? ZERO);
    const host = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const version = useSyncExternalStore(session.subscribe, session.getVersion);
    const [size, setSize] = useState({ width: 0, height: 0, ratio: 1 });
    const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
    const [, redraw] = useState(0);
    const gpu = session.gpu;
    const stack = session.stack;

    // The model: the set's tiles with materials of their own, the rest as it is.
    const world = useMemo(() => {
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1b1b1e);
        const root = new THREE.Group();
        scene.add(root);
        const sun = new THREE.DirectionalLight(0xffffff, 1.6);
        sun.position.set(2, 4, 3);
        scene.add(sun);
        const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.01, 1000);
        const object = session.target.object;
        object.updateWorldMatrix(true, true);
        const inverse = object.matrixWorld.clone().invert();
        const painted = new Set<THREE.Material>(session.target.materials);
        const hidden = new THREE.MeshBasicMaterial({ visible: false });
        object.traverse((child) => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh) return;
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            const shown = materials.map((material) => (painted.has(material) ? hidden : material));
            if (shown.every((material) => material === hidden)) return;
            const copy = new THREE.Mesh(mesh.geometry, Array.isArray(mesh.material) ? shown : shown[0]);
            copy.matrixAutoUpdate = false;
            copy.matrix.multiplyMatrices(inverse, mesh.matrixWorld);
            root.add(copy);
        });
        const tiles = new Map<number, { mesh: THREE.Mesh; lit: THREE.MeshStandardMaterial; single: THREE.ShaderMaterial; preview: Preview }>();
        for (const tile of stack.tiles) {
            const lit = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 1, side: THREE.DoubleSide });
            const single = SINGLE_VIEW.clone();
            single.toneMapped = false;
            const mesh = new THREE.Mesh(tileGeometry(session.part, tile), lit);
            root.add(mesh);
            tiles.set(tile, { mesh, lit, single, preview: { base: null, orm: null, emissive: null, single: null } });
        }
        const layoutMesh = new THREE.Mesh(new THREE.BufferGeometry(), LAYOUT_VIEW);
        layoutMesh.visible = false;
        layoutMesh.frustumCulled = false;
        root.add(layoutMesh);
        // Seams lie on the surface itself, so they are drawn a hair nearer the eye: unbroken, yet still hidden behind the model.
        const seamLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
            vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z -= 0.0015 * gl_Position.w; }',
            fragmentShader: 'void main() { gl_FragColor = vec4(1.0, 0.478, 0.102, 1.0); }',
            depthTest: true,
            toneMapped: false,
        }));
        seamLines.frustumCulled = false;
        seamLines.renderOrder = 2;
        scene.add(seamLines);
        const box = new THREE.Box3().setFromObject(root);
        const diagonal = box.getSize(new THREE.Vector3()).length() || 1;
        const orbit = { target: box.getCenter(new THREE.Vector3()), yaw: 0.5, pitch: 0.2, distance: fitDistance(diagonal, 1), radius: diagonal };
        return { scene, root, camera, tiles, orbit, box, hidden, layoutMesh, seamLines };
    }, [session, stack]);

    useEffect(() => () => {
        for (const entry of world.tiles.values()) {
            entry.mesh.geometry.dispose();
            entry.lit.dispose();
            entry.single.dispose();
            for (const image of Object.values(entry.preview)) gpu.release(image);
        }
        world.hidden.dispose();
        world.seamLines.geometry.dispose();
        (world.seamLines.material as THREE.Material).dispose();
        world.layoutMesh.geometry.dispose();
    }, [gpu, world]);

    const frame = useCallback(() => {
        world.orbit.target.copy(world.box.getCenter(new THREE.Vector3()));
        world.orbit.distance = fitDistance(world.orbit.radius, size.width / Math.max(1, size.height));
        redraw((value) => value + 1);
    }, [size, world]);
    // Framed when asked, not again whenever the view changes size.
    const latestFrame = useRef(frame);
    latestFrame.current = frame;
    useEffect(() => { if (frameSignal) latestFrame.current(); }, [frameSignal]);

    useEffect(() => {
        const element = host.current;
        if (!element) return undefined;
        const observer = new ResizeObserver(() => {
            const box = element.getBoundingClientRect();
            const ratio = window.devicePixelRatio || 1;
            setSize({ width: Math.max(1, Math.floor(box.width * ratio)), height: Math.max(1, Math.floor(box.height * ratio)), ratio });
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const placeCamera = useCallback(() => {
        const { camera, orbit } = world;
        const offset = new THREE.Vector3(Math.cos(orbit.pitch) * Math.sin(orbit.yaw), Math.sin(orbit.pitch), Math.cos(orbit.pitch) * Math.cos(orbit.yaw)).multiplyScalar(orbit.distance);
        camera.position.copy(orbit.target).add(offset);
        camera.lookAt(orbit.target);
        camera.near = Math.max(orbit.radius * 0.001, orbit.distance * 0.01);
        camera.far = orbit.distance + orbit.radius * 10;
        camera.aspect = size.width / Math.max(1, size.height);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
    }, [size, world]);

    // Keep the tiles' materials in step with the set's pictures and the view chosen.
    const updateMaterials = useCallback(() => {
        for (const [tile, entry] of world.tiles) {
            const outputs = stack.outputs.get(tile) ?? {};
            const preview = entry.preview;
            for (const key of Object.keys(preview) as Array<keyof Preview>) { gpu.release(preview[key]); preview[key] = null; }
            if (view === 'material') {
                if (outputs.baseColor) {
                    preview.base = gpu.image(stack.size, stack.size, 'color', 16);
                    gpu.passNow(preview.base, { fragment: 'void main() { vec4 c = texture(source, vUv); outColor = vec4(srgbToLinear(c.rgb), 1.0); }', inputs: { source: outputs.baseColor } });
                }
                if (outputs.emissive) {
                    preview.emissive = gpu.image(stack.size, stack.size, 'color', 16);
                    gpu.passNow(preview.emissive, { fragment: 'void main() { outColor = vec4(srgbToLinear(texture(source, vUv).rgb), 1.0); }', inputs: { source: outputs.emissive } });
                }
                preview.orm = gpu.image(stack.size, stack.size, 'color', 8);
                gpu.passNow(preview.orm, {
                    fragment: 'uniform int hasR; uniform int hasM;\nvoid main() { outColor = vec4(texture(ao, vUv).r, hasR == 1 ? texture(rough, vUv).r : 0.6, hasM == 1 ? texture(metal, vUv).r : 0.0, 1.0); }',
                    inputs: { ao: outputs.ambientOcclusion ?? gpu.constant('white'), rough: outputs.roughness ?? null, metal: outputs.metallic ?? null },
                    uniforms: { hasR: outputs.roughness ? 1 : 0, hasM: outputs.metallic ? 1 : 0 },
                });
                const lit = entry.lit;
                lit.map = preview.base?.target.texture ?? null;
                lit.color.set(preview.base ? 0xffffff : 0x808080);
                lit.normalMap = outputs.normal?.target.texture ?? null;
                lit.roughnessMap = preview.orm.target.texture;
                lit.metalnessMap = preview.orm.target.texture;
                lit.aoMap = preview.orm.target.texture;
                lit.emissiveMap = preview.emissive?.target.texture ?? null;
                lit.emissive.setScalar(preview.emissive ? 1 : 0);
                lit.needsUpdate = true;
                entry.mesh.material = lit;
            } else {
                let image: GpuImage | null | undefined = null;
                if (view === 'mask') image = maskImage(tile);
                else if (view.startsWith('mesh:')) image = stack.meshMaps(tile)[view.slice(5) as MeshMapName];
                else image = outputs[view as PaintChannel | 'ambientOcclusion'];
                entry.single.uniforms.map.value = image?.target.texture ?? gpu.constant('black');
                entry.single.uniforms.gray.value = image?.kind === 'gray' ? 1 : 0;
                entry.mesh.material = entry.single;
            }
        }
        // The layout views: the proposed coordinates (or the current ones) on the model.
        const layoutView = view === 'uvChecker' || view === 'uvStretch';
        world.layoutMesh.visible = layoutView;
        for (const entry of world.tiles.values()) entry.mesh.visible = !layoutView;
        if (layoutView) {
            const part = session.part;
            const corners = part.indices.length;
            const position = new Float32Array(corners * 3);
            const normal = new Float32Array(corners * 3);
            const uvs = new Float32Array(corners * 2);
            const stretch = new Float32Array(corners);
            for (let i = 0; i < corners; i++) {
                const v = part.indices[i];
                position.set(part.positions.subarray(v * 3, v * 3 + 3), i * 3);
                normal.set(part.normals.subarray(v * 3, v * 3 + 3), i * 3);
                if (uv?.proposal) uvs.set(uv.proposal.cornerUv.subarray(i * 2, i * 2 + 2), i * 2);
                else uvs.set([part.uvs[v * 2], part.uvs[v * 2 + 1]], i * 2);
                stretch[i] = uv?.proposal ? uv.proposal.triangleStretch[Math.floor(i / 3)] : 0;
            }
            const geometry = world.layoutMesh.geometry;
            geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
            geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
            geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
            geometry.setAttribute('stretch', new THREE.BufferAttribute(stretch, 1));
            LAYOUT_VIEW.uniforms.stretchView.value = view === 'uvStretch' ? 1 : 0;
        }
        const lines = uv && (tool === 'seam' || layoutView) ? uv.seamLines() : new Float32Array(0);
        world.seamLines.geometry.setAttribute('position', new THREE.BufferAttribute(lines, 3));
        world.seamLines.geometry.computeBoundingSphere();
    }, [gpu, maskImage, session.part, stack, tool, uv, view, world]); // eslint-disable-line react-hooks/exhaustive-deps

    const draw = useCallback(() => {
        const element = canvas.current;
        if (!element || !size.width) return;
        element.width = size.width;
        element.height = size.height;
        world.scene.environment = environmentOf(gpu);
        placeCamera();
        gpu.present(element, () => gpu.renderer.render(world.scene, world.camera));
    }, [gpu, placeCamera, size, world]);

    useEffect(() => {
        updateMaterials();
        draw();
    }, [draw, updateMaterials, version, uvVersion]);

    // ---- pointer ----
    const gesture = useRef<{ kind: 'orbit' | 'pan'; x: number; y: number } | { kind: 'stroke'; stroke: Stroke; depth: GpuImage } | null>(null);

    const toPixels = (event: { clientX: number; clientY: number }) => {
        const box = host.current!.getBoundingClientRect();
        return { x: (event.clientX - box.left) * size.ratio, y: (event.clientY - box.top) * size.ratio };
    };

    const hitAt = useCallback((x: number, y: number) => {
        placeCamera();
        const ndc = new THREE.Vector2((x / size.width) * 2 - 1, -(y / size.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, world.camera);
        return session.picker.cast(ray.ray.origin, ray.ray.direction);
    }, [placeCamera, session.picker, size, world.camera]);

    const startStroke = (x: number, y: number, pressure: number) => {
        if (!target) {
            onMessage(tool === 'island' ? 'Pick a paint layer or a painted mask to fill.' : 'Pick a paint layer, or a painted mask effect, to paint on. Fill layers take their values from their settings.');
            return;
        }
        onMessage(null);
        placeCamera();
        const depth = renderDepth(gpu, world.root, world.camera, size.width, size.height);
        const perspective = (size.height / 2) / Math.tan(THREE.MathUtils.degToRad(world.camera.fov / 2));
        const alpha = brush.shape === 'picture' && brush.alphaTexture ? session.host.texture(brush.alphaTexture) : null;
        const stencil = brush.stencil.enabled && brush.stencil.textureId ? session.host.texture(brush.stencil.textureId) : null;
        const stroke = new Stroke(stack, target, tool === 'erase' ? 'erase' : 'paint', brush, {
            viewProjection: new THREE.Matrix4().multiplyMatrices(world.camera.projectionMatrix, world.camera.matrixWorldInverse),
            cameraPosition: world.camera.position.clone(),
            cameraRight: new THREE.Vector3().setFromMatrixColumn(world.camera.matrixWorld, 0).normalize(),
            cameraUp: new THREE.Vector3().setFromMatrixColumn(world.camera.matrixWorld, 1).normalize(),
            width: size.width,
            height: size.height,
            depth,
            perspective,
        }, alpha, stencil);
        if (tool === 'island') {
            const hit = hitAt(x, y);
            if (hit) stroke.fillIsland(session.part.triangleIsland[hit.triangle]);
            const entry = stroke.finish('Fill island');
            gpu.release(depth);
            if (hit) session.record(entry);
            return;
        }
        gesture.current = { kind: 'stroke', stroke, depth };
        stroke.moveTo(x, y, pressure, (px, py) => hitAt(px, py));
    };

    const pickColour = (x: number, y: number) => {
        const hit = hitAt(x, y);
        if (!hit) return;
        const tile = 1001 + Math.floor(hit.uv.x) + 10 * Math.floor(hit.uv.y);
        const image = stack.outputs.get(tile)?.baseColor;
        if (!image) return;
        const probe = gpu.image(1, 1, 'color', 32);
        gpu.passNow(probe, { fragment: 'uniform vec2 uAt;\nvoid main() { outColor = texture(source, uAt); }', inputs: { source: image }, uniforms: { uAt: new THREE.Vector2(hit.uv.x - Math.floor(hit.uv.x), hit.uv.y - Math.floor(hit.uv.y)) } });
        const value = gpu.readFloat(probe);
        gpu.release(probe);
        onPick([value[0], value[1], value[2]]);
    };

    const onPointerDown = (event: React.PointerEvent) => {
        try { host.current?.setPointerCapture(event.pointerId); } catch { /* a pointer the page did not see start */ }
        const { x, y } = toPixels(event);
        if (event.button === 2 || event.button === 1 || event.altKey) {
            gesture.current = { kind: event.button === 1 || event.shiftKey ? 'pan' : 'orbit', x: event.clientX, y: event.clientY };
            return;
        }
        if (event.button !== 0) return;
        if (tool === 'pick') { pickColour(x, y); return; }
        if (tool === 'seam') {
            const hit = hitAt(x, y);
            if (hit && uv) uv.toggleSeam(hit.triangle, hit.point, event.shiftKey);
            else if (!uv) onMessage('Open the UVs panel to edit seams.');
            return;
        }
        startStroke(x, y, event.pointerType === 'pen' ? event.pressure : 1);
    };

    const onPointerMove = (event: React.PointerEvent) => {
        const { x, y } = toPixels(event);
        setCursor({ x: x / size.ratio, y: y / size.ratio });
        const current = gesture.current;
        if (!current) return;
        if (current.kind === 'stroke') {
            const coalesced = (event.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [];
            const events = coalesced.length ? coalesced : [event.nativeEvent];
            for (const each of events) {
                const point = toPixels(each);
                current.stroke.moveTo(point.x, point.y, each.pointerType === 'pen' ? each.pressure : 1, (px, py) => hitAt(px, py));
            }
            return;
        }
        const dx = event.clientX - current.x;
        const dy = event.clientY - current.y;
        current.x = event.clientX;
        current.y = event.clientY;
        const orbit = world.orbit;
        if (current.kind === 'orbit') {
            orbit.yaw -= dx * 0.008;
            orbit.pitch = Math.max(-1.5, Math.min(1.5, orbit.pitch + dy * 0.008));
        } else {
            const scale = orbit.distance * 0.0015;
            const right = new THREE.Vector3().setFromMatrixColumn(world.camera.matrixWorld, 0);
            const up = new THREE.Vector3().setFromMatrixColumn(world.camera.matrixWorld, 1);
            orbit.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
        }
        draw();
    };

    const onPointerUp = () => {
        const current = gesture.current;
        gesture.current = null;
        if (current?.kind === 'stroke') {
            const entry = current.stroke.finish(tool === 'erase' ? 'Erase' : 'Paint');
            gpu.release(current.depth);
            session.record(entry);
        }
    };

    useEffect(() => {
        const element = host.current;
        if (!element) return undefined;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            world.orbit.distance = Math.max(world.orbit.radius * 0.05, Math.min(world.orbit.radius * 20, world.orbit.distance * Math.exp(event.deltaY * 0.001)));
            draw();
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
    }, [draw, world]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const element = event.target as HTMLElement | null;
            if (element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable)) return;
            if (!host.current?.matches(':hover')) return;
            if (event.key === '[') onBrushSize(Math.max(1, Math.round(brush.size / 1.15)));
            else if (event.key === ']') onBrushSize(Math.min(600, Math.round(brush.size * 1.15) + 1));
            else if (event.key.toLowerCase() === 'f' && !event.ctrlKey) frame();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [brush.size, frame, onBrushSize]);

    const showCursor = cursor && (tool === 'paint' || tool === 'erase');
    return (
        <div
            ref={host}
            className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
            style={{ cursor: tool === 'pick' ? 'crosshair' : showCursor ? 'none' : 'default' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setCursor(null)}
            onContextMenu={(event) => event.preventDefault()}
        >
            <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
            {showCursor && (
                <div className="pointer-events-none absolute rounded-full border border-white/80 mix-blend-difference" style={{
                    left: cursor.x - brush.size / size.ratio, top: cursor.y - brush.size / size.ratio, width: (brush.size * 2) / size.ratio, height: (brush.size * 2) / size.ratio,
                    borderRadius: brush.shape === 'square' ? 2 : '50%',
                }}>
                    <div className="absolute rounded-full border border-white/40" style={{ inset: `${(1 - brush.hardness) * 50}%` }} />
                </div>
            )}
        </div>
    );
};
