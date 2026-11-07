/**
 * UNIFORMS FOR A WEBGPU PASS
 *
 * A texturing pass's uniforms (as its GLSL declares them) laid out as one struct in a read-only
 * storage buffer, by WGSL's rules for buffers a shader shares with the host: a number takes 4 bytes,
 * a pair 8, three or four numbers 16 (three use 12 of them), a matrix a padded column each, an array
 * its element's size rounded up to its alignment. Storage rather than uniform space, so arrays of
 * single numbers (a ramp's positions) keep their natural 4-byte step.
 */

export interface UniformField {
    name: string;
    /** The GLSL type, with `[N]` for an array. */
    type: string;
}

interface Shape { align: number; size: number }

const SCALARS = new Set(['float', 'int', 'uint', 'bool']);

/** A type's alignment and size in a storage buffer. */
export const shapeOf = (type: string): Shape => {
    const open = type.indexOf('[');
    if (open >= 0) {
        const element = shapeOf(type.slice(0, open));
        const count = Number(type.slice(open + 1, -1));
        const stride = Math.ceil(element.size / element.align) * element.align;
        return { align: element.align, size: stride * count };
    }
    if (SCALARS.has(type)) return { align: 4, size: 4 };
    const vector = /^[iub]?vec([234])$/.exec(type);
    if (vector) {
        const n = Number(vector[1]);
        return n === 2 ? { align: 8, size: 8 } : n === 3 ? { align: 16, size: 12 } : { align: 16, size: 16 };
    }
    const matrix = /^mat([234])(?:x[234])?$/.exec(type);
    if (matrix) {
        const n = Number(matrix[1]);
        const column = n === 2 ? { align: 8, size: 8 } : { align: 16, size: n === 3 ? 12 : 16 };
        return { align: column.align, size: n * Math.ceil(column.size / column.align) * column.align };
    }
    throw new Error(`No layout for ${type}`);
};

export interface UniformLayout {
    fields: readonly UniformField[];
    offsets: readonly number[];
    /** The struct's size in bytes (at least 16, as an empty buffer cannot be bound). */
    size: number;
}

/** Where each field sits. */
export const layoutUniforms = (fields: readonly UniformField[]): UniformLayout => {
    let offset = 0;
    let align = 4;
    const offsets: number[] = [];
    for (const field of fields) {
        const shape = shapeOf(field.type);
        offset = Math.ceil(offset / shape.align) * shape.align;
        offsets.push(offset);
        offset += shape.size;
        align = Math.max(align, shape.align);
    }
    return { fields, offsets, size: Math.max(16, Math.ceil(offset / align) * align) };
};

/** A value as plain numbers, from a number, a boolean, an array or a vector or matrix of three's. */
const numbersOf = (value: unknown): number[] => {
    if (typeof value === 'number') return [value];
    if (typeof value === 'boolean') return [value ? 1 : 0];
    if (Array.isArray(value)) return value.flatMap(numbersOf);
    if (value && typeof value === 'object') {
        const elements = (value as { elements?: ArrayLike<number> }).elements;
        if (elements) return Array.from(elements);
        const v = value as { x?: number; y?: number; z?: number; w?: number };
        if (typeof v.x === 'number') return [v.x, v.y ?? 0, ...(typeof v.z === 'number' ? [v.z] : []), ...(typeof v.w === 'number' ? [v.w] : [])];
    }
    return [];
};

/** Writes one value of `type` at `offset`. */
const writeValue = (views: { f: Float32Array; i: Int32Array; u: Uint32Array }, offset: number, type: string, value: unknown): void => {
    const open = type.indexOf('[');
    if (open >= 0) {
        const elementType = type.slice(0, open);
        const element = shapeOf(elementType);
        const stride = Math.ceil(element.size / element.align) * element.align;
        const count = Number(type.slice(open + 1, -1));
        const items = Array.isArray(value) ? value : [];
        // An array given as plain numbers (a float array) or as vectors.
        const flat = items.every((item) => typeof item === 'number');
        const per = elementType.startsWith('mat') ? Number(elementType[3]) ** 2 : /vec([234])/.exec(elementType) ? Number(/vec([234])/.exec(elementType)![1]) : 1;
        for (let index = 0; index < count; index++) {
            const item = flat ? items.slice(index * per, index * per + per) : items[index];
            if (item === undefined || (Array.isArray(item) && !item.length)) continue;
            writeValue(views, offset + index * stride, elementType, item);
        }
        return;
    }
    const numbers = numbersOf(value);
    const at = offset / 4;
    const matrix = /^mat([234])/.exec(type);
    if (matrix) {
        const n = Number(matrix[1]);
        const column = n === 2 ? 2 : 4;
        for (let c = 0; c < n; c++) for (let r = 0; r < n; r++) views.f[at + c * column + r] = numbers[c * n + r] ?? 0;
        return;
    }
    const count = SCALARS.has(type) ? 1 : Number(/vec([234])/.exec(type)?.[1] ?? 1);
    const element = type === 'int' || type.startsWith('ivec') ? 'i' : type === 'uint' || type === 'bool' || type.startsWith('uvec') || type.startsWith('bvec') ? 'u' : 'f';
    for (let k = 0; k < count; k++) {
        const v = numbers[k] ?? 0;
        if (element === 'i') views.i[at + k] = Math.round(v);
        else if (element === 'u') views.u[at + k] = Math.max(0, Math.round(v)) >>> 0;
        else views.f[at + k] = v;
    }
};

/** The uniforms' bytes for `values` (by name; missing ones are 0). */
export const packUniforms = (layout: UniformLayout, values: Readonly<Record<string, unknown>>): ArrayBuffer => {
    const buffer = new ArrayBuffer(layout.size);
    const views = { f: new Float32Array(buffer), i: new Int32Array(buffer), u: new Uint32Array(buffer) };
    layout.fields.forEach((field, index) => {
        if (values[field.name] !== undefined) writeValue(views, layout.offsets[index], field.type, values[field.name]);
    });
    return buffer;
};
