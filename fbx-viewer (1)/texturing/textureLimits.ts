/** Conservative CPU budgets for untrusted custom PNG and PSD texture imports.
 * A 4K RGBA picture fits; decoded float RGBA is at most 256 MiB.
 * The renderer's post-decode maxSize setting cannot protect these allocations.
 */
export const MAX_TEXTURE_IMPORT_SOURCE_BYTES = 160 * 1024 * 1024;
export const MAX_TEXTURE_IMPORT_DECODED_BYTES = 144 * 1024 * 1024;
export const MAX_TEXTURE_IMPORT_PIXELS = 16 * 1024 * 1024;
export const MAX_TEXTURE_IMPORT_SIDE = 16384;

export const checkedTexturePixels = (width: number, height: number): number => {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || width > MAX_TEXTURE_IMPORT_SIDE
        || height > MAX_TEXTURE_IMPORT_SIDE || width * height > MAX_TEXTURE_IMPORT_PIXELS) {
        throw new Error('The picture exceeds the texture import pixel budget.');
    }
    return width * height;
};
