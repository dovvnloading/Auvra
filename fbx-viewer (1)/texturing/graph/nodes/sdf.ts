import * as THREE from 'three';
import { float, int, out, select, vec2 } from '../nodeKit';
import type { TexNodeDef, TexParamDef } from '../types';

/**
 * SDF SHAPES
 *
 * Up to three 3D shapes (box, sphere, torus, capsule, cylinder) each placed, sized, stretched, turned
 * and tilted, combined by booleans that are hard or smooth, then twisted and bent, and repeated across
 * the picture. The scene is a signed distance: drawn looking straight down as a height, a normal map
 * and an ID colour by shape, and from any side in a small 3D view (its turn and tilt are settings, or
 * dragged on its handle in the 2D view). Each repeat holds the scene and its neighbours' overhangs, so
 * the pictures tile. The CPU twin below (sdfScene, sdfHeightAt) is what the tests read.
 */

type Params = Readonly<Record<string, unknown>>;
const num = (params: Params, key: string, fallback: number): number => (typeof params[key] === 'number' ? params[key] as number : fallback);
const pair = (params: Params, key: string, fallback: [number, number]): [number, number] => (Array.isArray(params[key]) ? [Number((params[key] as number[])[0]), Number((params[key] as number[])[1])] : fallback);

export const SDF_KINDS = ['box', 'sphere', 'torus', 'capsule', 'cylinder'] as const;
const KIND_OPTIONS: ReadonlyArray<[string, string]> = [['box', 'Box'], ['sphere', 'Sphere'], ['torus', 'Torus'], ['capsule', 'Capsule'], ['cylinder', 'Cylinder']];
export const SDF_OPERATIONS = ['none', 'union', 'subtract', 'intersect'] as const;
const OPERATION_OPTIONS: ReadonlyArray<[string, string]> = [['none', 'Not used'], ['union', 'Join'], ['subtract', 'Cut out'], ['intersect', 'Keep the overlap']];

/** One shape's settings, its keys starting with `slot` (a, b or c). */
const slotParams = (slot: 'a' | 'b' | 'c', group: string, kind: string, at: [number, number], shown?: (p: Params) => boolean): TexParamDef[] => {
    const extra = { group, ...(shown ? { showIf: shown } : {}) };
    return [
        select(`${slot}Kind`, 'Shape', kind, KIND_OPTIONS, extra),
        vec2(`${slot}At`, 'Place', at, -0.5, 0.5, { ...extra, hint: 'Where it sits in its repeat, from the middle.' }),
        float(`${slot}Raise`, 'Raise', 0, -0.5, 1, { ...extra, step: 0.005 }),
        float(`${slot}Size`, 'Size', 0.22, 0.005, 1, { ...extra, step: 0.005 }),
        vec2(`${slot}Stretch`, 'Stretch across and along', [1, 1], 0.05, 8, extra),
        float(`${slot}Tall`, 'Stretch up', 1, 0.05, 8, extra),
        float(`${slot}Turn`, 'Turn (degrees)', 0, -180, 180, { ...extra, step: 1 }),
        float(`${slot}Tilt`, 'Tilt (degrees)', 0, -180, 180, { ...extra, step: 1 }),
        float(`${slot}Thickness`, 'Thickness or rounding', 0.06, 0, 0.5, { ...extra, step: 0.005, hint: 'A torus\'s or capsule\'s thickness; how round a box\'s or cylinder\'s edges are.' }),
    ];
};

const shownB = (p: Params) => p.bOp !== 'none';
const shownC = (p: Params) => p.cOp !== 'none';

