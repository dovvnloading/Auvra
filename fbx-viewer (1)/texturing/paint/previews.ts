import * as THREE from 'three';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { DEFAULT_BAKE_SETTINGS, bakeMeshMaps, spaceOfBox, type TileBake } from '../bake/meshBaker';
import { textureGpu, type GpuImage, type TextureGpu } from '../gpu/textureGpu';
import type { GraphResolver } from '../graph/registry';
import { buildPartMesh, buildWholeMesh, type PartMesh } from '../mesh/partMesh';
import { PaintStack, type StackHost } from './paintStack';
import { createPaintDocument, type PaintDocument, type PaintLayer } from './paintTypes';

/**
 * PREVIEW SPHERES
 *
 * Small pictures of a material as it would look painted on a ball with two grooves cut round it (so edge
 * wear, dirt in creases and the like show): the material is put together on the ball's own baked maps,
 * exactly as on a model, then lit. Made one at a time, on request, and kept for the session.
 */

/** Pixels across a preview (shown at half that, for sharpness). */
export const PREVIEW_PIXELS = 112;
/** The ball's pictures: 256 across. */
const PREVIEW_SIZE = 8;

export interface PreviewHost {
    resolveGraph: GraphResolver;
    texture: (textureId: string) => THREE.Texture | null;
}

export interface PreviewJob {
    /** The material to show, made for the preview ball's texture set. */
    make: (document: PaintDocument) => PaintLayer;
    host: PreviewHost;
}

/** A ball of radius 1 with two grooves round it, its texture coordinates running round and down as a globe's do. */
const groovedBall = (): THREE.Object3D => {
    const geometry = new THREE.SphereGeometry(1, 128, 64);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const point = new THREE.Vector3();
    const groove = (y: number, centre: number) => {
        const d = Math.abs(y - centre);
        const t = Math.min(1, Math.max(0, (0.075 - d) / 0.025));
        return 0.05 * t * t * (3 - 2 * t);
    };
    for (let i = 0; i < position.count; i++) {
        point.fromBufferAttribute(position, i);
        const radius = 1 - groove(point.y, 0.42) - groove(point.y, -0.2);
        point.multiplyScalar(radius);
        position.setXYZ(i, point.x, point.y, point.z);
    }
    geometry.computeVertexNormals();
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
    return root;
};

const SPHERE = /* glsl */ `
uniform float uSize;
const float PI = 3.14159265;
vec3 sky(vec3 d) {
    vec3 ground = vec3(0.09, 0.085, 0.08);
    vec3 horizon = vec3(0.55, 0.55, 0.53);
    vec3 zenith = vec3(0.42, 0.5, 0.62);
    return d.y < 0.0 ? mix(horizon, ground, smoothstep(0.0, 0.35, -d.y)) : mix(horizon, zenith, smoothstep(0.0, 0.7, d.y));
}
vec3 light(vec3 n, vec3 v, vec3 l, vec3 colour, vec3 diffuse, vec3 f0, float a) {
    float nl = max(dot(n, l), 0.0);
    if (nl <= 0.0) return vec3(0.0);
    vec3 h = normalize(l + v);
    float nh = max(dot(n, h), 0.0);
    float nv = max(dot(n, v), 1e-3);
    float a2 = a * a;
    float d = a2 / (PI * pow(nh * nh * (a2 - 1.0) + 1.0, 2.0));
    float k = (a + 1.0) * (a + 1.0) / 8.0;
    float g = nl / (nl * (1.0 - k) + k) * nv / (nv * (1.0 - k) + k);
    vec3 f = f0 + (1.0 - f0) * pow(1.0 - max(dot(v, h), 0.0), 5.0);
    return ((1.0 - f) * diffuse / PI + d * g * f / max(4.0 * nl * nv, 1e-3)) * colour * nl;
}
void main() {
    vec2 q = gl_FragCoord.xy / uSize * 2.0 - 1.0;
    float r = length(q);
    float cover = clamp((1.0 - r) * uSize * 0.5 + 0.5, 0.0, 1.0);
    if (cover <= 0.0) { outColor = vec4(0.0); return; }
    vec2 s = r > 0.999 ? q / r * 0.999 : q;
    vec3 p = vec3(s, sqrt(max(0.0, 1.0 - dot(s, s))));
    float theta = acos(clamp(p.y, -1.0, 1.0));
    float phi = atan(p.z, -p.x);
    if (phi < 0.0) phi += 2.0 * PI;
    vec2 uv = vec2(phi / (2.0 * PI), 1.0 - theta / PI);
    vec3 ng = normalize(texture(worldNormal, uv).xyz * 2.0 - 1.0);
    vec3 t = vec3(sin(phi), 0.0, cos(phi));
    t = normalize(t - ng * dot(t, ng));
    vec3 b = cross(ng, t);
    vec3 nd = texture(detail, uv).xyz * 2.0 - 1.0;
    vec3 n = normalize(t * nd.x + b * nd.y + ng * nd.z);
    vec3 base = srgbToLinear(texture(baseColor, uv).rgb);
    float rough = clamp(texture(roughness, uv).r, 0.045, 1.0);
    float metal = clamp(texture(metallic, uv).r, 0.0, 1.0);
    float ao = texture(occlusion, uv).r;
    vec3 v = vec3(0.0, 0.0, 1.0);
    vec3 diffuse = base * (1.0 - metal);
    vec3 f0 = mix(vec3(0.04), base, metal);
    float a = rough * rough;
    vec3 c = light(n, v, normalize(vec3(-0.5, 0.62, 0.6)), vec3(2.4, 2.3, 2.15), diffuse, f0, a)
        + light(n, v, normalize(vec3(0.75, -0.05, 0.4)), vec3(0.45, 0.52, 0.65), diffuse, f0, a);
    float nv = max(dot(n, v), 0.0);
    vec3 fe = f0 + (max(vec3(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);
    vec3 reflected = mix(sky(reflect(-v, n)), vec3(0.32, 0.33, 0.34), rough);
    c += (fe * reflected + diffuse * mix(vec3(0.1), vec3(0.42, 0.44, 0.48), n.y * 0.5 + 0.5)) * ao;
    c += texture(glow, uv).rgb;
    c = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);
    outColor = vec4(linearToSrgb(c), cover);
}`;

