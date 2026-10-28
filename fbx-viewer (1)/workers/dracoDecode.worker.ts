/// <reference lib="webworker" />

import DracoDecoderModule from 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js';

/**
 * Decodes Draco-compressed geometry for utils/gltfDecoders.ts. It speaks the protocol of three's
 * DRACOLoader, whose own worker is built from a blob: URL the editor's CSP does not allow.
 */

type ArrayTypeName = 'Float32Array' | 'Int8Array' | 'Int16Array' | 'Int32Array' | 'Uint8Array' | 'Uint16Array' | 'Uint32Array';
type DecodedArray = Float32Array | Int8Array | Int16Array | Int32Array | Uint8Array | Uint16Array | Uint32Array;

interface TaskConfig {
    attributeIDs: Record<string, string | number>;
    attributeTypes: Record<string, ArrayTypeName>;
    useUniqueIDs: boolean;
    vertexColorSpace?: string;
}
type DecodeRequest =
    | { type: 'init'; decoderConfig: { wasmBinary?: ArrayBuffer } }
    | { type: 'decode'; id: number; buffer: ArrayBuffer; taskConfig: TaskConfig };

interface DracoStatus { ok(): boolean; error_msg(): string }
interface DracoGeometry { ptr: number; num_faces(): number; num_points(): number }
interface DracoAttribute { num_components(): number }
interface DracoDecoder {
    GetEncodedGeometryType(array: Int8Array): number;
    DecodeArrayToMesh(array: Int8Array, length: number, mesh: DracoGeometry): DracoStatus;
    DecodeArrayToPointCloud(array: Int8Array, length: number, cloud: DracoGeometry): DracoStatus;
    GetAttributeByUniqueId(geometry: DracoGeometry, id: number): DracoAttribute;
    GetAttributeId(geometry: DracoGeometry, semantic: number): number;
    GetAttribute(geometry: DracoGeometry, id: number): DracoAttribute;
    GetTrianglesUInt32Array(geometry: DracoGeometry, byteLength: number, pointer: number): boolean;
    GetAttributeDataArrayForAllPoints(geometry: DracoGeometry, attribute: DracoAttribute, dataType: number, byteLength: number, pointer: number): boolean;
}
interface Draco {
    Decoder: new () => DracoDecoder;
    Mesh: new () => DracoGeometry;
    PointCloud: new () => DracoGeometry;
    TRIANGULAR_MESH: number;
    POINT_CLOUD: number;
    HEAPF32: Float32Array;
    _malloc(byteLength: number): number;
    _free(pointer: number): void;
    destroy(object: DracoDecoder | DracoGeometry): void;
    /** Data types (DT_FLOAT32, ...) and attribute semantics (POSITION, NORMAL, ...). */
    [constant: string]: unknown;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

type ArrayType = { new (buffer: ArrayBufferLike, byteOffset: number, length: number): DecodedArray; BYTES_PER_ELEMENT: number };
const ARRAY_TYPES: Record<ArrayTypeName, { type: ArrayType; dracoType: string }> = {
    Float32Array: { type: Float32Array, dracoType: 'DT_FLOAT32' },
    Int8Array: { type: Int8Array, dracoType: 'DT_INT8' },
    Int16Array: { type: Int16Array, dracoType: 'DT_INT16' },
    Int32Array: { type: Int32Array, dracoType: 'DT_INT32' },
    Uint8Array: { type: Uint8Array, dracoType: 'DT_UINT8' },
    Uint16Array: { type: Uint16Array, dracoType: 'DT_UINT16' },
    Uint32Array: { type: Uint32Array, dracoType: 'DT_UINT32' },
};

/** Copies `count` values of `type` out of the decoder's heap, which `fill` writes at the pointer it is given. */
const readHeap = (draco: Draco, type: ArrayType, count: number, fill: (byteLength: number, pointer: number) => void): DecodedArray => {
    const byteLength = count * type.BYTES_PER_ELEMENT;
    const pointer = draco._malloc(byteLength);
    try {
        fill(byteLength, pointer);
        return new type(draco.HEAPF32.buffer, pointer, count).slice();
    } finally {
        draco._free(pointer);
    }
};

const decodeGeometry = (draco: Draco, decoder: DracoDecoder, array: Int8Array, config: TaskConfig) => {
    const kind = decoder.GetEncodedGeometryType(array);
    const mesh = kind === draco.TRIANGULAR_MESH;
    if (!mesh && kind !== draco.POINT_CLOUD) throw new Error('Draco data holds neither a mesh nor a point cloud.');
    const geometry = mesh ? new draco.Mesh() : new draco.PointCloud();
    try {
        const status = mesh
            ? decoder.DecodeArrayToMesh(array, array.byteLength, geometry)
            : decoder.DecodeArrayToPointCloud(array, array.byteLength, geometry);
        if (!status.ok() || geometry.ptr === 0) throw new Error(`Draco decoding failed: ${status.error_msg()}`);
        const attributes: { name: string; array: DecodedArray; itemSize: number; vertexColorSpace?: string }[] = [];
        for (const [name, id] of Object.entries(config.attributeIDs)) {
            // glTF names its attributes by unique ID; a bare .drc file by semantic (POSITION, NORMAL, ...).
            let attribute: DracoAttribute;
            if (config.useUniqueIDs) {
                attribute = decoder.GetAttributeByUniqueId(geometry, Number(id));
            } else {
                const index = decoder.GetAttributeId(geometry, draco[String(id)] as number);
                if (index === -1) continue;
                attribute = decoder.GetAttribute(geometry, index);
            }
            const { type, dracoType } = ARRAY_TYPES[config.attributeTypes[name]];
            const itemSize = attribute.num_components();
            const values = readHeap(draco, type, geometry.num_points() * itemSize, (byteLength, pointer) => {
                decoder.GetAttributeDataArrayForAllPoints(geometry, attribute, draco[dracoType] as number, byteLength, pointer);
            });
            attributes.push({ name, array: values, itemSize, ...(name === 'color' ? { vertexColorSpace: config.vertexColorSpace } : {}) });
        }
        const index = mesh
            ? { array: readHeap(draco, Uint32Array, geometry.num_faces() * 3, (byteLength, pointer) => { decoder.GetTrianglesUInt32Array(geometry, byteLength, pointer); }), itemSize: 1 }
            : null;
        return { index, attributes };
    } finally {
        draco.destroy(geometry);
    }
};

let module: Promise<{ draco: Draco }> | null = null;

scope.onmessage = (event: MessageEvent<DecodeRequest>) => {
    const message = event.data;
    if (message.type === 'init') {
        module = new Promise((resolve) => {
            // The module is promise-like itself, so it is wrapped before resolving.
            DracoDecoderModule({ ...message.decoderConfig, onModuleLoaded: (draco: Draco) => resolve({ draco }) });
        });
        return;
    }
    void module?.then(({ draco }) => {
        const decoder = new draco.Decoder();
        try {
            const geometry = decodeGeometry(draco, decoder, new Int8Array(message.buffer), message.taskConfig);
            const buffers = geometry.attributes.map(attribute => attribute.array.buffer as ArrayBuffer);
            if (geometry.index) buffers.push(geometry.index.array.buffer as ArrayBuffer);
            scope.postMessage({ type: 'decode', id: message.id, geometry }, buffers);
        } catch (error) {
            scope.postMessage({ type: 'error', id: message.id, error: error instanceof Error ? error.message : 'Draco decoding failed' });
        } finally {
            draco.destroy(decoder);
        }
    });
};
