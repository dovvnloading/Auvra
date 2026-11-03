/**
 * The weights painted on a model, kept with it as a binary asset. A painted vertex is found again by
 * where it stands with the skeleton at rest and its bones by their names, so painting outlives a
 * reimport that splits the mesh's vertices differently.
 *
 * Binary layout (all little-endian):
 *   bytes 0-7   ASCII "AUVRASK1"
 *   bytes 8-11  uint32 places painted
 *   bytes 12-15 uint32 length of the bone names
 *   bytes 16-   the bone names, a JSON array in UTF-8 padded with spaces to a multiple of four bytes
 *   then        three float32 per place: where it stands
 *   then        four uint16 per place: its bones, as positions in the names; 65535 where it has run out
 *   then        four float32 per place: their shares, adding up to one
 */

export const SKIN_PAINT_MIME = 'application/vnd.auvra.skinpaint';
export const SKIN_PAINT_ENCODING = 'places-v1' as const;
export const SKIN_PAINT_FILE_NAME = 'skin-paint.bin';
/** In a place's list of bones, where it has run out. */
export const NO_PAINTED_BONE = 0xffff;
const MAGIC = 'AUVRASK1';
const HEADER_BYTES = 16;
const BONES_PER_PLACE = 4;

/** A model document's pointer to its painted weights. */
export interface SkinPaintReference {
  assetId: string;
  encoding: typeof SKIN_PAINT_ENCODING;
  count: number;
}

export interface SkinPaint {
  boneNames: string[];
  /** Where each place stands, three per place. */
  places: Float32Array;
  /** Four per place. */
  bones: Uint16Array;
  /** Four per place. */
  shares: Float32Array;
}

export interface SkinPaintFile {
  bytes: Uint8Array<ArrayBuffer>;
  count: number;
}

export const encodeSkinPaint = (paint: SkinPaint): SkinPaintFile => {
  const count = paint.places.length / 3;
  const names = new TextEncoder().encode(JSON.stringify(paint.boneNames));
  const namesLength = (names.byteLength + 3) & ~3;
  const placesAt = HEADER_BYTES + namesLength;
  const bonesAt = placesAt + count * 12;
  const sharesAt = bonesAt + count * 2 * BONES_PER_PLACE;
  const bytes = new Uint8Array(sharesAt + count * 4 * BONES_PER_PLACE);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC.length; index += 1) bytes[index] = MAGIC.charCodeAt(index);
  view.setUint32(8, count, true);
  view.setUint32(12, namesLength, true);
  bytes.set(names, HEADER_BYTES);
  bytes.fill(0x20, HEADER_BYTES + names.byteLength, placesAt);
  for (let index = 0; index < paint.places.length; index += 1) view.setFloat32(placesAt + index * 4, paint.places[index], true);
  for (let index = 0; index < paint.bones.length; index += 1) view.setUint16(bonesAt + index * 2, paint.bones[index], true);
  for (let index = 0; index < paint.shares.length; index += 1) view.setFloat32(sharesAt + index * 4, paint.shares[index], true);
  return { bytes, count };
};

export const decodeSkinPaint = (source: ArrayBuffer | Uint8Array): SkinPaint => {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (bytes.byteLength < HEADER_BYTES) throw new Error('Painted weights are truncated');
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC.charCodeAt(index)) throw new Error('Painted weights have an unknown format');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, true);
  const namesLength = view.getUint32(12, true);
  const placesAt = HEADER_BYTES + namesLength;
  const bonesAt = placesAt + count * 12;
  const sharesAt = bonesAt + count * 2 * BONES_PER_PLACE;
  if (bytes.byteLength !== sharesAt + count * 4 * BONES_PER_PLACE) throw new Error('Painted weights have the wrong size');
  const boneNames = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_BYTES, placesAt))) as unknown;
  if (!Array.isArray(boneNames) || !boneNames.every((name) => typeof name === 'string')) throw new Error('Painted weights have unreadable bone names');
  const places = new Float32Array(count * 3);
  const bones = new Uint16Array(count * BONES_PER_PLACE);
  const shares = new Float32Array(count * BONES_PER_PLACE);
  for (let index = 0; index < places.length; index += 1) places[index] = view.getFloat32(placesAt + index * 4, true);
  for (let index = 0; index < bones.length; index += 1) bones[index] = view.getUint16(bonesAt + index * 2, true);
  for (let index = 0; index < shares.length; index += 1) shares[index] = view.getFloat32(sharesAt + index * 4, true);
  return { boneNames: boneNames as string[], places, bones, shares };
};