const SDF_PARAMS: TexParamDef[] = [
    ...slotParams('a', 'Shape A', 'box', [0, 0]),
    select('bOp', 'Shape B', 'union', OPERATION_OPTIONS, { group: 'Shape B' }),
    float('bSmooth', 'Smooth join', 0.04, 0, 0.3, { group: 'Shape B', step: 0.005, showIf: shownB }),
    ...slotParams('b', 'Shape B', 'sphere', [0.18, 0.12], shownB),
    select('cOp', 'Shape C', 'none', OPERATION_OPTIONS, { group: 'Shape C' }),
    float('cSmooth', 'Smooth join', 0.04, 0, 0.3, { group: 'Shape C', step: 0.005, showIf: shownC }),
    ...slotParams('c', 'Shape C', 'torus', [-0.15, -0.15], shownC),
    float('twist', 'Twist (degrees up its height)', 0, -720, 720, { group: 'Bend, twist and repeat', step: 1 }),
    float('bend', 'Bend', 0, -4, 4, { group: 'Bend, twist and repeat', step: 0.01 }),
    int('repeat', 'Repeat', 1, 1, 32, { group: 'Bend, twist and repeat' }),
    float('range', 'Height range', 0.5, 0.05, 2, { group: 'Bend, twist and repeat', hint: 'The height (in repeats) drawn as white.' }),
    float('yaw', 'View from (degrees round)', 35, -180, 180, { group: '3D view', step: 1 }),
    float('pitch', 'View from above (degrees)', 35, 5, 89, { group: '3D view', step: 1 }),
    float('zoom', 'Zoom', 1, 0.3, 4, { group: '3D view' }),
];

// ---- CPU twin ----

type Vec3 = [number, number, number];
const length3 = (p: Vec3) => Math.hypot(p[0], p[1], p[2]);

/** One shape's distance at a place in its own frame (stretched, turned and tilted out). */
export const primitiveDistance = (kind: typeof SDF_KINDS[number], p: Vec3, size: number, stretch: [number, number], tall: number, thickness: number): number => {
    switch (kind) {
        case 'box': {
            const b: Vec3 = [size * stretch[0], size * stretch[1], size * tall];
            const r = Math.min(thickness, b[0], b[1], b[2]);
            const q: Vec3 = [Math.abs(p[0]) - b[0] + r, Math.abs(p[1]) - b[1] + r, Math.abs(p[2]) - b[2] + r];
            return Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)) + Math.min(Math.max(q[0], q[1], q[2]), 0) - r;
        }
        case 'sphere': {
            const s: Vec3 = [size * stretch[0], size * stretch[1], size * tall];
            return (length3([p[0] / s[0], p[1] / s[1], p[2] / s[2]]) - 1) * Math.min(s[0], s[1], s[2]);
        }
        case 'torus': {
            const ring = Math.hypot(p[0] / stretch[0], p[1] / stretch[1]) * Math.min(stretch[0], stretch[1]) - size;
            return Math.hypot(ring, p[2] / tall) * Math.min(1, tall) - thickness;
        }
        case 'capsule': {
            const h = size * stretch[0];
            const x = p[0] - Math.min(h, Math.max(-h, p[0]));
            return Math.hypot(x, p[1], p[2]) - Math.max(thickness, 1e-4);
        }
        default: {
            const radius = size * Math.min(stretch[0], stretch[1]);
            const h = size * tall;
            const r = Math.min(thickness, radius, h);
            const dx = Math.hypot(p[0] / stretch[0], p[1] / stretch[1]) * Math.min(stretch[0], stretch[1]) - radius + r;
            const dz = Math.abs(p[2]) - h + r;
            return Math.min(Math.max(dx, dz), 0) + Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) - r;
        }
    }
};

const smoothMin = (a: number, b: number, k: number): number => {
    if (k <= 0) return Math.min(a, b);
    const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (b - a)) / k));
    return b + (a - b) * h - k * h * (1 - h);
};

/** Two distances combined: joined, the second cut out of the first, or only their overlap. */
export const sdfCombine = (a: number, b: number, operation: string, k: number): number => {
    if (operation === 'subtract') return -smoothMin(-a, b, k);
    if (operation === 'intersect') return -smoothMin(-a, -b, k);
    if (operation === 'union') return smoothMin(a, b, k);
    return a;
};

const slotDistance = (params: Params, slot: 'a' | 'b' | 'c', p: Vec3): number => {
    const at = pair(params, `${slot}At`, [0, 0]);
    const raise = num(params, `${slot}Raise`, 0);
    const turn = (-num(params, `${slot}Turn`, 0) * Math.PI) / 180;
    const tilt = (-num(params, `${slot}Tilt`, 0) * Math.PI) / 180;
    let q: Vec3 = [p[0] - at[0], p[1] - at[1], p[2] - raise];
    q = [Math.cos(turn) * q[0] - Math.sin(turn) * q[1], Math.sin(turn) * q[0] + Math.cos(turn) * q[1], q[2]];
    q = [q[0], Math.cos(tilt) * q[1] - Math.sin(tilt) * q[2], Math.sin(tilt) * q[1] + Math.cos(tilt) * q[2]];
    const kind = (SDF_KINDS as readonly string[]).includes(String(params[`${slot}Kind`])) ? params[`${slot}Kind`] as typeof SDF_KINDS[number] : 'box';
    return primitiveDistance(kind, q, num(params, `${slot}Size`, 0.22), pair(params, `${slot}Stretch`, [1, 1]), num(params, `${slot}Tall`, 1), num(params, `${slot}Thickness`, 0.06));
};

