/**
 * M0.5 — bounded, browser-side timing observations for texture graph editing.
 *
 * These are the elapsed editor times through graph evaluation and preview/
 * thumbnail update, NOT GPU timestamps or native-game frame durations. Each
 * sample comes from a successfully finished run. Aborted runs are excluded.
 *
 * Group samples by a shape/resolution signature; do not compare a 512 px
 * three-node graph with a 4K 300-node graph as though they were the same job.
 */
export interface TextureCookTimingSample {
    /** The number of nodes actually recomputed; zero is a cache-only run. */
    drawnNodes: number;
    /** Elapsed wall-clock time for the evaluated graph + preview update. */
    milliseconds: number;
}

export interface TextureCookTimingSummary {
    totalRuns: number;
    recomputedRuns: number;
    cachedRuns: number;
    /** Median of successful runs that actually recomputed nodes. */
    p50Milliseconds: number | null;
    /** Nearest-rank 95th percentile (successful recomputations only). */
    p95Milliseconds: number | null;
    /** Percentiles do NOT include runs that recomputed no nodes. */
    sampleWindow: number;
}

const MAX_SAMPLES = 64;

/** Nearest-rank percentile; caller supplies only finite positive times. */
const percentile = (values: readonly number[], fraction: number): number | null => {
    if (!values.length) return null;
    const ordered = [...values].sort((a, b) => a - b);
    return ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)];
};

export class TextureCookTimingWindow {
    private key: string | null = null;
    private samples: TextureCookTimingSample[] = [];

    /** A new shape/resolution starts its own window, even if the count matches. */
    record(groupKey: string, sample: TextureCookTimingSample): void {
        if (!groupKey || !Number.isFinite(sample.milliseconds) || sample.milliseconds < 0
            || !Number.isInteger(sample.drawnNodes) || sample.drawnNodes < 0) return;
        if (groupKey !== this.key) {
            this.key = groupKey;
            this.samples = [];
        }
        this.samples.push({ drawnNodes: sample.drawnNodes, milliseconds: sample.milliseconds });
        if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    }

    clear(): void {
        this.key = null;
        this.samples = [];
    }

    summary(): TextureCookTimingSummary {
        const elapsed = this.samples.filter((sample) => sample.drawnNodes > 0).map((sample) => sample.milliseconds);
        return {
            totalRuns: this.samples.length,
            recomputedRuns: elapsed.length,
            cachedRuns: this.samples.length - elapsed.length,
            p50Milliseconds: percentile(elapsed, 0.5),
            p95Milliseconds: percentile(elapsed, 0.95),
            sampleWindow: MAX_SAMPLES,
        };
    }
}
