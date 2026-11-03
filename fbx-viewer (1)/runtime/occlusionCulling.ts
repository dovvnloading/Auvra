import * as THREE from 'three';
import { CULL_MOVE_ROOM, CULL_TURN_ROOM } from '../utils/instanceCulling';

/**
 * OCCLUSION CULLING
 *
 * A set of instances (in a level with a World Grid, about one cell's worth of a model's part) that nearer
 * surfaces hide from the camera skips its draw. Each set draws a box around what it draws, writing nothing,
 * last among the camera's opaque things, and the GPU says whether any of the box passed the depth test.
 * Glass and transparent things come later in the pass, so nothing counts as hidden behind them. Shadow maps,
 * rays and every other camera read the same meshes and never ask (gateInstanceDraws, utils/instanceCulling.ts).
 *
 * The answer comes a frame or more late and is never waited for, so everything leans toward drawing:
 *  - a set starts visible, stops drawing only after a run of answers, and comes back on the first that says it shows;
 *  - no answer for a while means visible;
 *  - only the part of a box on the screen can answer, so a set hides only while its box is wholly on the screen;
 *  - the box is widened with distance and with how fast the camera travels, which is what uncovers things: a
 *    camera that only turns changes nothing about what stands in front of what.
 */

/** Answers in a row that say hidden before a set stops drawing. */
export const OCCLUSION_HIDDEN_ANSWERS = 3;
/** A set that shows asks this many frames apart, each on a frame of its own. One that is hidden, or may be, asks every frame. */
export const OCCLUSION_VISIBLE_INTERVAL = 8;
/** The most a set waits on at once: a slow GPU should not gather its questions. */
export const OCCLUSION_IN_FLIGHT = 4;
/** The most asked in a frame: hidden sets first, the rest as they fall due. */
export const OCCLUSION_QUERIES_PER_FRAME = 128;
/** The most query objects held. They go back to the pool as they answer. */
const OCCLUSION_MAX_QUERIES = 512;
/** A hidden set with no answer for this many frames counts as visible again. */
export const OCCLUSION_ANSWER_AGE = 16;
/** A set drawing fewer triangles than this is not worth asking about: the box costs about what it does. */
export const OCCLUSION_MIN_TRIANGLES = 512;
/** Room around a box, in world units. */
const OCCLUSION_BOX_ROOM = 0.5;
/** Room for a box's size on the screen, per unit of distance: enough for the frame's jitter and thin gaps. */
const OCCLUSION_ANGLE_ROOM = 0.01;
/** How many frames late an answer is taken to be. */
const OCCLUSION_LAG_FRAMES = 3;
/** How near a wall the box's room allows for, in world units: moving past a nearer one can still uncover a set a little late. */
const OCCLUSION_NEAREST_WALL = 2;
/** A camera this near a box, in world units, counts it as visible: its near plane may be cutting into it. */
export const OCCLUSION_NEAR_ROOM = CULL_MOVE_ROOM;
/** How much of last frame's travel still counts toward this frame's, so a box does not snap back at each stride. */
const TRAVEL_FADE = 0.9;
/** Drawn after everything else in the opaque list, inside a group of the same order, which is sorted on first. */
export const OCCLUSION_RENDER_ORDER = 1e9;

/** Min x, y, z, then max x, y, z. Inside out (min above max) when there is nothing in it. */
export type OcclusionBox = Float64Array;

/**
 * How much wider to draw a box `distance` from the camera, on each side: a wall that close to the camera slides
 * across the far box by this much in the frames an answer takes, at `travel` units a frame.
 */
export const occlusionBoxMargin = (distance: number, travel: number): number =>
    OCCLUSION_BOX_ROOM + distance * (OCCLUSION_ANGLE_ROOM + (travel * OCCLUSION_LAG_FRAMES) / OCCLUSION_NEAREST_WALL);

