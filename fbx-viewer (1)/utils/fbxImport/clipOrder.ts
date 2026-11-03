/**
 * The order an FBX file's animation takes come in. A project stores each model's clip names by
 * position, so this order must never change: it is that of a JavaScript object keyed by the takes'
 * ids, the shape earlier versions read them into. Ids a JavaScript object treats as array indices
 * come first, in numeric order; any others follow in the file's order.
 */

const BINARY_MAGIC = 'Kaydara FBX Binary';
const MAX_ARRAY_INDEX = 4294967294n;

interface Take {
  id: bigint;
  name: string;
}

const ASCII_TAKE = /AnimationStack:\s*(-?\d+)\s*,\s*"([^"]*)"/g;

/** "AnimStack::Run" and "Run\0\1AnimStack" both name the take Run. */
const takeName = (raw: string): string => {
  const binaryEnd = raw.indexOf('\u0000\u0001');
  if (binaryEnd >= 0) return raw.slice(0, binaryEnd);
  const asciiStart = raw.indexOf('::');
  return asciiStart >= 0 ? raw.slice(asciiStart + 2) : raw;
};

/** The takes in a binary FBX file: only node headers are read, skipping past everything else. */
const binaryTakes = (bytes: Uint8Array): Take[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(23, true);
  const wide = version >= 7500;
  const header = wide ? 25 : 13;
  const readNode = (at: number) => {
    if (at + header > bytes.length) return null;
    const end = wide ? Number(view.getBigUint64(at, true)) : view.getUint32(at, true);
    const propertyLength = wide ? Number(view.getBigUint64(at + 16, true)) : view.getUint32(at + 8, true);
    const nameLength = bytes[at + header - 1];
    if (end === 0) return null;
    const nameStart = at + header;
    return { end, propertiesAt: nameStart + nameLength, propertyLength, name: String.fromCharCode(...bytes.subarray(nameStart, nameStart + nameLength)) };
  };

  const takes: Take[] = [];
  for (let at = 27; at + header <= bytes.length;) {
    const node = readNode(at);
    if (!node) break;
    if (node.name === 'Objects') {
      for (let child = node.propertiesAt + node.propertyLength; child + header <= node.end;) {
        const object = readNode(child);
        if (!object) break;
        if (object.name === 'AnimationStack' && bytes[object.propertiesAt] === 0x4c /* L */) {
          const id = view.getBigInt64(object.propertiesAt + 1, true);
          const nameAt = object.propertiesAt + 9;
          if (bytes[nameAt] === 0x53 /* S */) {
            const length = view.getUint32(nameAt + 1, true);
            takes.push({ id, name: takeName(new TextDecoder().decode(bytes.subarray(nameAt + 5, nameAt + 5 + length))) });
          }
        }
        child = object.end;
      }
      break;
    }
    at = node.end;
  }
  return takes;
};

const asciiTakes = (bytes: Uint8Array): Take[] => {
  const text = new TextDecoder().decode(bytes);
  return Array.from(text.matchAll(ASCII_TAKE), (match) => ({ id: BigInt(match[1]), name: takeName(match[2]) }));
};

/** The names of a file's takes in clip order; empty when it has none or is not an FBX file. */
export const fbxTakeOrder = (bytes: Uint8Array): string[] => {
  let takes: Take[];
  try {
    const isBinary = bytes.length > 27 && String.fromCharCode(...bytes.subarray(0, BINARY_MAGIC.length)) === BINARY_MAGIC;
    takes = isBinary ? binaryTakes(bytes) : asciiTakes(bytes);
  } catch {
    return [];
  }
  const isIndex = (take: Take): boolean => take.id >= 0n && take.id <= MAX_ARRAY_INDEX;
  const indexed = takes.filter(isIndex).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...indexed, ...takes.filter((take) => !isIndex(take))].map((take) => take.name);
};

/** `items` sorted by where their name falls in `order`; anything not named keeps its place at the end. */
export const inTakeOrder = <T extends { name?: string }>(items: readonly T[], order: readonly string[]): T[] => {
  const rank = new Map<string, number>();
  order.forEach((name, index) => { if (!rank.has(name)) rank.set(name, index); });
  return items
    .map((item, index) => ({ item, index, at: rank.get(item.name ?? '') ?? order.length + index }))
    .sort((a, b) => a.at - b.at)
    .map(({ item }) => item);
};
