import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { previewBackdrop, previewSeesThrough } from '../../components/Materials/previewLighting';
import { STARTER_MATERIALS } from '../../runtime/materials/starterMaterials';

const starter = (key: string) => STARTER_MATERIALS.find(candidate => candidate.key === key)!.graph();

describe('the material preview\'s surroundings', () => {
    it('are always shown behind a see-through material, so glass has something to show', () => {
        expect(previewSeesThrough(starter('frostedGlass'))).toBe(true);
        expect(previewSeesThrough(starter('carPaint'))).toBe(false);
        expect(previewSeesThrough(starter('velvet'))).toBe(false);
    });

    it('stand the studio and night lighting in front of a lit backdrop, lighter overhead', () => {
        for (const lighting of ['studio', 'night'] as const) {
            const backdrop = previewBackdrop(lighting)!;
            expect(backdrop.mapping).toBe(THREE.EquirectangularReflectionMapping);
            expect(backdrop.colorSpace).toBe(THREE.SRGBColorSpace);
            const { data, width, height } = backdrop.image as { data: Uint8Array; width: number; height: number };
            const brightness = (row: number) => data[row * width * 4] + data[row * width * 4 + 1] + data[row * width * 4 + 2];
            expect(brightness(height - 1)).toBeGreaterThan(brightness(height / 2));
            expect(brightness(height / 2)).toBeGreaterThan(brightness(0));
            backdrop.dispose();
        }
        // A studio's backdrop is light enough for glass to read against.
        const studio = previewBackdrop('studio')!;
        expect((studio.image as { data: Uint8Array }).data[(studio.image as { width: number }).width * 4 * 40]).toBeGreaterThan(160);
    });

    it('show the room and the outdoors as they are', () => {
        expect(previewBackdrop('room')).toBeNull();
        expect(previewBackdrop('outdoor')).toBeNull();
    });
});
