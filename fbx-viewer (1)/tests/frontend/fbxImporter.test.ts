import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { fbxTakeOrder, inTakeOrder } from '../../utils/fbxImport/clipOrder';
import { encodePng, imageHasAlpha, packMetalRough, sniffImageKind } from '../../utils/fbxImport/imagePixels';
import { buildImportedGlb } from '../../utils/fbxImport/importedModel';
import { instantiateImporter, runNativeImport, type NativeImport, type NativeImportOptions } from '../../utils/fbxImport/nativeImporter';

let importerModule: WebAssembly.Module;

beforeAll(async () => {
  importerModule = await WebAssembly.compile(readFileSync(path.resolve(__dirname, '../../vendor/fbxImporter/fbxImporter.wasm')));
});

const load = async (text: string, options: NativeImportOptions = {}, name = 'test.fbx'): Promise<NativeImport> =>
  runNativeImport(await instantiateImporter(importerModule), new TextEncoder().encode(text), name, options);

/** An FBX 7.4 document: settings for up axis and unit, then the objects and connections given. */
const fbxDocument = (objects: string, connections: string, { upAxis = 1, upSign = 1, unit = 1, frontAxis = 2, coordAxis = 0 } = {}): string => `; FBX 7.4.0 project file
FBXHeaderExtension:  {
  FBXHeaderVersion: 1003
  FBXVersion: 7400
  Creator: "Auvra test"
}
GlobalSettings:  {
  Version: 1000
  Properties70:  {
    P: "UpAxis", "int", "Integer", "",${upAxis}
    P: "UpAxisSign", "int", "Integer", "",${upSign}
    P: "FrontAxis", "int", "Integer", "",${frontAxis}
    P: "FrontAxisSign", "int", "Integer", "",1
    P: "CoordAxis", "int", "Integer", "",${coordAxis}
    P: "CoordAxisSign", "int", "Integer", "",1
    P: "UnitScaleFactor", "double", "Number", "",${unit}
    P: "TimeMode", "enum", "", "",6
  }
}
Objects:  {
${objects}
}
Connections:  {
${connections}
}
`;

/** A one-metre quad facing +Z, with UVs running up the image, on one node. */
const QUAD_GEOMETRY = `  Geometry: 100, "Geometry::Quad", "Mesh" {
    Vertices: *12 { a: 0,0,0, 1,0,0, 1,1,0, 0,1,0 }
    PolygonVertexIndex: *4 { a: 0,1,2,-4 }
    LayerElementNormal: 0 {
      MappingInformationType: "ByPolygonVertex"
      ReferenceInformationType: "Direct"
      Normals: *12 { a: 0,0,1, 0,0,1, 0,0,1, 0,0,1 }
    }
    LayerElementUV: 0 {
      Name: "UVMap"
      MappingInformationType: "ByPolygonVertex"
      ReferenceInformationType: "IndexToDirect"
      UV: *8 { a: 0,0, 1,0, 1,1, 0,1 }
      UVIndex: *4 { a: 0,1,2,3 }
    }
    LayerElementMaterial: 0 {
      MappingInformationType: "AllSame"
      ReferenceInformationType: "IndexToDirect"
      Materials: *1 { a: 0 }
    }
  }
  Model: 200, "Model::Quad", "Mesh" {
    Properties70:  {
      P: "Lcl Translation", "Lcl Translation", "", "A",2,3,4
    }
  }`;

const QUAD_CONNECTIONS = `  C: "OO",200,0
  C: "OO",100,200`;

const material = (id: number, name: string, properties = ''): string => `  Material: ${id}, "Material::${name}", "" {
    ShadingModel: "phong"
    Properties70:  {
      P: "DiffuseColor", "Color", "", "A",0.5,0.5,0.5
${properties}
    }
  }`;

const texture = (id: number, file: string): string => `  Texture: ${id}, "Texture::${file}", "" {
    Type: "TextureVideoClip"
    FileName: "C:/art/${file}"
    RelativeFilename: "${file}"
  }`;