/** The scene in one repeat: the three shapes combined, with the twist and bend worked in first. */
const cellScene = (params: Params, p: Vec3): number => {
    let q = p;
    const twist = (num(params, 'twist', 0) * Math.PI) / 180;
    if (twist !== 0) {
        const a = twist * q[2];
        q = [Math.cos(a) * q[0] - Math.sin(a) * q[1], Math.sin(a) * q[0] + Math.cos(a) * q[1], q[2]];
    }
    const bend = num(params, 'bend', 0);
    if (bend !== 0) {
        const a = bend * q[0];
        q = [Math.cos(a) * q[0] - Math.sin(a) * q[2], q[1], Math.sin(a) * q[0] + Math.cos(a) * q[2]];
    }
    let d = slotDistance(params, 'a', q);
    if (params.bOp !== 'none') d = sdfCombine(d, slotDistance(params, 'b', q), String(params.bOp ?? 'union'), num(params, 'bSmooth', 0.04));
    if (params.cOp !== undefined && params.cOp !== 'none') d = sdfCombine(d, slotDistance(params, 'c', q), String(params.cOp), num(params, 'cSmooth', 0.04));
    return d;
};

/** The whole scene's distance at a place in repeat units (x, y across, z up), its neighbours' overhangs included. */
export const sdfScene = (params: Params, p: Vec3): number => {
    const x = p[0] - Math.round(p[0]);
    const y = p[1] - Math.round(p[1]);
    let d = Infinity;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) d = Math.min(d, cellScene(params, [x - i, y - j, p[2]]));
    return d;
};

/** The scene's height looking straight down at a place of the picture, as Height draws it (0 to 1). */
export const sdfHeightAt = (params: Params, u: number, v: number): number => {
    const n = Math.max(1, Math.round(num(params, 'repeat', 1)));
    const range = num(params, 'range', 0.5);
    const x = u * n - 0.5;
    const y = v * n - 0.5;
    let z = range * 1.5 + 0.5;
    for (let i = 0; i < 160 && z > 0; i++) {
        const d = sdfScene(params, [x, y, z]);
        if (d < 1e-4) break;
        z -= Math.max(d * 0.6, 1e-4);
    }
    return Math.min(1, Math.max(0, z / range));
};

// ---- shaders ----

const slotGlsl = (slot: 'a' | 'b' | 'c', name: string) => `float ${name}(vec3 p) {
    vec3 q = p - vec3(p_${slot}At, p_${slot}Raise);
    q.xy = rotate2(-radians(p_${slot}Turn)) * q.xy;
    q.yz = rotate2(-radians(p_${slot}Tilt)) * q.yz;
    return primitive(p_${slot}Kind, q, p_${slot}Size, p_${slot}Stretch, p_${slot}Tall, p_${slot}Thickness);
}`;

