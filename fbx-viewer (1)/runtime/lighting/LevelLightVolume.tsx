import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import {
    readBakedProbeVolume,
    resolveBakedLightingSettings,
    setSceneLightVolume,
    staticLightingObjectIds,
    type LevelBakedLighting,
} from './bakedLighting';
import { loadLightVolume } from './lightVolumeLoader';
import { lightBakeJobs, type LightBakeJob } from './lightBakeJobs';
import { LightBaker } from './lightBaker';

/** Lights the scene with a level's baked volume while mounted; nothing until it has loaded. */
export const LevelLightVolume: React.FC<{ bakedLighting?: LevelBakedLighting | null }> = ({ bakedLighting }) => {
    const scene = useThree(state => state.scene);
    const probes = useMemo(() => readBakedProbeVolume(bakedLighting?.probes), [bakedLighting?.probes]);
    const intensity = resolveBakedLightingSettings(bakedLighting).intensity;
    const [loaded, setLoaded] = useState<{ assetId: string; sh: Float32Array } | null>(null);

    useEffect(() => {
        if (!probes) return;
        let live = true;
        loadLightVolume(probes).then(
            (sh) => { if (live) setLoaded({ assetId: probes.assetId, sh }); },
            // Reported by the loader; the level draws with its unbaked fill.
            () => { if (live) setLoaded(null); },
        );
        return () => { live = false; };
    }, [probes]);

    useEffect(() => {
        if (!probes || loaded?.assetId !== probes.assetId) return;
        return setSceneLightVolume(scene, {
            origin: new THREE.Vector3(...probes.origin),
            spacing: probes.spacing,
            counts: probes.counts,
            sh: loaded.sh,
            intensity,
        });
    }, [scene, probes, loaded, intensity]);
    return null;
};

/** Milliseconds of each frame given to a bake. */
const BAKE_BUDGET_MS = 20;

/** Bakes the light a panel asks for (lightBakeJobs) in this view's scene, a few probes a frame. */
export const LightBakeRunner: React.FC = () => {
    const gl = useThree(state => state.gl);
    const scene = useThree(state => state.scene);
    const invalidate = useThree(state => state.invalidate);
    const active = useRef<{ job: LightBakeJob; baker: LightBaker } | null>(null);

    // A new bake wakes a canvas that only draws on demand.
    useEffect(() => lightBakeJobs.subscribe(() => invalidate()), [invalidate]);
    useEffect(() => () => {
        const current = active.current;
        active.current = null;
        if (!current) return;
        current.baker.dispose();
        lightBakeJobs.fail(current.job, new Error('The level view closed before the bake finished.'));
    }, []);

    useFrame(() => {
        const job = lightBakeJobs.current();
        let current = active.current;
        if (current && current.job !== job) {
            // Cancelled.
            current.baker.dispose();
            active.current = current = null;
        }
        if (!job) return;
        try {
            if (!current) {
                // Several views of one level each run a runner; the first to see the bake takes it.
                if (job.started) return;
                const { levelObjects, settings } = job.request;
                current = active.current = {
                    job,
                    baker: new LightBaker(gl, scene, { staticIds: staticLightingObjectIds(levelObjects), spacing: settings.spacing, bounces: settings.bounces }),
                };
                job.started = true;
            }
            if (current.baker.step(BAKE_BUDGET_MS)) {
                const result = current.baker.result();
                current.baker.dispose();
                active.current = null;
                lightBakeJobs.finish(job, result);
            } else {
                lightBakeJobs.report(job, current.baker.progress);
                invalidate();
            }
        } catch (error) {
            current?.baker.dispose();
            active.current = null;
            lightBakeJobs.fail(job, error);
        }
    });
    return null;
};
