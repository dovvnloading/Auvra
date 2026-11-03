/**
 * What a model says of a surface's metal and roughness, held to what its colour can bear. A model judges from a picture, and
 * will call a black rubber grip polished metal. Taken at its word that goes black on screen: a metal shows only what it
 * reflects, in its own colour, and no real metal is that dark.
 */

/** How bright a colour has to be for anything on it to be metal at all, and fully so, as linear light. */
const DARKEST_METAL = 0.05;
const BRIGHT_METAL = 0.35;
/**
 * The most metal anything is taken to be. A painted picture holds the light and grime of what it shows, where a true metal's
 * colour holds neither: all metal would lose them for reflections it does not have, and every dark mark on it would go black.
 */
const MOST_METAL = 0.6;
/** Nothing painted comes out a true mirror: it would show its surroundings, not what was asked for. */
const SMOOTHEST_METAL = 0.25;
/** A model rates most things smooth, which turns cloth, rubber and wood to wet plastic. Only metal gets to shine. */
const SMOOTHEST_OTHER = 0.55;

const LINEAR_OF_BYTE = Float32Array.from({ length: 256 }, (_, value) => {
  const encoded = value / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
});

/** Takes metal off what is too dark in `colour` to be metal. Both are RGBA and the same size, and the value is in every channel of `metal`. */
export const limitMetal = (metal: Uint8ClampedArray, colour: Uint8ClampedArray): void => {
  for (let at = 0; at < metal.length; at += 4) {
    const light = 0.2126 * LINEAR_OF_BYTE[colour[at]] + 0.7152 * LINEAR_OF_BYTE[colour[at + 1]] + 0.0722 * LINEAR_OF_BYTE[colour[at + 2]];
    const allowed = Math.min(1, Math.max(0, (light - DARKEST_METAL) / (BRIGHT_METAL - DARKEST_METAL)));
    const value = metal[at] * allowed * MOST_METAL;
    metal[at] = value;
    metal[at + 1] = value;
    metal[at + 2] = value;
  }
};

/** Lifts what is smoother than it should be, going by how metal it came out in `metal`, already limited. The value is in every channel of both. */
export const limitSmoothness = (roughness: Uint8ClampedArray, metal: Uint8ClampedArray | null): void => {
  const mostMetal = MOST_METAL * 255;
  for (let at = 0; at < roughness.length; at += 4) {
    const metalness = metal ? metal[at] / mostMetal : 0;
    const least = (SMOOTHEST_OTHER + (SMOOTHEST_METAL - SMOOTHEST_OTHER) * metalness) * 255;
    if (roughness[at] >= least) continue;
    roughness[at] = least;
    roughness[at + 1] = least;
    roughness[at + 2] = least;
  }
};