const SDF_GLSL = `float primitive(int kind, vec3 p, float size, vec2 stretch, float tall, float thickness) {
    if (kind == 0) {
        vec3 b = size * vec3(stretch, tall);
        float r = min(thickness, min(b.x, min(b.y, b.z)));
        vec3 q = abs(p) - b + r;
        return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
    }
    if (kind == 1) {
        vec3 s = size * vec3(stretch, tall);
        return (length(p / s) - 1.0) * min(s.x, min(s.y, s.z));
    }
    if (kind == 2) {
        float ring = length(p.xy / stretch) * min(stretch.x, stretch.y) - size;
        return length(vec2(ring, p.z / tall)) * min(1.0, tall) - thickness;
    }
    if (kind == 3) {
        float h = size * stretch.x;
        return length(vec3(p.x - clamp(p.x, -h, h), p.y, p.z)) - max(thickness, 1e-4);
    }
    float radius = size * min(stretch.x, stretch.y);
    float h = size * tall;
    float r = min(thickness, min(radius, h));
    vec2 d = vec2(length(p.xy / stretch) * min(stretch.x, stretch.y) - radius + r, abs(p.z) - h + r);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
}
float smoothMin(float a, float b, float k) {
    if (k <= 0.0) return min(a, b);
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}
float combineShapes(float a, float b, int op, float k) {
    if (op == 2) return -smoothMin(-a, b, k);
    if (op == 3) return -smoothMin(-a, -b, k);
    if (op == 1) return smoothMin(a, b, k);
    return a;
}
${slotGlsl('a', 'shapeA')}
${slotGlsl('b', 'shapeB')}
${slotGlsl('c', 'shapeC')}
vec3 bentAndTwisted(vec3 p) {
    if (p_twist != 0.0) p.xy = rotate2(radians(p_twist) * p.z) * p.xy;
    if (p_bend != 0.0) p.xz = rotate2(p_bend * p.x) * p.xz;
    return p;
}
// The scene in one repeat, and which shape is nearest (1, 2, 3).
vec2 cellScene(vec3 p) {
    p = bentAndTwisted(p);
    float d = shapeA(p);
    float id = 1.0;
    if (p_bOp != 0) { float b = shapeB(p); float next = combineShapes(d, b, p_bOp, p_bSmooth); if (p_bOp == 1 && b < d) id = 2.0; d = next; }
    if (p_cOp != 0) { float c = shapeC(p); float next = combineShapes(d, c, p_cOp, p_cSmooth); if (p_cOp == 1 && c < d) id = 3.0; d = next; }
    return vec2(d, id);
}
vec2 scene(vec3 p) {
    vec2 cell = p.xy - floor(p.xy + 0.5);
    vec2 best = vec2(1e9, 0.0);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec2 hit = cellScene(vec3(cell - vec2(float(i), float(j)), p.z));
        if (hit.x < best.x) best = hit;
    }
    return best;
}
vec3 sceneNormal(vec3 p) {
    vec2 e = vec2(1e-3, 0.0);
    return normalize(vec3(scene(p + e.xyy).x - scene(p - e.xyy).x, scene(p + e.yxy).x - scene(p - e.yxy).x, scene(p + e.yyx).x - scene(p - e.yyx).x));
}
vec3 idColour(float id) { return id < 0.5 ? vec3(0.0) : id < 1.5 ? vec3(0.9, 0.36, 0.3) : id < 2.5 ? vec3(0.32, 0.76, 0.42) : vec3(0.3, 0.46, 0.92); }
// Looking straight down: the height of the first surface hit, and which shape it is (0 for the ground).
vec2 lookDown(vec2 uv) {
    float n = float(p_repeat);
    vec2 xy = uv * n - 0.5;
    float z = p_range * 1.5 + 0.5;
    float id = 0.0;
    for (int i = 0; i < 160; i++) {
        if (z <= 0.0) break;
        vec2 hit = scene(vec3(xy, z));
        if (hit.x < 1e-4) { id = hit.y; break; }
        z -= max(hit.x * 0.6, 1e-4);
    }
    return vec2(max(z, 0.0), z > 0.0 ? id : 0.0);
}`;

