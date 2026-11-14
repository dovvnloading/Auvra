import { cookGarment, readGarmentPattern, type GarmentPattern } from './pattern';
import { encodeGarmentCache, type GarmentCacheFrame } from './cache';
import { GARMENT_FABRICS, FITTING_TORSO, fittingOffsetAt, readFabricOverrides, type GarmentFabricOverrides } from './fitting';
import { GarmentSimulation, GARMENT_STEP } from './solver';

export interface FittingBakeInput {
    pattern: GarmentPattern;
    fabric: keyof typeof GARMENT_FABRICS;
    animateTorso: boolean;
    selfCollision: boolean;
    material?: GarmentFabricOverrides;
}
export interface FittingBakeReference { assetId: string; recipe: string; duration: number }
export type FittingBakeReply = { progress: number } | { bytes: ArrayBuffer; duration: number } | { error: string };

export async function fittingDigest(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
    // A typed view also works when a host or worker supplies an ArrayBuffer from a different realm.
    const view = ArrayBuffer.isView(bytes) ? bytes : new Uint8Array(bytes);
    const digest = await crypto.subtle.digest('SHA-256', view);
    return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}

/** Bump the recipe version when changes to the cooker, solver or fitting trajectory invalidate recorded poses. */
export function fittingBakeRecipe(input: FittingBakeInput): Promise<string> {
    const pattern = readGarmentPattern(input.pattern);
    const firstLayer = pattern.panels[0].layer ?? 0;
    const usesClothContact = input.selfCollision || pattern.panels.some(p => (p.layer ?? 0) !== firstLayer);
    // Revision 2 changes cloth-to-cloth contact. Keep clips from the unaffected fitting path usable.
    const recipe: unknown[] = [usesClothContact ? 2 : 1, pattern, input.fabric, input.animateTorso, input.selfCollision];
    const overrides = readFabricOverrides(input.fabric, input.material);
    if (overrides) recipe.push(overrides);
    const canonical = JSON.stringify(recipe);
    return fittingDigest(new TextEncoder().encode(canonical));
}

export function readFittingBake(value: unknown): FittingBakeReference | null {
    if (!value || typeof value !== 'object') return null;
    const ref = value as Partial<FittingBakeReference>;
    if (typeof ref.assetId !== 'string' || !/^[0-9a-f]{64}$/.test(ref.assetId) ||
        typeof ref.recipe !== 'string' || !/^[0-9a-f]{64}$/.test(ref.recipe) ||
        typeof ref.duration !== 'number' || !Number.isFinite(ref.duration) || ref.duration <= 0 || ref.duration > 10) return null;
    return { assetId: ref.assetId, recipe: ref.recipe, duration: ref.duration };
}

/** Reproducible owner-local fitting clip. The input trajectory is the display form, with still air and no skeleton. */
export function bakeFitting(input: FittingBakeInput, seconds: number, progress: (ratio: number) => void): ArrayBuffer {
    const fps = 30;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 10) throw new Error('Choose a bake duration from 1 to 10 seconds.');
    const cooked = cookGarment(input.pattern);
    const framesNeeded = seconds * fps + 1;
    if (framesNeeded * cooked.positions.length * 4 > 32 * 1024 * 1024) throw new Error('Use a shorter clip or a coarser mesh for this bake.');
    const simulation = new GarmentSimulation(cooked, { ...GARMENT_FABRICS[input.fabric],
        ...readFabricOverrides(input.fabric, input.material), selfCollision: input.selfCollision });
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const torso = { ...FITTING_TORSO };
    const colliders = [torso];
    const offset = { x: 0, y: 0, z: 0 };
    const frames: GarmentCacheFrame[] = [];
    const capture = () => frames.push({ positions: simulation.positions.slice(), torso: [torso.x, torso.y + torso.height / 2, torso.z] });
    simulation.reset(matrix);
    capture();
    const ticksPerFrame = Math.round(1 / (fps * GARMENT_STEP));
    for (let frame = 1; frame < framesNeeded; frame++) {
        for (let substep = 1; substep <= ticksPerFrame; substep++) {
            const time = ((frame - 1) * ticksPerFrame + substep) * GARMENT_STEP;
            fittingOffsetAt(time, input.animateTorso, offset);
            matrix[12] = offset.x; matrix[13] = offset.y; matrix[14] = offset.z;
            torso.x = offset.x; torso.y = FITTING_TORSO.y + offset.y; torso.z = offset.z;
            if (!simulation.step(GARMENT_STEP, matrix, null, colliders)) throw new Error('Garment bake stopped before completing a tick.');
        }
        capture();
        if (frame % 5 === 0) progress(frame / (framesNeeded - 1));
    }
    return encodeGarmentCache(frames, fps);
}
