import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

export interface FrameStats {
    fps: number;
    frameMs: number;
    worstFrameMs: number;
    drawCalls: number;
    triangles: number;
    geometries: number;
    textures: number;
    heapMb: number | null;
}

/** Rolling frame statistics; pure so it can be tested without a renderer. */
export class FrameSampler {
    private readonly samples: number[] = [];
    constructor(private readonly size = 120) {}

    add(deltaSeconds: number) {
        if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
        this.samples.push(deltaSeconds * 1000);
        if (this.samples.length > this.size) this.samples.shift();
    }

    summary(): { fps: number; frameMs: number; worstFrameMs: number } {
        if (!this.samples.length) return { fps: 0, frameMs: 0, worstFrameMs: 0 };
        const average = this.samples.reduce((sum, value) => sum + value, 0) / this.samples.length;
        return { fps: 1000 / average, frameMs: average, worstFrameMs: Math.max(...this.samples) };
    }
}

const heapMegabytes = (): number | null => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return memory ? memory.usedJSHeapSize / (1024 * 1024) : null;
};

// Latest stats live outside React state so publishing them re-renders only the panel.
let latestStats: FrameStats | null = null;
const statsListeners = new Set<() => void>();
const publishStats = (stats: FrameStats) => { latestStats = stats; statsListeners.forEach(listener => listener()); };
const subscribeStats = (listener: () => void) => { statsListeners.add(listener); return () => { statsListeners.delete(listener); }; };
const readStats = () => latestStats;

/**
 * Collects renderer statistics inside the canvas and publishes them a few times per second.
 * Mount inside the R3F canvas; render <ProfilerPanel> outside it.
 */
export const ProfilerProbe: React.FC<{ enabled: boolean }> = ({ enabled }) => {
    const gl = useThree(state => state.gl);
    const sampler = useRef(new FrameSampler());
    const elapsed = useRef(0);

    useFrame((_, delta) => {
        if (!enabled) return;
        sampler.current.add(delta);
        elapsed.current += delta;
        if (elapsed.current < 0.25) return;
        elapsed.current = 0;
        const { render, memory } = gl.info;
        publishStats({
            ...sampler.current.summary(),
            drawCalls: render.calls,
            triangles: render.triangles,
            geometries: memory.geometries,
            textures: memory.textures,
            heapMb: heapMegabytes(),
        });
    });
    return null;
};

/** Small fixed overlay; pair it with useProfilerToggle for the F3 shortcut. */
export const ProfilerPanel: React.FC<{ visible: boolean }> = ({ visible }) => {
    const stats = useSyncExternalStore(subscribeStats, readStats, readStats);
    if (!visible || !stats) return null;
    const rows: [string, string][] = [
        ['FPS', stats.fps.toFixed(0)],
        ['Frame', `${stats.frameMs.toFixed(1)} ms (worst ${stats.worstFrameMs.toFixed(1)})`],
        ['Draw calls', String(stats.drawCalls)],
        ['Triangles', stats.triangles.toLocaleString()],
        ['Geometries', String(stats.geometries)],
        ['Textures', String(stats.textures)],
        ...(stats.heapMb !== null ? [['JS heap', `${stats.heapMb.toFixed(0)} MB`] as [string, string]] : []),
    ];
    return (
        <div className="absolute top-2 right-2 z-[80] rounded bg-black/70 px-3 py-2 font-mono text-[11px] text-white/90 pointer-events-none select-none">
            {rows.map(([label, value]) => (
                <div key={label} className="flex justify-between gap-6"><span className="text-white/50">{label}</span><span>{value}</span></div>
            ))}
        </div>
    );
};

/** F3 toggles profiler visibility. */
export const useProfilerToggle = (initial = false) => {
    const [visible, setVisible] = useState(initial);
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => { if (event.code === 'F3') { event.preventDefault(); setVisible(value => !value); } };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
    return visible;
};
