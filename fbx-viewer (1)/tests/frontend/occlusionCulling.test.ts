import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
    boxWhollyInView, distanceToBox, OCCLUSION_ANSWER_AGE, OCCLUSION_HIDDEN_ANSWERS, OCCLUSION_IN_FLIGHT, OCCLUSION_NEAR_ROOM, OCCLUSION_QUERIES_PER_FRAME, OCCLUSION_VISIBLE_INTERVAL,
    occlusionBoxMargin, occlusionCanHide, occlusionQueryDue, OcclusionQueries, takeOcclusionAnswer, type OcclusionContext, type OcclusionSet,
} from '../../runtime/occlusionCulling';
import { normalizeGameSettings } from '../../runtime/types';
import { CULL_MOVE_ROOM, CULL_TURN_ROOM } from '../../utils/instanceCulling';

/*
 * When a set of instances counts as hidden, how its queries are spaced and how they live and die, with a stand-in
 * for the graphics context. Whether a real depth buffer hides what it should is checked in the running engine.
 */

const box = (x: number, y: number, z: number, half = 2): Float64Array => new Float64Array([x - half, y - half, z - half, x + half, y + half, z + half]);

const looking = (fov = 60): THREE.PerspectiveCamera => {
    const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 1000);
    camera.lookAt(0, 0, -1);
    camera.updateMatrixWorld();
    return camera;
};

const planesOf = (camera: THREE.Camera): THREE.Plane[] =>
    new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)).planes;

describe('whether an answer can hide a set', () => {
    const planes = planesOf(looking());

    it('takes all of a box on the screen: a query only looks at what is', () => {
        expect(boxWhollyInView(planes, box(0, 0, -30), 0)).toBe(true);
        // Half past the edge of the picture.
        expect(boxWhollyInView(planes, box(30, 0, -30), 0)).toBe(false);
        expect(boxWhollyInView(planes, box(0, 0, 30), 0)).toBe(false);
        expect(boxWhollyInView(planes, box(0, 0, -2000), 0)).toBe(false);
        expect(occlusionCanHide(planes, 0, 0, 0, box(0, 0, -30), 0)).toBe(true);
        expect(occlusionCanHide(planes, 0, 0, 0, box(30, 0, -30), 0)).toBe(false);
    });

    it('never with the camera inside the box or near it', () => {
        expect(occlusionCanHide(planes, 0, 0, 0, box(0, 0, 0), 0)).toBe(false);
        expect(distanceToBox(0, 0, 0, box(0, 0, -3, 2))).toBe(1);
        expect(occlusionCanHide(planes, 0, 0, 0, box(0, 0, -3, 0.5), 0)).toBe(false);
        expect(occlusionCanHide(planes, 0, 0, 0, box(0, 0, -1 - OCCLUSION_NEAR_ROOM, 0.5), 0)).toBe(false);
        expect(occlusionCanHide(planes, 0, 0, 0, box(0, 0, -4 - OCCLUSION_NEAR_ROOM, 0.5), 0)).toBe(true);
    });

    it('never with nothing in it', () => {
        expect(occlusionCanHide(planes, 0, 0, 0, new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]), 0)).toBe(false);
    });

    it('less and less as the camera travels faster', () => {
        const far = box(0, 0, -100);
        expect(occlusionCanHide(planes, 0, 0, 0, far, 0)).toBe(true);
        // A brisk walk still leaves room at this distance; a fast car does not.
        expect(occlusionCanHide(planes, 0, 0, 0, far, 0.05)).toBe(true);
        expect(occlusionCanHide(planes, 0, 0, 0, far, 1)).toBe(false);
    });

    it('widens a box with distance and with travel', () => {
        expect(occlusionBoxMargin(0, 0)).toBeGreaterThan(0);
        expect(occlusionBoxMargin(100, 0)).toBeGreaterThan(occlusionBoxMargin(10, 0));
        expect(occlusionBoxMargin(100, 0.1)).toBeGreaterThan(occlusionBoxMargin(100, 0));
        // Running past a wall 2 m away, a set 50 m behind it slides this far in the frames an answer takes.
        expect(occlusionBoxMargin(50, 0.12)).toBeGreaterThan(50 * ((0.12 * 2) / 2));
    });
});

