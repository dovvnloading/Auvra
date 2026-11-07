import { materialGraphLook } from '../../runtime/materials/materialGraph';
import { materialAssetDocument, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import type { BallPictureSource } from './materialBalls';

/**
 * The balls the Materials list shows (ProjectBalls.tsx), by material: each drawn again only when what it draws with
 * changes, once edits have settled, one at a time.
 */

/** What a ball shows: the material's look, its pictures, and which of its textures can be read yet. */
export const ballLook = (asset: MaterialAsset, available: (textureId: string) => boolean): string =>
    [materialGraphLook(asset.graph), JSON.stringify(asset.pictures ?? {}), materialAssetDocument(asset).textureIds.filter(available).sort().join(',')].join('|');

type Draw = (asset: MaterialAsset, source: BallPictureSource) => Promise<Blob | null>;

export class BallShelf {
    /** Counts balls drawn, for subscribers. */
    version = 0;
    private readonly balls = new Map<string, { look: string; url: string | null }>();
    private readonly wanted = new Map<string, { asset: MaterialAsset; look: string; source: BallPictureSource; due: number }>();
    private readonly listeners = new Set<() => void>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private drawing = false;
    private generation = -1;

    constructor(
        private readonly draw: Draw,
        private readonly settle = 600,
        private readonly now: () => number = () => Date.now(),
        private readonly urlOf: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
        private readonly letGo: (url: string) => void = (url) => URL.revokeObjectURL(url),
    ) {}

    /** The ball shown for a material: the last drawn, which may be of an older look while a new one waits. */
    ball(id: string): string | null {
        return this.balls.get(id)?.url ?? null;
    }

    /** Asks for a material's ball as it looks now; nothing is drawn when it is already. */
    want(asset: MaterialAsset, look: string, source: BallPictureSource, generation: number): void {
        if (generation !== this.generation) this.clear(generation);
        if (this.balls.get(asset.id)?.look === look) {
            this.wanted.delete(asset.id);
            return;
        }
        const waiting = this.wanted.get(asset.id);
        if (waiting?.look === look) return;
        // Edits in quick succession are drawn once they settle.
        this.wanted.set(asset.id, { asset, look, source, due: this.now() + this.settle });
        this.schedule();
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Lets go of every ball (another project opened). */
    clear(generation = this.generation): void {
        for (const { url } of this.balls.values()) if (url) this.letGo(url);
        this.balls.clear();
        this.wanted.clear();
        this.generation = generation;
        this.emit();
    }

    private schedule(): void {
        if (this.timer || this.drawing || !this.wanted.size) return;
        const next = Math.min(...[...this.wanted.values()].map(entry => entry.due));
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.drawNext();
        }, Math.max(0, next - this.now()));
    }

    private async drawNext(): Promise<void> {
        const now = this.now();
        const ready = [...this.wanted.values()].filter(entry => entry.due <= now).sort((a, b) => a.due - b.due)[0];
        if (!ready) {
            this.schedule();
            return;
        }
        this.wanted.delete(ready.asset.id);
        this.drawing = true;
        const generation = this.generation;
        try {
            const blob = await this.draw(ready.asset, ready.source).catch(() => null);
            if (generation === this.generation) {
                const before = this.balls.get(ready.asset.id)?.url;
                if (before) this.letGo(before);
                this.balls.set(ready.asset.id, { look: ready.look, url: blob ? this.urlOf(blob) : null });
                this.emit();
            }
        } finally {
            this.drawing = false;
            this.schedule();
        }
    }

    private emit(): void {
        this.version++;
        for (const listener of this.listeners) listener();
    }
}
