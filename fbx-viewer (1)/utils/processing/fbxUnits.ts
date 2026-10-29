/**
 * The length unit an FBX file is authored in: its GlobalSettings `UnitScaleFactor` is centimetres
 * per file unit (1 for centimetres, as Blender and Maya write by default, 100 for metres).
 * FBXLoader ignores it, so a model kept at its authored size would come in a hundred times too big.
 */

const BINARY_MAGIC = 'Kaydara FBX Binary';
const PROPERTY = 'UnitScaleFactor';
const ASCII_PROPERTY = /P:\s*"UnitScaleFactor"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*([-+\d.eE]+)/;

const validScale = (value: number): number | null => (Number.isFinite(value) && value > 0 ? value : null);

/** The file's UnitScaleFactor (centimetres per unit), or null when it does not say. */
export const fbxUnitScaleFactor = (buffer: ArrayBuffer): number | null => {
    const bytes = new Uint8Array(buffer);
    const header = String.fromCharCode(...bytes.subarray(0, BINARY_MAGIC.length));
    if (header !== BINARY_MAGIC) {
        const match = ASCII_PROPERTY.exec(new TextDecoder().decode(bytes));
        return match ? validScale(Number(match[1])) : null;
    }
    const view = new DataView(buffer);
    const name = Array.from(PROPERTY, char => char.charCodeAt(0));
    // The property's name is a string record: 'S', its length, then its characters
    // ("OriginalUnitScaleFactor" ends with the same characters, but not that length).
    for (let at = 5; at + name.length < bytes.length; at++) {
        if (bytes[at] !== name[0] || bytes[at - 5] !== 0x53 || view.getUint32(at - 4, true) !== name.length) continue;
        if (!name.every((code, index) => bytes[at + index] === code)) continue;
        // Then its type, label and flags strings, then the value.
        let cursor = at + name.length;
        for (let field = 0; field < 4 && cursor + 1 < bytes.length; field++) {
            const type = String.fromCharCode(bytes[cursor]);
            cursor += 1;
            if (type === 'S') cursor += 4 + view.getUint32(cursor, true);
            else if (type === 'D') return validScale(view.getFloat64(cursor, true));
            else if (type === 'F') return validScale(view.getFloat32(cursor, true));
            else if (type === 'I') return validScale(view.getInt32(cursor, true));
            else return null;
        }
        return null;
    }
    return null;
};

/** Metres per file unit, or null when the file does not say. */
export const fbxMetresPerUnit = (buffer: ArrayBuffer): number | null => {
    const factor = fbxUnitScaleFactor(buffer);
    return factor === null ? null : factor / 100;
};