/** Reads an accessor of a native import as numbers. */
const accessorValues = (native: NativeImport, index: number): number[] => {
  const accessor = native.document.accessors[index] as { bufferView: number; componentType: number; count: number; type: string };
  const view = native.document.bufferViews[accessor.bufferView];
  const size = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 } as Record<string, number>)[accessor.type];
  const binary = native.binary();
  const bytes = binary.slice(view.byteOffset, view.byteOffset + view.byteLength);
  const Array_ = accessor.componentType === 5126 ? Float32Array : accessor.componentType === 5125 ? Uint32Array : accessor.componentType === 5123 ? Uint16Array : Uint8Array;
  return [...new Array_(bytes.buffer, 0, accessor.count * size)];
};

const firstPrimitive = (native: NativeImport) => native.document.meshes![0].primitives[0];

describe('FBX importer: reading a file', () => {
  it('reports what the file holds and its unit', async () => {
    const native = await load(fbxDocument(`${QUAD_GEOMETRY}\n${material(300, 'Paint')}`, `${QUAD_CONNECTIONS}\n  C: "OO",300,200`, { unit: 100 }));
    expect(native.report).toMatchObject({ format: 'fbx', meshes: 1, triangles: 2, materials: 1, metresPerUnit: 1, upAxis: '+Y' });
    expect(native.report.boundsMin).toEqual([2, 3, 4]);
    expect(native.report.boundsMax).toEqual([3, 4, 4]);
    native.close();
  });

  it('refuses a file that is not a model, saying so', async () => {
    await expect(load('this is not a model')).rejects.toThrow(/could not be read/);
  });

  it('shares corners between triangles', async () => {
    const native = await load(fbxDocument(QUAD_GEOMETRY, QUAD_CONNECTIONS));
    const primitive = firstPrimitive(native);
    expect((native.document.accessors[primitive.attributes.POSITION] as { count: number }).count).toBe(4);
    expect((native.document.accessors[primitive.indices!] as { count: number }).count).toBe(6);
    native.close();
  });

  it('flips V so an image reads the right way up from glTF coordinates', async () => {
    const native = await load(fbxDocument(QUAD_GEOMETRY, QUAD_CONNECTIONS));
    const primitive = firstPrimitive(native);
    const positions = accessorValues(native, primitive.attributes.POSITION);
    const uvs = accessorValues(native, primitive.attributes.TEXCOORD_0);
    for (let i = 0; i < positions.length / 3; i += 1) {
      // The top of the quad (y = 1) reads the top row of the image (v = 0).
      expect(uvs[i * 2 + 1]).toBeCloseTo(1 - positions[i * 3 + 1]);
    }
    native.close();
  });

  it('gives normal-mapped parts tangents that point green up the image', async () => {
    const native = await load(fbxDocument(
      `${QUAD_GEOMETRY}\n${material(300, 'Paint')}\n${texture(400, 'normal.png')}`,
      `${QUAD_CONNECTIONS}\n  C: "OO",300,200\n  C: "OP",400,300, "NormalMap"`,
    ));
    const primitive = firstPrimitive(native);
    expect(primitive.attributes.TANGENT).toBeDefined();
    const tangents = accessorValues(native, primitive.attributes.TANGENT);
    const normals = accessorValues(native, primitive.attributes.NORMAL);
    for (let i = 0; i < tangents.length / 4; i += 1) {
      expect(tangents[i * 4]).toBeCloseTo(1);
      expect(tangents[i * 4 + 1]).toBeCloseTo(0);
      // bitangent = cross(normal, tangent) * w must run up the quad, where the image's top is.
      const n = new THREE.Vector3(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
      const t = new THREE.Vector3(tangents[i * 4], tangents[i * 4 + 1], tangents[i * 4 + 2]);
      expect(n.cross(t).multiplyScalar(tangents[i * 4 + 3]).y).toBeCloseTo(1);
    }
    native.close();
  });

  it('leaves tangents out where no material needs them, or when told to', async () => {
    const plain = await load(fbxDocument(`${QUAD_GEOMETRY}\n${material(300, 'Paint')}`, `${QUAD_CONNECTIONS}\n  C: "OO",300,200`));
    expect(firstPrimitive(plain).attributes.TANGENT).toBeUndefined();
    plain.close();
    const told = await load(fbxDocument(
      `${QUAD_GEOMETRY}\n${material(300, 'Paint')}\n${texture(400, 'normal.png')}`,
      `${QUAD_CONNECTIONS}\n  C: "OO",300,200\n  C: "OP",400,300, "NormalMap"`,
    ), { tangents: false });
    expect(firstPrimitive(told).attributes.TANGENT).toBeUndefined();
    told.close();
  });

  it('turns a file authored Z-up to stand up', async () => {
    // A point one unit up the file's Z axis ends one unit up in Y.
    const geometry = `  Geometry: 100, "Geometry::Post", "Mesh" {
    Vertices: *9 { a: 0,0,0, 1,0,0, 0,0,1 }
    PolygonVertexIndex: *3 { a: 0,1,-3 }
  }
  Model: 200, "Model::Post", "Mesh" {
  }`;
    const native = await load(fbxDocument(geometry, QUAD_CONNECTIONS, { upAxis: 2, frontAxis: 1 }));
    expect(native.report.upAxis).toBe('+Z');
    const bounds = { min: native.report.boundsMin!, max: native.report.boundsMax! };
    expect(bounds.max[1] - bounds.min[1]).toBeCloseTo(1);
    expect(bounds.max[2] - bounds.min[2]).toBeCloseTo(0);
    native.close();
  });

  it('works out normals a file leaves out, keeping sharp edges hard', async () => {
    // Two faces of a box corner, at right angles.
    const geometry = `  Geometry: 100, "Geometry::Corner", "Mesh" {
    Vertices: *18 { a: 0,0,0, 1,0,0, 1,1,0, 0,1,0, 1,0,-1, 1,1,-1 }
    PolygonVertexIndex: *8 { a: 0,1,2,-4, 1,4,5,-3 }
  }
  Model: 200, "Model::Corner", "Mesh" {
  }`;
    const native = await load(fbxDocument(geometry, QUAD_CONNECTIONS));
    const primitive = firstPrimitive(native);
    const normals = accessorValues(native, primitive.attributes.NORMAL);
    const facing = new Set<string>();
    for (let i = 0; i < normals.length / 3; i += 1) facing.add([normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]].map((value) => value.toFixed(2)).join());
    expect([...facing].sort()).toEqual(['0.00,0.00,1.00', '1.00,0.00,0.00']);
    // The shared edge has a vertex for each face: 8 in all, not 6.
    expect(normals.length / 3).toBe(8);
    native.close();
  });

  it('reads an OBJ, matching faces to no material', async () => {
    const native = await load('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n', { obj: true }, 'quad.obj');
    expect(native.report).toMatchObject({ format: 'obj', triangles: 2 });
    expect(firstPrimitive(native).attributes.NORMAL).toBeDefined();
    native.close();
  });
});