class PaintPreviews {
    private ball: { part: PartMesh; bake: Map<number, TileBake>; generation: number } | null = null;
    private readonly pictures = new Map<string, string>();
    private readonly failed = new Set<string>();
    private readonly waiting = new Map<string, PreviewJob>();
    private running = false;
    private readonly listeners = new Set<() => void>();
    version = 0;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getVersion = (): number => this.version;

    /** The preview made for `key`, or null while it is waited for (or could not be made). */
    picture(key: string): string | null {
        return this.pictures.get(key) ?? null;
    }

    /** Asks for a preview of `key` to be made, unless it is made, waiting or could not be made. */
    request(key: string, job: PreviewJob): void {
        if (this.pictures.has(key) || this.failed.has(key) || this.waiting.has(key)) return;
        this.waiting.set(key, job);
        void this.run();
    }

    private emit(): void {
        this.version++;
        for (const listener of this.listeners) listener();
    }

    private async run(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            for (let next = this.waiting.entries().next(); !next.done; next = this.waiting.entries().next()) {
                const [key, job] = next.value;
                try {
                    this.pictures.set(key, await this.render(job));
                } catch (error) {
                    this.failed.add(key);
                    frontendDiagnostics.failure('paint_preview_failed', error);
                }
                this.waiting.delete(key);
                this.emit();
                // The editor answers between previews.
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        } finally {
            this.running = false;
        }
    }

    /** The preview ball laid out and baked (again after the GPU context was lost). */
    private async ballFor(gpu: TextureGpu): Promise<NonNullable<PaintPreviews['ball']>> {
        if (this.ball && this.ball.generation === gpu.generation) return this.ball;
        const root = groovedBall();
        const material = ((root.children[0] as THREE.Mesh).material) as THREE.Material;
        const part = buildPartMesh(root, new Set([material]), { udim: false });
        const bake = await bakeMeshMaps(gpu, { part, space: spaceOfBox(part.bounds), occluder: buildWholeMesh(root) }, {
            ...DEFAULT_BAKE_SETTINGS,
            size: PREVIEW_SIZE,
            samples: 32,
            maps: ['normal', 'worldNormal', 'ambientOcclusion', 'curvature', 'position', 'thickness', 'height'],
        });
        this.ball = { part, bake, generation: gpu.generation };
        return this.ball;
    }

    private async render(job: PreviewJob): Promise<string> {
        const gpu = textureGpu();
        const ball = await this.ballFor(gpu);
        const document: PaintDocument = { ...createPaintDocument('preview', ['preview'], PREVIEW_SIZE), space: spaceOfBox(ball.part.bounds) };
        const host: StackHost = {
            gpu,
            resolveGraph: job.host.resolveGraph,
            texture: job.host.texture,
            current: {},
            fetchPicture: () => Promise.reject(new Error('A preview has no kept pictures.')),
            storePicture: () => Promise.reject(new Error('A preview keeps no pictures.')),
        };
        const stack = await PaintStack.open(host, ball.part, document);
        let image: GpuImage | null = null;
        try {
            // The ball's maps are lent: the stack gives back only its own hold on them.
            for (const tile of ball.bake.values()) {
                for (const map of Object.values(tile.maps)) if (map) gpu.retain(map);
                gpu.retain(tile.coverage);
                gpu.retain(tile.nearest);
            }
            stack.setBake(new Map(ball.bake));
            stack.setDocument({ ...document, layers: [job.make(document)] });
            await stack.compose();
            const tile = stack.tiles[0];
            const outputs = stack.outputs.get(tile) ?? {};
            const maps = stack.meshMaps(tile);
            image = gpu.image(PREVIEW_PIXELS, PREVIEW_PIXELS, 'color', 8);
            gpu.passNow(image, {
                fragment: SPHERE,
                inputs: {
                    baseColor: outputs.baseColor ?? gpu.constant('mid'),
                    roughness: outputs.roughness ?? gpu.constant('mid'),
                    metallic: outputs.metallic ?? gpu.constant('black'),
                    detail: outputs.normal ?? gpu.constant('normal'),
                    worldNormal: maps.worldNormal ?? gpu.constant('normal'),
                    occlusion: maps.ambientOcclusion ?? gpu.constant('white'),
                    glow: outputs.emissive ?? gpu.constant('black'),
                },
                uniforms: { uSize: PREVIEW_PIXELS },
            });
            const png = await gpu.toPng(image, PREVIEW_PIXELS, PREVIEW_PIXELS, 'raw', true);
            return URL.createObjectURL(png);
        } finally {
            gpu.release(image);
            stack.dispose();
        }
    }
}

/** The editor's preview spheres. */
export const paintPreviews = new PaintPreviews();