describe('taking answers', () => {
    it('hides only after a run of them, and comes back on the first that shows', () => {
        const state = { hidden: false, run: 0 };
        for (let answer = 1; answer < OCCLUSION_HIDDEN_ANSWERS; answer++) {
            takeOcclusionAnswer(state, false, true);
            expect(state.hidden).toBe(false);
        }
        takeOcclusionAnswer(state, false, true);
        expect(state.hidden).toBe(true);
        takeOcclusionAnswer(state, true, true);
        expect(state).toEqual({ hidden: false, run: 0 });
    });

    it('starts the run again on an answer that shows', () => {
        const state = { hidden: false, run: 0 };
        for (let answer = 1; answer < OCCLUSION_HIDDEN_ANSWERS; answer++) takeOcclusionAnswer(state, false, true);
        takeOcclusionAnswer(state, true, true);
        takeOcclusionAnswer(state, false, true);
        expect(state.hidden).toBe(false);
        expect(state.run).toBe(1);
    });

    it('ignores an old answer that says hidden, and heeds one that says it shows', () => {
        const state = { hidden: false, run: 0 };
        for (let answer = 0; answer < OCCLUSION_HIDDEN_ANSWERS * 2; answer++) takeOcclusionAnswer(state, false, false);
        expect(state.hidden).toBe(false);
        const hidden = { hidden: true, run: OCCLUSION_HIDDEN_ANSWERS };
        takeOcclusionAnswer(hidden, true, false);
        expect(hidden.hidden).toBe(false);
    });
});

describe('when a set asks', () => {
    it('asks every frame while hidden or on its way', () => {
        for (let frame = 0; frame < 20; frame++) expect(occlusionQueryDue(true, frame, 3)).toBe(true);
    });

    it('spreads those that show evenly over the frames', () => {
        const counts = new Array(OCCLUSION_VISIBLE_INTERVAL).fill(0);
        for (let phase = 0; phase < OCCLUSION_VISIBLE_INTERVAL * 10; phase++) {
            let asked = 0;
            for (let frame = 0; frame < OCCLUSION_VISIBLE_INTERVAL; frame++) {
                if (!occlusionQueryDue(false, frame, phase)) continue;
                asked++;
                counts[frame]++;
            }
            expect(asked).toBe(1);
        }
        expect(new Set(counts).size).toBe(1);
    });
});

/** A context whose queries answer when told to. */
class FakeContext implements OcclusionContext {
    readonly ANY_SAMPLES_PASSED_CONSERVATIVE = 0x8d6a;
    readonly QUERY_RESULT = 0x8866;
    readonly QUERY_RESULT_AVAILABLE = 0x8867;
    lost = false;
    created = 0;
    deleted = 0;
    active: object | null = null;
    /** Queries begun and not yet answered, oldest first. */
    waiting: object[] = [];
    answers = new Map<object, boolean>();
    resultsReadEarly = 0;

    createQuery = (): WebGLQuery => {
        this.created += 1;
        return {} as WebGLQuery;
    };

    deleteQuery = (): void => {
        this.deleted += 1;
    };

    beginQuery = (target: number, query: WebGLQuery): void => {
        expect(target).toBe(this.ANY_SAMPLES_PASSED_CONSERVATIVE);
        expect(this.active).toBeNull();
        this.active = query;
        this.answers.delete(query);
        this.waiting.push(query);
    };

    endQuery = (target: number): void => {
        expect(target).toBe(this.ANY_SAMPLES_PASSED_CONSERVATIVE);
        expect(this.active).not.toBeNull();
        this.active = null;
    };

    getQueryParameter = (query: WebGLQuery, pname: number): unknown => {
        if (pname === this.QUERY_RESULT_AVAILABLE) return this.answers.has(query);
        if (!this.answers.has(query)) this.resultsReadEarly += 1;
        return this.answers.get(query) ? 1 : 0;
    };

    isContextLost = (): boolean => this.lost;

    /** The GPU finishes all it was asked, all with the same answer. */
    answerAll(passed: boolean): void {
        for (const query of this.waiting) this.answers.set(query, passed);
        this.waiting = [];
    }
}

