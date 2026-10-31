/** Reads and writes the containers glTF comes in: its JSON, a GLB's chunks, embedded data: URIs. */

export interface GltfResource { uri?: string; mimeType?: string }
export interface GltfDocument {
  asset?: { version?: string };
  buffers?: GltfResource[];
  images?: GltfResource[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  extensions?: Record<string, unknown>;
}

export const GLB_MAGIC = 0x46546c67; // 'glTF'
export const GLB_JSON_CHUNK = 0x4e4f534a; // 'JSON'
const GLB_BIN_CHUNK = 0x004e4942; // 'BIN'

export const invalidGltf = (detail: string): Error => new Error(`This file is not a valid glTF 2.0 model: ${detail}.`);

export const parseGltfJson = (text: string): GltfDocument => {
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw invalidGltf('its JSON could not be parsed'); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw invalidGltf('its JSON is not an object');
  const document = json as GltfDocument;
  const major = Number.parseInt(String(document.asset?.version ?? ''), 10);
  if (major !== 2) throw new Error('Only glTF 2.0 models are supported; re-export as glTF 2.0.');
  // Draco, meshopt and Basis compression are decoded as the model loads (utils/gltfDecoders.ts).
  return document;
};

export const readGlb = (source: ArrayBuffer): { json: GltfDocument; jsonEnd: number } => {
  if (source.byteLength < 20) throw invalidGltf('the binary header is truncated');
  const view = new DataView(source);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw invalidGltf('the binary header is missing');
  if (view.getUint32(4, true) < 2) throw new Error('Only glTF 2.0 models are supported; re-export as glTF 2.0.');
  const jsonLength = view.getUint32(12, true);
  const jsonEnd = 20 + jsonLength;
  if (view.getUint32(16, true) !== GLB_JSON_CHUNK || jsonEnd > source.byteLength) throw invalidGltf('the JSON chunk is malformed');
  return { json: parseGltfJson(new TextDecoder().decode(new Uint8Array(source, 20, jsonLength))), jsonEnd };
};

/** The binary chunk after a GLB's JSON (read by readGlb), if it has one. */
export const readGlbBinary = (source: ArrayBuffer, jsonEnd: number): Uint8Array | null => {
  if (jsonEnd + 8 > source.byteLength) return null;
  const view = new DataView(source);
  const length = view.getUint32(jsonEnd, true);
  if (view.getUint32(jsonEnd + 4, true) !== GLB_BIN_CHUNK || jsonEnd + 8 + length > source.byteLength) throw invalidGltf('the binary chunk is malformed');
  return new Uint8Array(source, jsonEnd + 8, length);
};

/** A GLB of `json` and `binary`, its chunks padded as the format asks. */
export const writeGlb = (json: unknown, binary: Uint8Array | null): ArrayBuffer => {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = (jsonBytes.byteLength + 3) & ~3;
  const binaryLength = binary ? (binary.byteLength + 3) & ~3 : 0;
  const total = 20 + jsonLength + (binary ? 8 + binaryLength : 0);
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, GLB_JSON_CHUNK, true);
  output.set(jsonBytes, 20);
  output.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLength);
  if (binary) {
    view.setUint32(20 + jsonLength, binaryLength, true);
    view.setUint32(24 + jsonLength, GLB_BIN_CHUNK, true);
    output.set(binary, 28 + jsonLength);
  }
  return output.buffer;
};

export const decodeDataUri = (uri: string): { bytes: Uint8Array<ArrayBuffer>; mimeType: string } => {
  const comma = uri.indexOf(',');
  if (comma < 0) throw invalidGltf('an embedded resource is malformed');
  const [mimeType, ...parameters] = uri.slice(5, comma).split(';');
  const payload = uri.slice(comma + 1);
  const isBase64 = parameters.some((parameter) => parameter.trim().toLowerCase() === 'base64');
  let binary: string;
  try {
    // Percent-decoding to code units (not UTF-8) keeps %XX bytes intact.
    binary = isBase64
      ? atob(payload.replace(/\s+/g, ''))
      : payload.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  } catch {
    throw invalidGltf('an embedded resource is not valid base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 0xff;
  return { bytes, mimeType: mimeType || 'application/octet-stream' };
};