describe('FBX importer: skins and animation', () => {
  const skinned = `  Geometry: 100, "Geometry::Skin", "Mesh" {
    Vertices: *9 { a: 0,0,0, 1,0,0, 0,1,0 }
    PolygonVertexIndex: *3 { a: 0,1,-3 }
  }
  Model: 200, "Model::Skin", "Mesh" {
  }
  Model: 201, "Model::Hips", "LimbNode" {
  }
  Model: 202, "Model::Spine", "LimbNode" {
    Properties70:  {
      P: "Lcl Translation", "Lcl Translation", "", "A",0,1,0
    }
  }
  NodeAttribute: 301, "NodeAttribute::Hips", "LimbNode" {
    TypeFlags: "Skeleton"
  }
  NodeAttribute: 302, "NodeAttribute::Spine", "LimbNode" {
    TypeFlags: "Skeleton"
  }
  Deformer: 400, "Deformer::Skin", "Skin" {
  }
  Deformer: 401, "SubDeformer::Hips", "Cluster" {
    Indexes: *2 { a: 0,1 }
    Weights: *2 { a: 1,1 }
    Transform: *16 { a: 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 }
    TransformLink: *16 { a: 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 }
  }
  Deformer: 402, "SubDeformer::Spine", "Cluster" {
    Indexes: *1 { a: 2 }
    Weights: *1 { a: 1 }
    Transform: *16 { a: 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 }
    TransformLink: *16 { a: 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,1,0,1 }
  }`;
  const skinConnections = `  C: "OO",200,0
  C: "OO",100,200
  C: "OO",201,0
  C: "OO",202,201
  C: "OO",301,201
  C: "OO",302,202
  C: "OO",400,100
  C: "OO",401,400
  C: "OO",402,400
  C: "OO",201,401
  C: "OO",202,402`;

  /** A take rotating `Spine` about X from 0 to 90 degrees over a second. */
  const take = (id: number, name: string, start = 0): string => {
    const tick = 46186158000;
    const stop = start + 1;
    return `  AnimationStack: ${id}, "AnimStack::${name}", "" {
    Properties70:  {
      P: "LocalStart", "KTime", "Time", "",${start * tick}
      P: "LocalStop", "KTime", "Time", "",${stop * tick}
    }
  }
  AnimationLayer: ${id + 1}, "AnimLayer::Base", "" {
  }
  AnimationCurveNode: ${id + 2}, "AnimCurveNode::R", "" {
    Properties70:  {
      P: "d|X", "Number", "", "A",0
      P: "d|Y", "Number", "", "A",0
      P: "d|Z", "Number", "", "A",0
    }
  }
  AnimationCurve: ${id + 3}, "AnimCurve::", "" {
    Default: 0
    KeyVer: 4008
    KeyTime: *2 { a: ${start * tick},${stop * tick} }
    KeyValueFloat: *2 { a: 0,90 }
    KeyAttrFlags: *1 { a: 4 }
    KeyAttrDataFloat: *4 { a: 0,0,0,0 }
    KeyAttrRefCount: *1 { a: 2 }
  }`;
  };
  const takeConnections = (id: number): string => `  C: "OO",${id + 1},${id}
  C: "OO",${id + 2},${id + 1}
  C: "OP",${id + 2},202, "Lcl Rotation"
  C: "OP",${id + 3},${id + 2}, "d|X"`;

  it('binds one mesh to one set of nodes, with no copies of bones', async () => {
    const native = await load(fbxDocument(skinned, skinConnections));
    expect(native.report).toMatchObject({ bones: 2, skinnedMeshes: 1, maxInfluences: 1 });
    const names = native.document.nodes.map((node) => node.name);
    expect(names.filter((name) => name?.startsWith('Hips'))).toEqual(['Hips']);
    expect(native.document.nodes.find((node) => node.name === 'Hips')?.extras).toMatchObject({ bone: true });
    const primitive = firstPrimitive(native);
    expect(primitive.attributes.JOINTS_0).toBeDefined();
    const weights = accessorValues(native, primitive.attributes.WEIGHTS_0);
    for (let i = 0; i < weights.length / 4; i += 1) expect(weights[i * 4] + weights[i * 4 + 1] + weights[i * 4 + 2] + weights[i * 4 + 3]).toBeCloseTo(1);
    native.close();
  });

  it('bakes a take to rotation keys, and measures its clip from the take', async () => {
    const native = await load(fbxDocument(`${skinned}\n${take(500, 'Bend')}`, `${skinConnections}\n${takeConnections(500)}`));
    expect(native.document.animations?.map((clip) => clip.name)).toEqual(['Bend']);
    expect(native.report.clips[0]).toMatchObject({ name: 'Bend', duration: 1, start: 0 });
    native.close();
  });

  it('moves a take that starts late back to time zero', async () => {
    const native = await load(fbxDocument(`${skinned}\n${take(500, 'Late', 10)}`, `${skinConnections}\n${takeConnections(500)}`));
    const clip = native.document.animations![0] as { channels: { sampler: number }[]; samplers: { input: number }[] };
    const times = accessorValues(native, clip.samplers[clip.channels[0].sampler].input);
    expect(times[0]).toBeCloseTo(0);
    expect(times[times.length - 1]).toBeCloseTo(1);
    native.close();
  });

  it('leaves animation out when told to', async () => {
    const native = await load(fbxDocument(`${skinned}\n${take(500, 'Bend')}`, `${skinConnections}\n${takeConnections(500)}`), { animation: false });
    expect(native.document.animations).toBeUndefined();
    expect(native.report.clips).toEqual([]);
    native.close();
  });

  it('keeps clips in the order projects stored their names by', async () => {
    const file = fbxDocument(`${skinned}\n${take(5000, 'First in file')}\n${take(500, 'Lower id')}`, `${skinConnections}\n${takeConnections(5000)}\n${takeConnections(500)}`);
    const native = await load(file);
    expect(native.document.animations?.map((clip) => clip.name)).toEqual(['Lower id', 'First in file']);
    native.close();
  });
});

