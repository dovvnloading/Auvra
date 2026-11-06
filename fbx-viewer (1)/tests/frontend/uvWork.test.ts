import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPartMesh } from '../../texturing/mesh/partMesh';
import { DEFAULT_PACK } from '../../texturing/uv/pack';
import { DEFAULT_UNWRAP } from '../../texturing/uv/unwrap';
import { UvWorkClient, chartFromData, chartToData, handleUvRequest, measureLayout, type UvRequest, type UvResponse, type UvWorkState, type WorkerLike } from '../../texturing/uv/uvWork';
import { buildCharts, buildTopology, existingSeams } from '../../texturing/uv/uvTopology';

const sphere = () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), material));
    return buildPartMesh(root, new Set([material]), { udim: false });
};

/** A stand-in worker: answers through the same handler, a turn later, with the message copied as a real one would be. */
const relayWorker = (log: string[]): WorkerLike => {
    const state: UvWorkState = { topology: null };
    const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage: (message) => {
            const request = structuredClone(message) as UvRequest;
            log.push(request.kind);
            setTimeout(() => worker.onmessage?.({ data: handleUvRequest(state, request).response } as MessageEvent), 0);
        },
        terminate: () => log.push('terminated'),
    };
    return worker;
};

describe('UV work requests', () => {
    it('answers setup, unwrap, pack and measure by number, and refuses work before setup', () => {
        const part = sphere();
        const state: UvWorkState = { topology: null };
        const early = handleUvRequest(state, { id: 1, kind: 'pack', islands: [], settings: DEFAULT_PACK }).response;
        expect(early).toEqual({ id: 1, ok: false, error: 'The surface was not given to the UV worker.' });
        expect(handleUvRequest(state, { id: 2, kind: 'setup', positions: part.positions, indices: part.indices }).response).toEqual({ id: 2, ok: true, kind: 'setup' });
        const unwrapped = handleUvRequest(state, { id: 3, kind: 'unwrap', settings: DEFAULT_UNWRAP, keep: new Float64Array(0), seams: null });
        const answer = unwrapped.response as Extract<UvResponse, { kind: 'unwrap' }>;
        expect(answer.id).toBe(3);
        expect(answer.charts.length).toBeGreaterThan(1);
        expect(answer.flat).toHaveLength(answer.charts.length);
        // Its buffers can be handed over, none twice.
        expect(new Set(unwrapped.transfer).size).toBe(unwrapped.transfer.length);
        const islands = answer.charts.map((chart, i) => ({ uv: answer.flat[i], triangles: chart.corners, densityScale: 1, keepAt: null }));
        const packed = handleUvRequest(state, { id: 4, kind: 'pack', islands, settings: DEFAULT_PACK }).response as Extract<UvResponse, { kind: 'pack' }>;
        expect(packed.placements).toHaveLength(islands.length);
        for (const placement of packed.placements) for (const value of placement.uv) { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1); }
        const cornerUv = new Float32Array(part.indices.length * 2);
        const measured = handleUvRequest(state, { id: 5, kind: 'measure', cornerUv, chartFaces: answer.charts.map((chart) => chart.faces), tiles: 1, size: 1024 }).response as Extract<UvResponse, { kind: 'measure' }>;
        expect(measured.triangleStretch).toHaveLength(part.indices.length / 3);
        expect(measured.stats.islands).toBe(answer.charts.length);
    });

    it('carries charts between threads unchanged', () => {
        const part = sphere();
        const topology = buildTopology(part.positions, part.indices);
        const [chart] = buildCharts(topology, existingSeams(topology, part.indices, part.uvs));
        const back = chartFromData(structuredClone(chartToData(chart)));
        expect(back.faces).toEqual(chart.faces);
        expect(back.vertexWeld).toEqual(chart.vertexWeld);
        expect(Array.from(back.corners)).toEqual(Array.from(chart.corners));
    });

    it('measures a layout the same with and without looking for overlaps, but for the overlaps', () => {
        const part = sphere();
        const topology = buildTopology(part.positions, part.indices);
        const charts = buildCharts(topology, existingSeams(topology, part.indices, part.uvs));
        const cornerUv = Float32Array.from({ length: part.indices.length * 2 }, (_, i) => part.uvs[part.indices[i >> 1] * 2 + (i & 1)]);
        const quick = measureLayout(topology, cornerUv, charts.map((chart) => chart.faces), 1, 1024, false);
        const full = measureLayout(topology, cornerUv, charts.map((chart) => chart.faces), 1, 1024, true);
        expect(quick.stats.islands).toBe(full.stats.islands);
        expect(quick.stats.stretch).toEqual(full.stats.stretch);
        expect(full.stats.folded).toBeGreaterThanOrEqual(quick.stats.folded);
    });
});

describe('the UV work client', () => {
    it('sends work to the worker and hands each answer to the request that asked', async () => {
        const part = sphere();
        const log: string[] = [];
        const client = new UvWorkClient(part.positions, part.indices, () => relayWorker(log));
        expect(client.offThread).toBe(true);
        const result = await client.unwrap(DEFAULT_UNWRAP, new Set());
        expect(result.charts.length).toBeGreaterThan(1);
        expect(result.flat).toHaveLength(result.charts.length);
        const [placements, measured] = await Promise.all([
            client.pack(result.charts.map((chart, i) => ({ uv: result.flat[i].uv, triangles: chart.corners, area3d: 0 })), DEFAULT_PACK),
            client.measure(new Float32Array(part.indices.length * 2), result.charts, 1, 512),
        ]);
        expect(placements).toHaveLength(result.charts.length);
        expect(measured.triangleStretch).toHaveLength(part.indices.length / 3);
        expect(log).toEqual(['setup', 'unwrap', 'pack', 'measure']);
        client.dispose();
        expect(log).toContain('terminated');
    });

    it('does the same work on the main thread where there is no worker', async () => {
        const part = sphere();
        const client = new UvWorkClient(part.positions, part.indices, () => null);
        expect(client.offThread).toBe(false);
        const result = await client.unwrap(DEFAULT_UNWRAP, new Set());
        expect(result.charts.length).toBeGreaterThan(1);
        const placements = await client.pack(result.charts.map((chart, i) => ({ uv: result.flat[i].uv, triangles: chart.corners, area3d: 0 })), DEFAULT_PACK);
        expect(placements).toHaveLength(result.charts.length);
    });

    it('gives up requests waiting on a worker that fails, then works on the main thread', async () => {
        const part = sphere();
        let worker: WorkerLike | null = null;
        const client = new UvWorkClient(part.positions, part.indices, () => {
            worker = { onmessage: null, onerror: null, postMessage: () => undefined, terminate: () => undefined };
            return worker;
        });
        const waiting = client.measure(new Float32Array(part.indices.length * 2), [], 1, 256);
        (worker as unknown as WorkerLike).onerror?.({ message: 'It broke.' } as ErrorEvent);
        await expect(waiting).rejects.toThrow('It broke.');
        expect(client.offThread).toBe(false);
        const again = await client.measure(new Float32Array(part.indices.length * 2), [], 1, 256);
        expect(again.triangleStretch).toHaveLength(part.indices.length / 3);
    });

    it('gives up waiting requests once stopped', async () => {
        const part = sphere();
        const client = new UvWorkClient(part.positions, part.indices, () => ({ onmessage: null, onerror: null, postMessage: () => undefined, terminate: () => undefined }));
        const stopped = client.measure(new Float32Array(0), [], 1, 256);
        client.dispose();
        await expect(stopped).rejects.toThrow('The UV work was stopped.');
    });
});
