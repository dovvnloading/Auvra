import { afterEach, describe, expect, it } from 'vitest';
import { clearWebgpuFallback, cookingDevice, recordWebgpuFallback, setCookingDevice, textureCookingCapabilities, webgpuFallbacks } from '../../texturing/gpu/cookingDevice';

afterEach(() => {
    setCookingDevice(null);
    webgpuFallbacks.clear();
});

describe('runtime GPU texture-cooking device lifecycle', () => {
    it('retains fallbacks only for the same device, clearing them on device replacement', () => {
        const first = { id: 'first' };
        const second = { id: 'second' };
        setCookingDevice(first);
        webgpuFallbacks.set('wood', 'untranslatable node');
        setCookingDevice(first);
        expect(webgpuFallbacks.get('wood')).toBe('untranslatable node');
        setCookingDevice(second);
        expect(cookingDevice()).toBe(second);
        expect(webgpuFallbacks.size).toBe(0);
    });

    it('drops stale material ids on WebGL2 switch/device loss, without touching unrelated state', () => {
        const gpu = { id: 'device' };
        setCookingDevice(gpu);
        webgpuFallbacks.set('shared-id', 'a previous project could not cook');
        setCookingDevice(null);
        expect(cookingDevice()).toBeNull();
        expect(webgpuFallbacks.size).toBe(0);
        setCookingDevice(gpu);
        expect(webgpuFallbacks.has('shared-id')).toBe(false);
    });

    it('reports actual device feature flags without claiming support for untested graph families', () => {
        expect(textureCookingCapabilities()).toMatchObject({
            backend: 'webgl2',
            maxTextureDimension2D: null,
            compression: { bc: null, etc2: null, astc: null },
            float32Filterable: null,
        });
        const mock = {
            limits: { maxTextureDimension2D: 4096 },
            features: { has: (name: string) => ['texture-compression-bc', 'float32-filterable'].includes(name) },
        };
        setCookingDevice(mock);
        webgpuFallbacks.set('stone', 'node pathWarp did not compile');
        expect(textureCookingCapabilities()).toEqual({
            backend: 'webgpu',
            maxTextureDimension2D: 4096,
            compression: { bc: true, etc2: false, astc: false },
            float32Filterable: true,
            fallbacks: [{ materialId: 'stone', reason: 'node pathWarp did not compile' }],
        });
        setCookingDevice(null);
        expect(textureCookingCapabilities().fallbacks).toEqual([]);
    });

    it('does not permit an old asynchronous GPU cook to alter the new device’s fallback diagnostics', () => {
        const oldDevice = { id: 'lost' };
        const replacement = { id: 'replacement' };
        setCookingDevice(oldDevice);
        expect(recordWebgpuFallback(oldDevice, 'shared', 'first device failed')).toBe(true);
        setCookingDevice(replacement);
        expect(webgpuFallbacks.size).toBe(0);
        expect(recordWebgpuFallback(oldDevice, 'shared', 'late failure from old GPU')).toBe(false);
        expect(webgpuFallbacks.size).toBe(0);
        expect(recordWebgpuFallback(replacement, 'shared', 'current device cannot compile')).toBe(true);
        expect(clearWebgpuFallback(oldDevice, 'shared')).toBe(false);
        expect(webgpuFallbacks.get('shared')).toBe('current device cannot compile');
        expect(clearWebgpuFallback(replacement, 'shared')).toBe(true);
        expect(webgpuFallbacks.size).toBe(0);
    });

    it('does not mistake an identical device setting for a device reset', () => {
        const device = { id: 'same' };
        setCookingDevice(device);
        webgpuFallbacks.set('stone', 'some supported fallback');
        setCookingDevice(device);
        expect(webgpuFallbacks.has('stone')).toBe(true);
    });
});
