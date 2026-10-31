import type * as THREE from 'three';
import type { LevelObject } from '../types';
import type { AssetSelection, GameContentLoader } from '../utils/projectHydration';
import type { LevelAssetNeeds } from './levelAssets';

/**
 * ASSETS IN MEMORY
 *
 * Keeps what the levels of a running game need. Starting a level loads what it needs and is not
 * held. What earlier levels used stays, so going back is quick, until holding it would pass the
 * budget: then what was used longest ago goes first. A level always gets what it needs, even past
 * the budget, since it cannot run without it.
 */

/** How much a game holds before it starts letting go of what earlier levels used. */
export const DEFAULT_ASSET_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

type HeldKind = keyof LevelAssetNeeds;
const HELD_KINDS: readonly HeldKind[] = ['models', 'textures', 'audio', 'attachments', 'levels'];

interface Held {
    kind: HeldKind;
    id: string;
    bytes: number;
    /** The start this asset was last needed by; the lowest goes first. */
    used: number;
}

const textureBytes = (texture: THREE.Texture): number => {
    const compressed = texture as THREE.CompressedTexture;
    if (compressed.isCompressedTexture) {
        return (compressed.mipmaps ?? []).reduce((sum, level) => sum + ((level.data as ArrayBufferView | undefined)?.byteLength ?? 0), 0);
    }
    const image = texture.image as { width?: number; height?: number } | undefined;
    // Four bytes a pixel and a third more for the mips.
    return (image?.width ?? 0) * (image?.height ?? 0) * 4 * (4 / 3);
};

/** About what an object's meshes and textures hold in memory, each counted once. */
export const objectMemoryBytes = (object: THREE.Object3D): number => {
    const seen = new Set<object>();
    let bytes = 0;
    const addBuffer = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined) => {
        const array = (attribute as THREE.InterleavedBufferAttribute | undefined)?.data?.array ?? (attribute as THREE.BufferAttribute | undefined)?.array;
        if (!array || seen.has(array)) return;
        seen.add(array);
        bytes += array.byteLength;
    };
    object.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        const geometry = mesh.geometry;
        if (geometry && !seen.has(geometry)) {
            seen.add(geometry);
            Object.values(geometry.attributes).forEach(addBuffer);
            addBuffer(geometry.index);
        }
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            if (!material) continue;
            for (const value of Object.values(material)) {
                const texture = value as THREE.Texture | null;
                if (!texture?.isTexture || seen.has(texture)) continue;
                seen.add(texture);
                bytes += textureBytes(texture);
            }
        }
    });
    return bytes;
};

const terrainBytes = (objects: readonly LevelObject[], levelId: string): number => objects
    .filter(object => object.levelId === levelId && object.terrainData)
    .reduce((sum, object) => sum + ((object.terrainData?.heights?.length ?? 0) + (object.terrainData?.splat?.length ?? 0)) * 8, 0);

export class LevelAssetResidency {
    private readonly held = new Map<string, Held>();
    private starts = 0;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly loader: GameContentLoader,
        private readonly needsOf: (levelId: string) => LevelAssetNeeds,
        /** About what an asset not yet loaded will take, in bytes. */
        private readonly estimate: (kind: HeldKind, id: string) => number,
        private readonly budgetBytes: number = DEFAULT_ASSET_BUDGET_BYTES,
    ) {}

    private static key(kind: HeldKind, id: string): string {
        return `${kind}:${id}`;
    }

    /** Whether `levelId` could start now without loading anything. */
    holds(levelId: string): boolean {
        const needs = this.needsOf(levelId);
        return HELD_KINDS.every(kind => [...needs[kind]].every(id => this.held.has(LevelAssetResidency.key(kind, id))));
    }

    /** What is held now, in bytes. */
    heldBytes(): number {
        let bytes = 0;
        for (const held of this.held.values()) bytes += held.bytes;
        return bytes;
    }

    /**
     * Makes `levelId` ready to start, one level at a time. What goes to make room goes first, so the
     * old and the new are not in memory together. Nothing may be drawing an old level by now.
     */
    prepare(levelId: string): Promise<void> {
        const run = this.queue.then(() => this.prepareNow(levelId));
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async prepareNow(levelId: string): Promise<void> {
        const needs = this.needsOf(levelId);
        const start = ++this.starts;
        let incoming = 0;
        for (const kind of HELD_KINDS) {
            for (const id of needs[kind]) {
                const held = this.held.get(LevelAssetResidency.key(kind, id));
                if (held) held.used = start;
                else incoming += this.estimate(kind, id);
            }
        }
        this.makeRoom(incoming, start);
        try {
            await this.loader.load(needs);
        } finally {
            // Whatever did load is held, even if something else failed.
            this.measure(needs, start);
        }
    }

    private makeRoom(incoming: number, start: number): void {
        let bytes = this.heldBytes() + incoming;
        if (bytes <= this.budgetBytes) return;
        const candidates = [...this.held.values()].filter(held => held.used !== start).sort((a, b) => a.used - b.used);
        const selection: Record<HeldKind, Set<string>> = { models: new Set(), textures: new Set(), audio: new Set(), attachments: new Set(), levels: new Set() };
        for (const held of candidates) {
            if (bytes <= this.budgetBytes) break;
            selection[held.kind].add(held.id);
            this.held.delete(LevelAssetResidency.key(held.kind, held.id));
            bytes -= held.bytes;
        }
        this.loader.release(selection as AssetSelection);
    }

    private measure(needs: LevelAssetNeeds, start: number): void {
        const content = this.loader.content();
        const objects = this.loader.objects();
        const note = (kind: HeldKind, id: string, bytes: number) => {
            const key = LevelAssetResidency.key(kind, id);
            if (!this.held.has(key) && needs[kind].has(id)) this.held.set(key, { kind, id, bytes, used: start });
        };
        for (const model of content.models) note('models', model.id, objectMemoryBytes(model.object));
        for (const attachment of content.attachments) note('attachments', attachment.id, objectMemoryBytes(attachment.object));
        for (const texture of content.textures) note('textures', texture.id, this.estimate('textures', texture.id));
        for (const audio of content.audioAssets) note('audio', audio.id, this.estimate('audio', audio.id));
        for (const levelId of needs.levels) note('levels', levelId, terrainBytes(objects, levelId));
    }
}
