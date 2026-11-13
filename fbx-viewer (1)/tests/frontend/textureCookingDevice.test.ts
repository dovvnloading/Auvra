import { afterEach, describe, expect, it } from 'vitest';
import { cookingDevice, setCookingDevice, webgpuFallbacks } from '../../texturing/gpu/cookingDevice';

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

    it('does not mistake an identical device setting for a device reset', () => {
        const device = { id: 'same' };
        setCookingDevice(device);
        webgpuFallbacks.set('stone', 'some supported fallback');
        setCookingDevice(device);
        expect(webgpuFallbacks.has('stone')).toBe(true);
    });
});