describe('take order', () => {
  it('puts ids that fit an array index first and in number order, then the rest in file order', () => {
    const text = `AnimationStack: 99999999999, "AnimStack::Big one"\nAnimationStack: 9, "AnimStack::Nine"\nAnimationStack: 2, "AnimStack::Two"\nAnimationStack: 88888888888, "AnimStack::Big two"`;
    expect(fbxTakeOrder(new TextEncoder().encode(text))).toEqual(['Two', 'Nine', 'Big one', 'Big two']);
  });

  it('sorts anything by those names, leaving names it does not know at the end', () => {
    const sorted = inTakeOrder([{ name: 'c' }, { name: 'a' }, { name: 'b' }], ['b', 'a']);
    expect(sorted.map((item) => item.name)).toEqual(['b', 'a', 'c']);
  });
});

describe('imported materials', () => {
  const fakeDecode = (pixels: Record<string, { data: Uint8Array; width: number; height: number }>) => async (bytes: Uint8Array) => {
    const key = new TextDecoder().decode(bytes.slice(8, 16)).replace(/\0/g, '');
    return pixels[key];
  };
  /** Bytes a test can recognise that sniff as a PNG: the signature, then a name. */
  const namedPng = (name: string): Uint8Array => {
    const bytes = new Uint8Array(64);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    bytes.set(new TextEncoder().encode(name), 8);
    return bytes;
  };

  /** Runs a file through to its finished document, with its textures given by name. */
  const finished = async (objects: string, connections: string, files: Record<string, Uint8Array> = {}, pixels: Parameters<typeof fakeDecode>[0] = {}) => {
    const native = await load(fbxDocument(objects, connections));
    const built = await buildImportedGlb(native, {
      decode: fakeDecode(pixels),
      decodeLegacy: () => null,
      externalImages: new Map(Object.entries(files)),
    });
    native.close();
    const view = new DataView(built.glb);
    const length = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(built.glb, 20, length)));
    return { ...built, json };
  };
  const painted = (extra = '', textures = '') => `${QUAD_GEOMETRY}\n${material(300, 'Paint', extra)}\n${textures}`;
  const onPaint = `${QUAD_CONNECTIONS}\n  C: "OO",300,200`;

  it('makes a legacy material matte and not metallic, with its colour made linear', async () => {
    const { json } = await finished(painted(), onPaint);
    const paint = json.materials[0];
    expect(paint.name).toBe('Paint');
    expect(paint.pbrMetallicRoughness.metallicFactor).toBe(0);
    expect(paint.pbrMetallicRoughness.baseColorFactor[0]).toBeCloseTo(0.214, 2);
    expect(paint.doubleSided).toBe(true);
    expect(json.scenes[0].extras.uvOriginTopLeft).toBe(true);
  });

  it('lets a colour map replace the constant colour', async () => {
    const { json } = await finished(painted('', texture(400, 'colour.png')), `${onPaint}\n  C: "OP",400,300, "DiffuseColor"`, { 'colour.png': namedPng('colour') });
    const pbr = json.materials[0].pbrMetallicRoughness;
    expect(pbr.baseColorFactor.slice(0, 3)).toEqual([1, 1, 1]);
    expect(json.images).toHaveLength(1);
    expect(json.images[0].mimeType).toBe('image/png');
  });

  it('works out a normal map from a height map', async () => {
    const heights = { data: new Uint8Array(4 * 4 * 4).fill(128), width: 4, height: 4 };
    const { json } = await finished(
      painted('', texture(400, 'paint_height.png')),
      `${onPaint}\n  C: "OP",400,300, "Bump"`,
      { 'paint_height.png': namedPng('height') },
      { height: heights },
    );
    expect(json.materials[0].normalTexture).toBeDefined();
    const image = json.images[json.textures[json.materials[0].normalTexture.index].source];
    expect(image.mimeType).toBe('image/png');
    expect(image.name).toBe('Paint normal');
  });

  it('takes a normal map over a height map when a material has both', async () => {
    const { json } = await finished(
      painted('', `${texture(400, 'paint_normal.png')}\n${texture(401, 'paint_height.png')}`),
      `${onPaint}\n  C: "OP",400,300, "NormalMap"\n  C: "OP",401,300, "Bump"`,
      { 'paint_normal.png': namedPng('normal'), 'paint_height.png': namedPng('height') },
    );
    expect(json.images).toHaveLength(1);
    expect(json.materials[0].normalTexture).toBeDefined();
  });

  it('inverts a legacy shininess map into roughness', async () => {
    const gloss = { data: new Uint8Array([9, 200, 9, 255]), width: 1, height: 1 };
    const { json, glb } = await finished(
      painted('', texture(400, 'shoes_gloss.png')),
      `${onPaint}\n  C: "OP",400,300, "ShininessExponent"`,
      { 'shoes_gloss.png': namedPng('gloss') },
      { gloss },
    );
    const pbr = json.materials[0].pbrMetallicRoughness;
    expect(pbr.roughnessFactor).toBe(1);
    expect(pbr.metallicRoughnessTexture).toBeDefined();
    const image = json.images[json.textures[pbr.metallicRoughnessTexture.index].source];
    const view = json.bufferViews[image.bufferView];
    const start = new DataView(glb).getUint32(12, true) + 28;
    const png = new Uint8Array(glb, start + view.byteOffset, view.byteLength);
    // Past the signature, IHDR, IDAT header, zlib header and block header: filter byte, then R, G, B.
    const pixelAt = 8 + 25 + 8 + 2 + 5 + 1;
    expect(png[pixelAt + 1]).toBe(255 - 200);
    expect(png[pixelAt + 2]).toBe(255);
  });

  it('keeps a map named as roughness as it is, with no second read of its pixels', async () => {
    let decoded = 0;
    const native = await load(fbxDocument(painted('', texture(400, 'shoes_roughness.png')), `${onPaint}\n  C: "OP",400,300, "ShininessExponent"`));
    const built = await buildImportedGlb(native, {
      decode: async () => { decoded += 1; throw new Error('should not read pixels'); },
      decodeLegacy: () => null,
      externalImages: new Map([['shoes_roughness.png', namedPng('rough')]]),
    });
    native.close();
    expect(decoded).toBe(0);
    expect(built.missingTextures).toEqual([]);
  });

  it('bakes an opacity map into the alpha of the colour map', async () => {
    const colour = { data: new Uint8Array([10, 20, 30, 255]), width: 1, height: 1 };
    const mask = { data: new Uint8Array([128, 128, 128, 255]), width: 1, height: 1 };
    const { json } = await finished(
      painted('', `${texture(400, 'colour.png')}\n${texture(401, 'mask.png')}`),
      `${onPaint}\n  C: "OP",400,300, "DiffuseColor"\n  C: "OP",401,300, "TransparentColor"`,
      { 'colour.png': namedPng('colour'), 'mask.png': namedPng('mask') },
      { colour, mask },
    );
    expect(json.materials[0].alphaMode).toBe('BLEND');
  });

  it('draws a material with partial opacity see-through, and a full one solid', async () => {
    const see = await finished(painted('      P: "Opacity", "double", "Number", "",0.25'), onPaint);
    expect(see.json.materials[0].alphaMode).toBe('BLEND');
    expect(see.json.materials[0].pbrMetallicRoughness.baseColorFactor[3]).toBeCloseTo(0.25);
    const solid = await finished(painted('      P: "Opacity", "double", "Number", "",1'), onPaint);
    expect(solid.json.materials[0].alphaMode).toBeUndefined();
  });

  it('says which textures the file names but does not hold', async () => {
    const { json, missingTextures, report } = await finished(painted('', texture(400, 'lost.png')), `${onPaint}\n  C: "OP",400,300, "DiffuseColor"`);
    expect(missingTextures).toEqual(['lost.png']);
    expect(report.warnings.join(' ')).toContain('lost.png');
    expect(json.images).toBeUndefined();
    expect(json.materials[0].pbrMetallicRoughness.baseColorFactor[0]).toBeCloseTo(0.214, 2);
  });

  it('gives a mesh with no material a matte grey one, not glTF\'s default metal', async () => {
    const { json } = await finished(QUAD_GEOMETRY, QUAD_CONNECTIONS);
    const used = json.materials[json.meshes[0].primitives[0].material];
    expect(used.pbrMetallicRoughness.metallicFactor).toBe(0);
  });

  it('stores the same image once, however many materials embed it', async () => {
    const image = namedPng('same');
    const { json } = await finished(
      `${QUAD_GEOMETRY}\n${material(300, 'A')}\n${material(301, 'B')}\n${texture(400, 'a.png')}\n${texture(401, 'b.png')}`,
      `${QUAD_CONNECTIONS}\n  C: "OO",300,200\n  C: "OO",301,200\n  C: "OP",400,300, "DiffuseColor"\n  C: "OP",401,301, "DiffuseColor"`,
      { 'a.png': image, 'b.png': image.slice() },
    );
    expect(json.images).toHaveLength(1);
  });
});

