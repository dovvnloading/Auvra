import type { TextureGpu } from '../gpu/textureGpu';
import { DEEP_EXPORT, encodeChannels, type ChannelImages } from '../materialOutput';
import { download, makeZip } from '../zip';
import { extensionOf, isFloatFormat, linearChannels, writePicture, type PictureData, type PictureFormat } from './pictureFiles';

/**
 * A ZIP of a material's channels, one picture each, in the file kind asked for (texture graph and paint
 * downloads). 8-bit PNG keeps the deep channels (height) at 16 bits, as before.
 */

/** Rows of a picture read back from the GPU (bottom row first), from the top of the UV square unless `flipRows`. */
const rowsOf = (pixels: Float32Array, width: number, height: number, channels: 1 | 3 | 4, flipRows: boolean): Float32Array => {
    const data = new Float32Array(width * height * channels);
    for (let y = 0; y < height; y++) {
        const row = flipRows ? height - 1 - y : y;
        for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) data[(y * width + x) * channels + c] = pixels[(row * width + x) * 4 + c];
    }
    return data;
};

/** One file for each channel, named `${name}_${channel}`. Rows go top first when `flipRows`, as the PNGs always have. */
export const channelPictureFiles = async (gpu: TextureGpu, images: ChannelImages, width: number, height: number, name: string, format: PictureFormat, flipRows = true): Promise<Array<{ name: string; data: Blob }>> => {
    if (format === 'png8') {
        const pictures = await encodeChannels(gpu, images, width, height, 'separate', flipRows, DEEP_EXPORT);
        return pictures.map((picture) => ({ name: `${name}_${picture.role}.png`, data: picture.blob }));
    }
    const files: Array<{ name: string; data: Blob }> = [];
    for (const [role, image] of Object.entries(images)) {
        if (!image) continue;
        const channels = image.kind === 'gray' ? 1 : 3;
        const picture: PictureData = { width: image.width, height: image.height, channels, data: rowsOf(gpu.readFloat(image), image.width, image.height, channels, flipRows) };
        const colour = isFloatFormat(format) && (role === 'baseColor' || role === 'emissive') ? [0, 1, 2] : [];
        files.push({ name: `${name}_${role}.${extensionOf(format)}`, data: await writePicture(linearChannels(picture, colour), format) });
    }
    return files;
};

/** Downloads a material's channels as a ZIP named for the material and the picture size. */
export const downloadChannelPictures = async (gpu: TextureGpu, images: ChannelImages, width: number, height: number, name: string, format: PictureFormat): Promise<void> => {
    const files = await channelPictureFiles(gpu, images, width, height, name, format);
    download(await makeZip(files), `${name}_${width === height ? width : `${width}x${height}`}.zip`);
};
