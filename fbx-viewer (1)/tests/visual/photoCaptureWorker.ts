import { PhotoCapture } from '../../texturing/paint/photoCapture';
import { encodePng, pngBitDepth, readPng16 } from '../../texturing/png';

/** Exercise the dedicated worker on Chromium and WebView-compatible APIs, including cancellation during a render. */
export async function verifyPhotoCaptureWorker() {
    const size = 64;
    const angles = [0, 2 * Math.PI / 3, 4 * Math.PI / 3];
    const files = await Promise.all(angles.map(async (angle, index) => {
        const grey = new Uint8Array(size * size);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            grey[y * size + x] = 128 + Math.round(45 * Math.cos(x / 6) * Math.cos(angle) + 45 * Math.sin(y / 6) * Math.sin(angle));
        }
        return new File([await encodePng(grey, size, size, 1)], `cloth-${index}.png`, { type: 'image/png' });
    }));
    const capture = new PhotoCapture();
    try {
        const set = await capture.read(files);
        if (set.size !== size || !set.sameSize || set.thumbnails.length !== files.length ||
            set.thumbnails.some(url => !url.startsWith('data:image/jpeg')) || set.estimate.azimuths.length !== angles.length) {
            throw new Error('The photo worker did not return the expected aligned previews.');
        }
        const maps = await capture.render(angles, Math.PI / 4);
        for (const [name, blob] of Object.entries(maps)) {
            const pixels = await readPng16(blob);
            if (pixels.width !== size || pixels.height !== size || await pngBitDepth(blob) !== (name === 'height' ? 16 : 8)) {
                throw new Error('Incorrect capture map dimensions or precision for ' + name);
            }
            if (pixels.data.some(value => !Number.isFinite(value)) || !pixels.data.some((value, i) => i % 4 < 3 && value !== pixels.data[i % 4])) {
                throw new Error('The reconstructed ' + name + ' map is empty or uniform.');
            }
        }
        const cancelled = capture.render(angles, Math.PI / 4);
        capture.close();
        const aborted = await cancelled.then(() => false, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
        if (!aborted) throw new Error('A cancelled photo render published a result.');
        return { size, photos: files.length, heightBits: 16, cancelled: aborted };
    } finally {
        capture.close();
    }
}
