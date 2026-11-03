/** How a painted picture is asked for, and what is done to it before it joins a project, for pictures that are not surfaces. */

/** The size a sky is painted at, as the host asks for it. */
export const SKY_MEGAPIXELS = (2816 * 1408) / 1_000_000;
/** How far in from each edge a panorama's seam is worked away, as a share of its width. */
const SEAM_BAND_SHARE = 0.06;
/** How many rows either side a seam's difference is averaged over, so that it does not show as streaks. */
const SEAM_SMOOTHING_ROWS = 6;

export const skyInstruction = (words: string): string =>
  `A seamless 360 degree equirectangular panorama of ${words.trim()}, with the horizon exactly across the middle. No people, no text.`;

export const decalInstruction = (words: string): string =>
  `${words.trim()}, isolated on a transparent background, seen straight on, with nothing else in the picture.`;

/**
 * Makes a panorama's left and right edges meet, in place, on RGBA pixels. Models paint them close but rarely alike, which
 * shows as a line down the sky. The difference is shared out over a band each side, so the picture's detail stays.
 */
export const closeWrapSeam = (data: Uint8ClampedArray, width: number, height: number): void => {
  const band = Math.max(1, Math.round(width * SEAM_BAND_SHARE));
  const difference = new Float32Array(height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      difference[y * 3 + channel] = data[y * width * 4 + channel] - data[(y * width + width - 1) * 4 + channel];
    }
  }
  for (let y = 0; y < height; y += 1) {
    const from = Math.max(0, y - SEAM_SMOOTHING_ROWS);
    const to = Math.min(height - 1, y + SEAM_SMOOTHING_ROWS);
    for (let channel = 0; channel < 3; channel += 1) {
      let sum = 0;
      for (let row = from; row <= to; row += 1) sum += difference[row * 3 + channel];
      const half = sum / (to - from + 1) / 2;
      for (let x = 0; x < band; x += 1) {
        const share = half * (1 - x / band);
        const left = (y * width + x) * 4 + channel;
        const right = (y * width + width - 1 - x) * 4 + channel;
        data[left] -= share;
        data[right] += share;
      }
    }
  }
};

/** A picture with its wrap seam closed and twice as wide as it is tall, whatever shape a model answered in, ready to keep. */
export const seamlessPanorama = async (url: string): Promise<{ picture: Blob; width: number; height: number }> => {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(image.naturalWidth, image.naturalHeight * 2);
  canvas.height = Math.round(canvas.width / 2);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('The panorama could not be made.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  closeWrapSeam(pixels.data, canvas.width, canvas.height);
  context.putImageData(pixels, 0, 0);
  const picture = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/png'); });
  if (!picture) throw new Error('The panorama could not be made.');
  return { picture, width: canvas.width, height: canvas.height };
};
