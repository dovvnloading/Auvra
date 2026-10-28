/**
 * Writes an opacity mask into the alpha of RGBA colour pixels (the same size), the way glTF keeps
 * a material's opacity: in its base colour's alpha. A mask with an alpha channel of its own (a
 * colour map used as the opacity map) gives that alpha; a greyscale mask gives its grey, read from
 * green as three.js reads an alphaMap.
 */
export const writeOpacity = (colour: Uint8ClampedArray, mask: Uint8ClampedArray): void => {
    let maskHasAlpha = false;
    for (let i = 3; i < mask.length; i += 4) {
        if (mask[i] < 255) { maskHasAlpha = true; break; }
    }
    const channel = maskHasAlpha ? 3 : 1;
    for (let i = 0; i < colour.length; i += 4) colour[i + 3] = mask[i + channel];
};