const fakeRenderer = () => ({ renderBufferDirect: vi.fn() }) as unknown as THREE.WebGLRenderer & { renderBufferDirect: ReturnType<typeof vi.fn> };

const setUp = (sets = 1) => {
    const context = new FakeContext();
    const queries = new OcclusionQueries(context as unknown as OcclusionContext);
    const camera = looking();
    const renderer = fakeRenderer();
    const scene = new THREE.Scene();
    const added: OcclusionSet[] = [];
    for (let index = 0; index < sets; index++) {
        const set = queries.add();
        queries.setDrawn(set, box(index % 10, 0, -30), false);
        added.push(set);
    }
    // A camera first seen counts as one that has just jumped.
    queries.beginFrame(camera);
    /** The camera's pass reaches the object that draws the queries. */
    const pass = (seenBy: THREE.Camera = camera, material: THREE.Material = queries.material) =>
        queries.driver.onBeforeRender(renderer, scene, seenBy, queries.geometry, material, new THREE.Group());
    const frame = () => {
        queries.beginFrame(camera);
        pass();
    };
    return { context, queries, camera, renderer, scene, sets: added, pass, frame };
};

describe('the queries of a camera', () => {
    it('draws nothing but in a query, and only reads an answer that has arrived', () => {
        const { context, renderer, frame, sets } = setUp();
        for (let run = 0; run < OCCLUSION_VISIBLE_INTERVAL * 2; run++) frame();
        expect(renderer.renderBufferDirect).toHaveBeenCalled();
        expect(context.active).toBeNull();
        expect(context.resultsReadEarly).toBe(0);
        expect(sets[0].hidden).toBe(false);
    });

    it('counts no answer as visible, however long it takes', () => {
        const { context, frame, sets } = setUp();
        for (let run = 0; run < 100; run++) frame();
        expect(sets[0].hidden).toBe(false);
        expect(sets[0].run).toBe(0);
        expect(context.created).toBeLessThanOrEqual(OCCLUSION_IN_FLIGHT);
    });

    it('hides on a run of answers, then asks every frame, and comes back as soon as one shows', () => {
        const { context, renderer, frame, sets } = setUp();
        const answering = (passed: boolean, frames: number) => {
            for (let run = 0; run < frames; run++) {
                frame();
                context.answerAll(passed);
            }
        };
        answering(false, OCCLUSION_VISIBLE_INTERVAL + OCCLUSION_HIDDEN_ANSWERS + 2);
        expect(sets[0].hidden).toBe(true);
        renderer.renderBufferDirect.mockClear();
        answering(false, 5);
        expect(renderer.renderBufferDirect).toHaveBeenCalledTimes(5);
        expect(sets[0].hidden).toBe(true);
        // The frame after the answer reaches it, before anything draws.
        context.answerAll(true);
        frame();
        context.answerAll(true);
        frame();
        expect(sets[0].hidden).toBe(false);
    });

    it('goes back to visible if a hidden set stops hearing', () => {
        const { context, frame, sets } = setUp();
        for (let run = 0; run < OCCLUSION_VISIBLE_INTERVAL + OCCLUSION_HIDDEN_ANSWERS + 2; run++) {
            frame();
            context.answerAll(false);
        }
        expect(sets[0].hidden).toBe(true);
        for (let run = 0; run < OCCLUSION_ANSWER_AGE; run++) frame();
        expect(sets[0].hidden).toBe(true);
        frame();
        frame();
        expect(sets[0].hidden).toBe(false);
    });

    it('asks only in the camera\'s own pass, and only once a frame', () => {
        const { queries, camera, renderer, pass, sets } = setUp();
        sets[0].run = 1;
        queries.beginFrame(camera);
        const probe = new THREE.PerspectiveCamera();
        pass(probe);
        expect(renderer.renderBufferDirect).not.toHaveBeenCalled();
        // Something drawing the scene with a material of its own.
        pass(camera, new THREE.MeshBasicMaterial());
        expect(renderer.renderBufferDirect).not.toHaveBeenCalled();
        pass();
        expect(renderer.renderBufferDirect).toHaveBeenCalledTimes(1);
        // The pass drawn again, as for glass, which draws the opaque things twice.
        pass();
        expect(renderer.renderBufferDirect).toHaveBeenCalledTimes(1);
    });

    it('shares one box and one material, and draws the box where the set is, wider', () => {
        const { queries, camera, renderer, pass, scene, sets } = setUp(2);
        sets[0].run = 1;
        sets[1].run = 1;
        queries.beginFrame(camera);
        pass();
        const calls = renderer.renderBufferDirect.mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[0][0]).toBe(camera);
        expect(calls[0][1]).toBe(scene);
        expect(calls[0][2]).toBe(queries.geometry);
        expect(calls[1][2]).toBe(queries.geometry);
        expect(calls[0][3]).toBe(queries.material);
        expect(queries.material.colorWrite).toBe(false);
        expect(queries.material.depthWrite).toBe(false);
        expect(queries.material.depthTest).toBe(true);
    });

    it('draws no more than its budget, and gets to them all in turn', () => {
        const count = OCCLUSION_QUERIES_PER_FRAME + 40;
        const { queries, camera, renderer, pass, sets } = setUp(count);
        for (const set of sets) set.run = 1;
        queries.beginFrame(camera);
        pass();
        expect(renderer.renderBufferDirect).toHaveBeenCalledTimes(OCCLUSION_QUERIES_PER_FRAME);
        renderer.renderBufferDirect.mockClear();
        queries.beginFrame(camera);
        pass();
        expect(renderer.renderBufferDirect).toHaveBeenCalledTimes(OCCLUSION_QUERIES_PER_FRAME);
        expect(sets.filter(set => set.pending.length > 0).length).toBeGreaterThan(OCCLUSION_QUERIES_PER_FRAME);
    });

    it('spends its budget on those that may be hidden before those that show', () => {
        const { context, frame, sets } = setUp(OCCLUSION_QUERIES_PER_FRAME + OCCLUSION_VISIBLE_INTERVAL);
        const showing = sets.slice(OCCLUSION_QUERIES_PER_FRAME);
        for (const set of sets) set.run = showing.includes(set) ? 0 : 1;
        for (let run = 0; run < OCCLUSION_VISIBLE_INTERVAL; run++) {
            frame();
            context.answerAll(false);
        }
        expect(showing.every(set => set.pending.length === 0 && set.lastAnswer === 0)).toBe(true);
    });

    it('spaces out the sets that show', () => {
        const { queries, camera, renderer, pass } = setUp(OCCLUSION_VISIBLE_INTERVAL * 4);
        for (let run = 0; run < OCCLUSION_VISIBLE_INTERVAL; run++) {
            renderer.renderBufferDirect.mockClear();
            queries.beginFrame(camera);
            pass();
            expect(renderer.renderBufferDirect).toHaveBeenCalledTimes(4);
        }
    });

    it('holds at most a few queries for a set, and reuses them', () => {
        const { context, frame, sets } = setUp();
        sets[0].run = 1;
        for (let run = 0; run < 20; run++) frame();
        expect(sets[0].pending.length).toBeLessThanOrEqual(OCCLUSION_IN_FLIGHT);
        const created = context.created;
        for (let run = 0; run < 50; run++) {
            frame();
            context.answerAll(false);
        }
        expect(context.created).toBeLessThanOrEqual(created + 1);
    });

    it('does not ask about a set that cannot hide, or one exempt', () => {
        const { queries, camera, renderer, pass, sets } = setUp();
        queries.setDrawn(sets[0], box(0, 0, 30), false);
        sets[0].run = 1;
        queries.beginFrame(camera);
        pass();
        expect(renderer.renderBufferDirect).not.toHaveBeenCalled();
        queries.setDrawn(sets[0], box(0, 0, -30), true);
        sets[0].run = 1;
        queries.beginFrame(camera);
        pass();
        expect(renderer.renderBufferDirect).not.toHaveBeenCalled();
    });

    const hiddenSet = () => {
        const setup = setUp();
        for (let run = 0; run < OCCLUSION_VISIBLE_INTERVAL + OCCLUSION_HIDDEN_ANSWERS + 2; run++) {
            setup.frame();
            setup.context.answerAll(false);
        }
        expect(setup.sets[0].hidden).toBe(true);
        return setup;
    };

    it('brings every set back when the camera jumps, and takes no old answer that says hidden', () => {
        const moved = hiddenSet();
        moved.frame();
        moved.camera.position.x += CULL_MOVE_ROOM * 1.5;
        moved.camera.updateMatrixWorld();
        moved.context.answerAll(false);
        moved.frame();
        expect(moved.sets[0].hidden).toBe(false);
        expect(moved.sets[0].run).toBe(0);
        // What was asked before the jump comes back saying hidden, and counts for nothing.
        moved.context.answerAll(false);
        moved.queries.beginFrame(moved.camera);
        expect(moved.sets[0].run).toBe(0);

        const turned = hiddenSet();
        turned.camera.rotateY(2 * Math.asin((CULL_TURN_ROOM * 1.5) / 2));
        turned.camera.updateMatrixWorld();
        turned.frame();
        expect(turned.sets[0].hidden).toBe(false);
    });

    it('stays hidden through a turn: turning uncovers nothing that was all on the screen', () => {
        const { camera, frame, context, sets } = hiddenSet();
        camera.rotateY(0.02);
        camera.updateMatrixWorld();
        frame();
        context.answerAll(false);
        expect(sets[0].hidden).toBe(true);
    });

    it('brings a set back once it is partly off the screen', () => {
        const { camera, frame, sets } = hiddenSet();
        camera.lookAt(30, 0, -30);
        camera.updateMatrixWorld();
        camera.rotateY(0.05);
        camera.updateMatrixWorld();
        frame();
        expect(sets[0].hidden).toBe(false);
    });

    it('brings back a set whose box grew past what was asked about, and not one whose box shrank', () => {
        const grown = hiddenSet();
        grown.queries.setDrawn(grown.sets[0], box(0, 0, -30, 2.5), false);
        expect(grown.sets[0].hidden).toBe(false);
        // Asked about the smaller box: says nothing about the larger.
        grown.context.answerAll(false);
        grown.queries.beginFrame(grown.camera);
        expect(grown.sets[0].run).toBe(0);

        const shrunk = hiddenSet();
        shrunk.queries.setDrawn(shrunk.sets[0], box(0, 0, -30, 1.5), false);
        expect(shrunk.sets[0].hidden).toBe(true);
    });

    it('frees every query when disposed, those waiting too', () => {
        const { context, queries, frame, sets } = setUp();
        sets[0].run = 1;
        for (let run = 0; run < 3; run++) frame();
        const dispose = vi.spyOn(queries.geometry, 'dispose');
        queries.dispose();
        expect(context.deleted).toBe(context.created);
        expect(dispose).toHaveBeenCalled();
        expect(sets[0].pending).toHaveLength(0);
    });

    it('forgets everything with a lost context, and carries on with new queries', () => {
        const { context, queries, camera, renderer, pass, sets } = hiddenSet();
        const before = context.created;
        context.lost = true;
        queries.beginFrame(camera);
        expect(sets[0].hidden).toBe(false);
        expect(sets[0].pending).toHaveLength(0);
        renderer.renderBufferDirect.mockClear();
        pass();
        expect(renderer.renderBufferDirect).not.toHaveBeenCalled();
        queries.dispose();
        expect(context.deleted).toBe(0);

        context.lost = false;
        const set = queries.add();
        queries.setDrawn(set, box(0, 0, -30), false);
        set.run = 1;
        queries.beginFrame(camera);
        pass();
        expect(context.created).toBeGreaterThan(before);
        expect(set.pending).toHaveLength(1);
    });

    it('lets go of a removed set, keeping its queries for others', () => {
        const { context, queries, frame, sets } = setUp();
        sets[0].run = 1;
        frame();
        queries.remove(sets[0]);
        const created = context.created;
        const other = queries.add();
        queries.setDrawn(other, box(0, 0, -30), false);
        other.run = 1;
        frame();
        expect(context.created).toBe(created);
    });
});

describe('the setting', () => {
    it('is on by default, and stays off once turned off', () => {
        expect(normalizeGameSettings({}).quality.occlusionCulling).toBe(true);
        expect(normalizeGameSettings({ quality: { occlusionCulling: false } }).quality.occlusionCulling).toBe(false);
    });
});
