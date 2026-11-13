import { expect, it, vi } from 'vitest';
import { TextureGpu, type GpuImage } from '../../texturing/gpu/textureGpu';

const makeImage = (kind: GpuImage['kind'], precision: GpuImage['precision']) =>
    ({ kind, precision, width: 8, height: 4 }) as GpuImage;

it.each([['color', 8], ['color', 16], ['color', 32], ['gray', 8], ['gray', 16], ['gray', 32]] as const)(
    'queues an RGBA8 readback for %s at %i bits', async (kind, precision) => {
        const source = makeImage(kind, precision);
        const rgba = makeImage('color', 8);
        const pending = Promise.resolve(new Uint8Array(8 * 4 * 4));
        const gpu = Object.create(TextureGpu.prototype) as TextureGpu;
        gpu.image = vi.fn().mockReturnValue(rgba);
        gpu.passNow = vi.fn();
        gpu.copy = vi.fn();
        gpu.release = vi.fn();
        const queue = vi.fn().mockReturnValue(pending);
        Object.assign(gpu, { readRgba8TargetLater: queue });
        expect(gpu.readRgba8Later(source)).toBe(pending);
        if (kind === 'color' && precision === 8) {
            expect(queue).toHaveBeenCalledWith(source);
            expect(gpu.image).not.toHaveBeenCalled();
            expect(gpu.release).not.toHaveBeenCalled();
        } else {
            expect(gpu.image).toHaveBeenCalledWith(8, 4, 'color', 8);
            if (kind === 'gray') expect(gpu.passNow).toHaveBeenCalledWith(rgba, expect.objectContaining({
                inputs: { source }, fragment: expect.stringContaining('vec4(g, g, g, 1.0)'),
            }));
            else expect(gpu.copy).toHaveBeenCalledWith(source, rgba);
            expect(queue).toHaveBeenCalledWith(rgba);
            expect(gpu.release).toHaveBeenCalledWith(rgba);
        }
    },
);