describe('image bytes', () => {
  it('knows formats from their bytes, and TGA from its name', () => {
    expect(sniffImageKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('png');
    expect(sniffImageKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImageKind(new TextEncoder().encode('DDS |||'))).toBe('dds');
    expect(sniffImageKind(new Uint8Array([0, 0, 2]), 'wood.TGA')).toBe('tga');
    expect(sniffImageKind(new Uint8Array([0, 0, 2]), 'wood.xyz')).toBe('unknown');
  });

  it('reads whether a PNG has alpha from its header', () => {
    const header = (type: number) => {
      const bytes = new Uint8Array(40);
      bytes.set([0x89, 0x50, 0x4e, 0x47]);
      bytes[25] = type;
      return bytes;
    };
    expect(imageHasAlpha(header(6), 'png')).toBe(true);
    expect(imageHasAlpha(header(2), 'png')).toBe(false);
    expect(imageHasAlpha(new Uint8Array(4), 'jpeg')).toBe(false);
  });

  it('packs roughness in green and metalness in blue, sized to the larger', () => {
    const packed = packMetalRough({
      roughness: { data: new Uint8Array([1, 100, 3, 255]), width: 1, height: 1 },
      metalness: { data: new Uint8Array([1, 2, 50, 255, 1, 2, 60, 255]), width: 2, height: 1 },
    });
    expect([packed.width, packed.height]).toEqual([2, 1]);
    expect([...packed.data]).toEqual([255, 100, 50, 255, 255, 100, 60, 255]);
  });

  it('leaves full roughness or metalness to the factor when a map is absent', () => {
    const packed = packMetalRough({ roughness: null, metalness: { data: new Uint8Array([0, 0, 7, 255]), width: 1, height: 1 } });
    expect([...packed.data]).toEqual([255, 255, 7, 255]);
  });

  it('writes a PNG another reader can read, with alpha only when it is needed', () => {
    const solid = encodePng({ data: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]), width: 2, height: 1 });
    expect([...solid.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    expect(solid[25]).toBe(2);
    const clear = encodePng({ data: new Uint8Array([1, 2, 3, 128]), width: 1, height: 1 });
    expect(clear[25]).toBe(6);
    // The stored data can be inflated by a real decompressor.
    const idatLength = new DataView(solid.buffer, solid.byteOffset).getUint32(33);
    expect([...inflateSync(solid.subarray(41, 41 + idatLength))]).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