export const distanceToBox = (x: number, y: number, z: number, box: OcclusionBox): number => {
    const dx = Math.max(box[0] - x, 0, x - box[3]);
    const dy = Math.max(box[1] - y, 0, y - box[4]);
    const dz = Math.max(box[2] - z, 0, z - box[5]);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

/** Whether all of a box, with `room` around it, is inside every plane of a view. */
export const boxWhollyInView = (planes: readonly THREE.Plane[], box: OcclusionBox, room: number): boolean => {
    for (const { normal, constant } of planes) {
        // The corner farthest behind this plane.
        const worst = normal.x * (normal.x > 0 ? box[0] : box[3]) + normal.y * (normal.y > 0 ? box[1] : box[4]) + normal.z * (normal.z > 0 ? box[2] : box[5]);
        if (worst + constant < room) return false;
    }
    return true;
};

/**
 * Whether an answer could mean anything for a box seen from (x, y, z): all of it must be on the screen for the
 * query to have looked at all of it, and the widened box must stand clear of the camera, or the near plane cuts
 * it open. Travel widens the box until, fast enough, nothing can hide.
 */
export const occlusionCanHide = (planes: readonly THREE.Plane[], x: number, y: number, z: number, box: OcclusionBox, travel: number): boolean => {
    if (box[0] > box[3]) return false;
    if (!boxWhollyInView(planes, box, OCCLUSION_BOX_ROOM)) return false;
    const distance = distanceToBox(x, y, z, box);
    return distance - occlusionBoxMargin(distance, travel) * Math.sqrt(3) > OCCLUSION_NEAR_ROOM;
};

/** Whether a set asks this frame. `phase` keeps those that show from all asking on the same one. */
export const occlusionQueryDue = (urgent: boolean, frame: number, phase: number): boolean =>
    urgent || (frame + phase) % OCCLUSION_VISIBLE_INTERVAL === 0;

/** What is decided from answers. */
export interface OcclusionState {
    /** Whether the set skips the camera's draw: what the draw hooks read. */
    hidden: boolean;
    /** Answers in a row that said hidden. */
    run: number;
}

/**
 * Takes an answer: `passed` if any of the box showed. One that says hidden only counts if `current`: asked for
 * this camera's run of frames and this box. One that says it shows always counts, however old.
 */
export const takeOcclusionAnswer = (state: OcclusionState, passed: boolean, current: boolean): void => {
    if (passed) {
        state.hidden = false;
        state.run = 0;
    } else if (current) {
        state.run += 1;
        if (state.run >= OCCLUSION_HIDDEN_ANSWERS) state.hidden = true;
    }
};

/** What is used of the graphics context, so that the lifecycle can be checked without one. */
export type OcclusionContext = Pick<WebGL2RenderingContext,
    'createQuery' | 'deleteQuery' | 'beginQuery' | 'endQuery' | 'getQueryParameter' | 'isContextLost'
    | 'ANY_SAMPLES_PASSED_CONSERVATIVE' | 'QUERY_RESULT' | 'QUERY_RESULT_AVAILABLE'>;

/** A query with what it was asked for. Goes back to the pool when it has answered. */
interface PendingQuery {
    query: WebGLQuery;
    epoch: number;
    boxVersion: number;
}

export interface OcclusionSet extends OcclusionState {
    /** Around what the set now draws. */
    readonly box: OcclusionBox;
    /** Goes up when the box grows past what was asked about. */
    boxVersion: number;
    /** Not to be asked about: too little to be worth it, or its own shader moves it past the box. */
    exempt: boolean;
    /** Whether it can hide this frame. */
    open: boolean;
    phase: number;
    pending: PendingQuery[];
    lastAnswer: number;
}

const _frustum = new THREE.Frustum();
const _viewProjection = new THREE.Matrix4();

const ROTATION_ELEMENTS = [0, 1, 2, 4, 5, 6, 8, 9, 10];
/** What three passes for a draw of all of a geometry, as in its own shadow maps; the types ask for a group. */
const WHOLE_GEOMETRY = null as unknown as Parameters<THREE.WebGLRenderer['renderBufferDirect']>[5];

/** The queries of one view's camera, and the one object in the scene that gets them drawn in its pass. */
export class OcclusionQueries {
    /** The box every query draws, one at a time: never in the scene. */
    readonly geometry = new THREE.BoxGeometry(1, 1, 1);
    readonly material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false });
    /** In the scene, last among the opaque things, with no size of its own: when it draws, the queries do. */
    readonly driver = new THREE.Mesh(this.geometry, this.material);
    private readonly box = new THREE.Mesh(this.geometry, this.material);
    private readonly sets: OcclusionSet[] = [];
    private readonly spare: PendingQuery[] = [];
    private queryCount = 0;
    private camera: THREE.Camera | null = null;
    private frame = 0;
    private askedOn = -1;
    /** Goes up when the camera jumps: what was asked before says nothing about hiding now. */
    private epoch = 0;
    private travel = 0;
    private nextPhase = 0;
    /** The camera's rotation and eye last frame. */
    private readonly pose = new Float64Array(12);

    constructor(private readonly context: OcclusionContext) {
        this.driver.name = 'Occlusion queries';
        this.driver.frustumCulled = false;
        this.driver.scale.setScalar(0);
        this.driver.renderOrder = OCCLUSION_RENDER_ORDER;
        this.driver.raycast = () => undefined;
        this.box.matrixAutoUpdate = false;
        // A pass with this camera and these materials is the main one, whichever of the composers or the renderer's own
        // loop runs it. The surface buffer's hides what it does not draw, and this is not a lit surface; another camera's
        // (a probe, the sky's map, a bake) does not get here. With glass in view three draws the opaque things once ahead
        // of the pass, for the glass to look through; the depth is the same, and that is where the frame's queries go.
        this.driver.onBeforeRender = (renderer, scene, camera, _geometry, material) => {
            if (camera !== this.camera || material !== this.material) return;
            this.ask((x, y, z, width, height, depth) => {
                this.box.matrixWorld.makeScale(width, height, depth).setPosition(x, y, z);
                this.box.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, this.box.matrixWorld);
                renderer.renderBufferDirect(camera, scene, this.geometry, this.material, this.box, WHOLE_GEOMETRY);
            });
        };
    }

    add(): OcclusionSet {
        const set: OcclusionSet = {
            hidden: false, run: 0, box: new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]),
            boxVersion: 0, exempt: false, open: false, phase: this.nextPhase++, pending: [], lastAnswer: this.frame,
        };
        this.sets.push(set);
        return set;
    }

    remove(set: OcclusionSet): void {
        const index = this.sets.indexOf(set);
        if (index >= 0) this.sets.splice(index, 1);
        this.spare.push(...set.pending);
        set.pending.length = 0;
    }

    /** What a set now draws. A box that has grown holds what no answer looked at, so the set shows until one has. */
    setDrawn(set: OcclusionSet, box: OcclusionBox, exempt: boolean): void {
        const { box: held } = set;
        const grew = box[0] < held[0] || box[1] < held[1] || box[2] < held[2] || box[3] > held[3] || box[4] > held[4] || box[5] > held[5];
        held.set(box);
        set.exempt = exempt;
        if (!grew && !exempt) return;
        if (grew) set.boxVersion += 1;
        set.hidden = false;
        set.run = 0;
    }

    /** Once a frame, before anything draws: reads what has come back and works out which sets can hide. */
    beginFrame(camera: THREE.Camera): void {
        this.frame += 1;
        if (this.context.isContextLost()) {
            this.forget();
            return;
        }
        this.readAnswers();
        camera.updateWorldMatrix(true, false);
        const world = camera.matrixWorld.elements;
        const { pose } = this;
        let turned = 0;
        for (let k = 0; k < ROTATION_ELEMENTS.length; k++) {
            const change = world[ROTATION_ELEMENTS[k]] - pose[k];
            turned += change * change;
            pose[k] = world[ROTATION_ELEMENTS[k]];
        }
        const moved = Math.hypot(world[12] - pose[9], world[13] - pose[10], world[14] - pose[11]);
        pose[9] = world[12];
        pose[10] = world[13];
        pose[11] = world[14];
        // Past what a set's culling allows in a single frame (between two rotations the squares add up to twice the chord's).
        const jumped = camera !== this.camera || turned > 2 * CULL_TURN_ROOM * CULL_TURN_ROOM || moved > CULL_MOVE_ROOM;
        this.camera = camera;
        if (jumped) this.epoch += 1;
        this.travel = jumped ? 0 : Math.max(moved, this.travel * TRAVEL_FADE);
        _frustum.setFromProjectionMatrix(_viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        for (const set of this.sets) {
            set.open = !set.exempt && !jumped && occlusionCanHide(_frustum.planes, world[12], world[13], world[14], set.box, this.travel);
            if (set.open && (!set.hidden || this.frame - set.lastAnswer <= OCCLUSION_ANSWER_AGE)) continue;
            set.hidden = false;
            set.run = 0;
        }
    }

    private readAnswers(): void {
        const { context } = this;
        for (const set of this.sets) {
            while (set.pending.length > 0) {
                const asked = set.pending[0];
                if (!context.getQueryParameter(asked.query, context.QUERY_RESULT_AVAILABLE)) break;
                const passed = Boolean(context.getQueryParameter(asked.query, context.QUERY_RESULT));
                set.pending.shift();
                this.spare.push(asked);
                set.lastAnswer = this.frame;
                takeOcclusionAnswer(set, passed, asked.epoch === this.epoch && asked.boxVersion === set.boxVersion);
            }
        }
    }

    /** Draws the boxes due this frame, each inside a query. The camera's first pass of a frame asks, and only that. */
    private ask(drawBox: (x: number, y: number, z: number, width: number, height: number, depth: number) => void): void {
        if (this.askedOn === this.frame || this.sets.length === 0 || this.context.isContextLost()) return;
        this.askedOn = this.frame;
        const count = this.sets.length;
        const first = this.frame % count;
        let left = OCCLUSION_QUERIES_PER_FRAME;
        // Those hidden or on their way first: they are the ones that must come back in time.
        for (let urgent = 1; urgent >= 0 && left > 0; urgent--) {
            for (let step = 0; step < count && left > 0; step++) {
                const set = this.sets[(first + step) % count];
                const isUrgent = set.hidden || set.run > 0;
                if (!set.open || isUrgent !== (urgent === 1) || set.pending.length >= OCCLUSION_IN_FLIGHT) continue;
                if (!occlusionQueryDue(isUrgent, this.frame, set.phase)) continue;
                if (!this.askAbout(set, drawBox)) return;
                left -= 1;
            }
        }
    }

    private askAbout(set: OcclusionSet, drawBox: (x: number, y: number, z: number, width: number, height: number, depth: number) => void): boolean {
        const asked = this.spare.pop() ?? this.newQuery();
        if (!asked) return false;
        const { context } = this;
        const { box } = set;
        const eye = this.pose;
        const margin = occlusionBoxMargin(distanceToBox(eye[9], eye[10], eye[11], box), this.travel);
        context.beginQuery(context.ANY_SAMPLES_PASSED_CONSERVATIVE, asked.query);
        try {
            drawBox(
                (box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2,
                box[3] - box[0] + margin * 2, box[4] - box[1] + margin * 2, box[5] - box[2] + margin * 2,
            );
        } finally {
            context.endQuery(context.ANY_SAMPLES_PASSED_CONSERVATIVE);
        }
        asked.epoch = this.epoch;
        asked.boxVersion = set.boxVersion;
        set.pending.push(asked);
        return true;
    }

    private newQuery(): PendingQuery | null {
        if (this.queryCount >= OCCLUSION_MAX_QUERIES) return null;
        const query = this.context.createQuery();
        if (!query) return null;
        this.queryCount += 1;
        return { query, epoch: 0, boxVersion: 0 };
    }

    /** The context has gone, and its queries with it: nothing to free, and with no answers everything shows. */
    forget(): void {
        this.spare.length = 0;
        this.queryCount = 0;
        for (const set of this.sets) {
            set.pending.length = 0;
            set.hidden = false;
            set.run = 0;
            set.open = false;
        }
    }

    /** Frees what it holds. Can start again from here, if it is mounted again. */
    dispose(): void {
        if (!this.context.isContextLost()) {
            for (const asked of this.spare) this.context.deleteQuery(asked.query);
            for (const set of this.sets) for (const asked of set.pending) this.context.deleteQuery(asked.query);
        }
        this.forget();
        this.geometry.dispose();
        this.material.dispose();
    }
}