export const SDF_NODES: TexNodeDef[] = [
    {
        type: 'sdfShapes',
        label: 'SDF shapes',
        category: 'SDF shapes',
        description: 'Up to three 3D shapes (box, sphere, torus, capsule, cylinder) joined, cut or overlapped, smoothly if you like, twisted, bent and repeated; drawn from above as height, normal and ID, and from any side in a small 3D view.',
        keywords: ['sdf', '3d shapes', 'signed distance', 'raymarch', 'box', 'sphere', 'torus', 'capsule', 'cylinder', 'boolean', 'smooth union', 'twist', 'bend', '3d viewer'],
        inputs: [],
        outputs: [out('gray', 'out', 'Height'), out('color', 'normal', 'Normal'), out('color', 'id', 'ID'), out('color', 'view', '3D view')],
        params: SDF_PARAMS,
        sizeFrom: 'graph',
        settingsInShader: true,
        async run(context) {
            const result: Record<string, ReturnType<typeof context.image>> = {};
            const cost = 40 * (1 + (context.params.bOp !== 'none' ? 1 : 0) + (context.params.cOp !== 'none' ? 1 : 0));
            const height = context.image('gray');
            await context.pass(height, `${SDF_GLSL}\nvoid main() { vec2 hit = lookDown(vUv); outColor = vec4(vec3(clamp(hit.x / p_range, 0.0, 1.0)), 1.0); }`, { cost });
            result.out = height;
            const normal = context.image('color');
            await context.pass(normal, `${SDF_GLSL}
void main() {
    vec2 hit = lookDown(vUv);
    float n = float(p_repeat);
    vec3 at = vec3(vUv * n - 0.5, hit.x);
    vec3 nrm = hit.x > 1e-4 ? sceneNormal(at) : vec3(0.0, 0.0, 1.0);
    if (nrm.z < 0.0) nrm = normalize(vec3(nrm.xy, 0.05));
    outColor = vec4(nrm * 0.5 + 0.5, 1.0);
}`, { cost: cost * 2 });
            result.normal = normal;
            const id = context.image('color');
            await context.pass(id, `${SDF_GLSL}\nvoid main() { vec2 hit = lookDown(vUv); outColor = vec4(idColour(hit.y), 1.0); }`, { cost });
            result.id = id;
            const view = context.image('color');
            await context.pass(view, `${SDF_GLSL}
uniform vec3 uEye;
uniform vec3 uTarget;
void main() {
    vec3 forward = normalize(uTarget - uEye);
    vec3 right = normalize(cross(forward, vec3(0.0, 0.0, 1.0)));
    vec3 up = cross(right, forward);
    vec2 screen = (vUv - 0.5) * vec2(uSize.x / uSize.y, 1.0);
    vec3 ray = normalize(forward * 1.6 + right * screen.x + up * screen.y);
    float t = 0.0;
    vec2 hit = vec2(1e9, 0.0);
    bool ground = false;
    for (int i = 0; i < 128; i++) {
        vec3 p = uEye + ray * t;
        vec2 s = scene(p);
        float floorDistance = p.z;
        if (floorDistance < s.x) { s = vec2(floorDistance, 0.0); }
        if (s.x < 1e-3) { hit = s; ground = s.y == 0.0; break; }
        t += s.x * 0.7;
        if (t > 8.0) break;
    }
    vec3 sky = mix(vec3(0.16, 0.17, 0.2), vec3(0.32, 0.35, 0.42), clamp(ray.z * 0.8 + 0.5, 0.0, 1.0));
    if (hit.x > 1.0) { outColor = vec4(sky, 1.0); return; }
    vec3 p = uEye + ray * t;
    vec3 nrm = ground ? vec3(0.0, 0.0, 1.0) : sceneNormal(p);
    vec3 light = normalize(vec3(0.5, -0.4, 0.8));
    float diffuse = max(dot(nrm, light), 0.0);
    // Soft shadow towards the light.
    float shadow = 1.0;
    float s = 0.02;
    for (int i = 0; i < 32; i++) {
        float d = scene(p + light * s).x;
        shadow = min(shadow, 10.0 * d / s);
        s += clamp(d, 0.01, 0.2);
        if (shadow < 0.02 || s > 2.0) break;
    }
    shadow = clamp(shadow, 0.0, 1.0);
    vec2 cell = floor(p.xy * 4.0);
    vec3 base = ground ? mix(vec3(0.24), vec3(0.3), mod(cell.x + cell.y, 2.0)) : idColour(hit.y);
    vec3 c = base * (0.25 + 0.75 * diffuse * shadow) + vec3(0.08) * pow(max(dot(reflect(-light, nrm), -ray), 0.0), 24.0);
    float fog = clamp(t / 8.0, 0.0, 1.0);
    outColor = vec4(mix(c, sky, fog * fog), 1.0);
}`, { uniforms: viewUniforms(context.params), cost: cost * 3 });
            result.view = view;
            return result;
        },
    },
];

/** Where the 3D view's camera stands and looks, from its turn, tilt and zoom. */
export const viewUniforms = (params: Params): { uEye: THREE.Vector3; uTarget: THREE.Vector3 } => {
    const yaw = (num(params, 'yaw', 35) * Math.PI) / 180;
    const pitch = (num(params, 'pitch', 35) * Math.PI) / 180;
    const distance = 2.4 / Math.max(0.1, num(params, 'zoom', 1));
    const target = new THREE.Vector3(0, 0, num(params, 'range', 0.5) * 0.3);
    const eye = new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw) * distance, Math.cos(pitch) * Math.sin(yaw) * distance, Math.sin(pitch) * distance).add(target);
    return { uEye: eye, uTarget: target };
};
