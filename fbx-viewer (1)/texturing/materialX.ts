import {
    MATERIAL_PICTURE_NODE_TYPE, OUTPUT_NODE_TYPE, REROUTE_NODE_TYPE, createMaterialGraph, defaultParams, textureSlot, withMaterialPictures,
    type MaterialGraph, type MaterialGraphLink, type MaterialGraphNode,
} from '../runtime/materials/materialGraph';
import type { MaterialAsset } from '../runtime/materials/materialLibrary';

/**
 * MATERIALX
 *
 * A material's surface written as a MaterialX document, and a MaterialX document read back into a material.
 * Either surface is written: Autodesk Standard Surface (standard_surface) or OpenPBR (open_pbr_surface).
 * Each Material Output input that is left unwired is written as its value; one wired straight to a picture
 * (Texture Sample, Normal Map or Material Picture) is written as an image node reading that picture's file,
 * with a channel taken out where only one is read, and normals through a normalmap node. Anything else
 * the graph works out cannot be written as a value and is listed as left out.
 *
 * Reading takes the surface node's values and images (directly, through extract or normalmap nodes, or
 * through a nodegraph's outputs), and makes a material graph of Texture Sample and Normal Map nodes wired
 * into a Material Output holding the values.
 */

export type MaterialXSurface = 'standard_surface' | 'open_pbr_surface';

type Vec3 = [number, number, number];
type Params = Record<string, unknown>;

/** How one of the Material Output's inputs is written in each surface. */
interface InputMapping {
    key: string;
    type: 'float' | 'color3';
    standard?: string;
    openPbr?: string;
}

/** Inputs written one to one (values in the same units in both). */
const DIRECT: readonly InputMapping[] = [
    { key: 'baseColor', type: 'color3', standard: 'base_color', openPbr: 'base_color' },
    { key: 'metalness', type: 'float', standard: 'metalness', openPbr: 'base_metalness' },
    { key: 'roughness', type: 'float', standard: 'specular_roughness', openPbr: 'specular_roughness' },
    { key: 'specularWeight', type: 'float', standard: 'specular', openPbr: 'specular_weight' },
    { key: 'specularColor', type: 'color3', standard: 'specular_color', openPbr: 'specular_color' },
    { key: 'ior', type: 'float', standard: 'specular_IOR', openPbr: 'specular_ior' },
    { key: 'anisotropy', type: 'float', standard: 'specular_anisotropy', openPbr: 'specular_roughness_anisotropy' },
    { key: 'coat', type: 'float', standard: 'coat', openPbr: 'coat_weight' },
    { key: 'coatRoughness', type: 'float', standard: 'coat_roughness', openPbr: 'coat_roughness' },
    { key: 'coatColor', type: 'color3', standard: 'coat_color', openPbr: 'coat_color' },
    { key: 'sheenRoughness', type: 'float', standard: 'sheen_roughness', openPbr: 'fuzz_roughness' },
    { key: 'transmission', type: 'float', standard: 'transmission', openPbr: 'transmission_weight' },
    { key: 'attenuationColor', type: 'color3', standard: 'transmission_color', openPbr: 'transmission_color' },
    { key: 'attenuationDistance', type: 'float', standard: 'transmission_depth', openPbr: 'transmission_depth' },
    { key: 'emissive', type: 'color3', standard: 'emission_color', openPbr: 'emission_color' },
];

/** Inputs whose pictures can be written (the rest are values only). */
const PICTURE_INPUTS: Record<string, { standard: string; openPbr: string; type: 'float' | 'color3' | 'vector3' }> = {
    baseColor: { standard: 'base_color', openPbr: 'base_color', type: 'color3' },
    metalness: { standard: 'metalness', openPbr: 'base_metalness', type: 'float' },
    roughness: { standard: 'specular_roughness', openPbr: 'specular_roughness', type: 'float' },
    specularColor: { standard: 'specular_color', openPbr: 'specular_color', type: 'color3' },
    coat: { standard: 'coat', openPbr: 'coat_weight', type: 'float' },
    coatRoughness: { standard: 'coat_roughness', openPbr: 'coat_roughness', type: 'float' },
    coatColor: { standard: 'coat_color', openPbr: 'coat_color', type: 'color3' },
    sheenColor: { standard: 'sheen_color', openPbr: 'fuzz_color', type: 'color3' },
    transmission: { standard: 'transmission', openPbr: 'transmission_weight', type: 'float' },
    emissive: { standard: 'emission_color', openPbr: 'emission_color', type: 'color3' },
    opacity: { standard: 'opacity', openPbr: 'geometry_opacity', type: 'float' },
    normal: { standard: 'normal', openPbr: 'geometry_normal', type: 'vector3' },
    coatNormal: { standard: 'coat_normal', openPbr: 'geometry_coat_normal', type: 'vector3' },
};

const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const vec3 = (value: unknown, fallback: Vec3): Vec3 => (Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(v => typeof v === 'number') ? [value[0], value[1], value[2]] as Vec3 : fallback);
const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const written = (value: number | Vec3): string => (Array.isArray(value) ? value.map(round).join(', ') : String(round(value)));
const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A name MaterialX takes: letters, digits and underscores, not starting with a digit. */
const safeName = (text: string): string => {
    const name = text.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'material';
    return /^[0-9]/.test(name) ? `m_${name}` : name;
};

/** The value each written input takes, from the output's settings (in Auvra's units). */
const surfaceValues = (params: Params, surface: MaterialXSurface): Array<{ name: string; type: 'float' | 'color3'; value: number | Vec3 }> => {
    const defaults = defaultParams(OUTPUT_NODE_TYPE);
    const values: Array<{ name: string; type: 'float' | 'color3'; value: number | Vec3 }> = [];
    const get = (key: string): unknown => params[key] ?? defaults[key];
    for (const mapping of DIRECT) {
        const name = surface === 'standard_surface' ? mapping.standard : mapping.openPbr;
        if (!name) continue;
        values.push({ name, type: mapping.type, value: mapping.type === 'float' ? num(get(mapping.key), 0) : vec3(get(mapping.key), [0, 0, 0]) });
    }
    const sheen = vec3(get('sheenColor'), [0, 0, 0]);
    const sheenWeight = Math.max(...sheen);
    const thinFilm = num(get('thinFilm'), 0);
    const thickness = num(get('thinFilmThickness'), 400);
    const dispersion = num(get('dispersion'), 0);
    const strength = num(get('emissiveStrength'), 1);
    const opacity = num(get('opacity'), 1);
    if (surface === 'standard_surface') {
        values.push(
            { name: 'base', type: 'float', value: 1 },
            { name: 'specular_rotation', type: 'float', value: num(get('anisotropyRotation'), 0) / 360 },
            // Sheen's weight times its colour gives the colour drawn.
            { name: 'sheen', type: 'float', value: sheenWeight > 0 ? 1 : 0 },
            { name: 'sheen_color', type: 'color3', value: sheen },
            { name: 'thin_film_thickness', type: 'float', value: thinFilm > 0 ? thickness * thinFilm : 0 },
            // An Abbe number (0 for none).
            { name: 'transmission_dispersion', type: 'float', value: dispersion > 0 ? 20 / dispersion : 0 },
            { name: 'emission', type: 'float', value: strength },
            { name: 'opacity', type: 'color3', value: [opacity, opacity, opacity] },
        );
    } else {
        values.push(
            { name: 'base_weight', type: 'float', value: 1 },
            { name: 'fuzz_weight', type: 'float', value: sheenWeight > 0 ? 1 : 0 },
            { name: 'fuzz_color', type: 'color3', value: sheen },
            { name: 'thin_film_weight', type: 'float', value: thinFilm },
            // Micrometres.
            { name: 'thin_film_thickness', type: 'float', value: thickness / 1000 },
            { name: 'transmission_dispersion_scale', type: 'float', value: dispersion > 0 ? 1 : 0 },
            { name: 'transmission_dispersion_abbe_number', type: 'float', value: dispersion > 0 ? 20 / dispersion : 20 },
            // Nits: a strength of 1 is 1000.
            { name: 'emission_luminance', type: 'float', value: strength * 1000 },
            { name: 'geometry_opacity', type: 'float', value: opacity },
        );
    }
    return values;
};

/** The node a wire into `input` comes from, past reroutes and bypassed nodes; null when unwired. */
const sourceOf = (graph: MaterialGraph, toNode: string, toInput: string): { node: MaterialGraphNode; output: string } | null => {
    let link: MaterialGraphLink | undefined = graph.links.find(candidate => candidate.toNode === toNode && candidate.toInput === toInput);
    for (let hops = 0; link && hops < 64; hops++) {
        const node = graph.nodes.find(candidate => candidate.id === link!.fromNode);
        if (!node) return null;
        if (node.type !== REROUTE_NODE_TYPE && !node.bypass) return { node, output: link.fromOutput };
        const inputLink: MaterialGraphLink | undefined = graph.links.find(candidate => candidate.toNode === node.id);
        link = inputLink;
    }
    return null;
};

const CHANNELS: Record<string, number> = { r: 0, g: 1, b: 2, a: 3 };

export interface MaterialXExport {
    /** The .mtlx document. */
    document: string;
    /** The pictures it reads, by the path written for each. */
    textures: Array<{ textureId: string; path: string }>;
    /** Inputs the graph works out in ways a value or picture cannot say, in plain words. */
    leftOut: string[];
}

/**
 * The material's surface as a MaterialX document. `fileOf` names a picture's file (its name with extension),
 * or null where it has none; pictures are written under "textures/".
 */
export const materialToMaterialX = (asset: MaterialAsset, surface: MaterialXSurface, fileOf: (textureId: string) => string | null): MaterialXExport => {
    const graph = withMaterialPictures(asset.graph, asset.pictures);
    const output = graph.nodes.find(node => node.type === OUTPUT_NODE_TYPE);
    const params = output?.params ?? defaultParams(OUTPUT_NODE_TYPE);
    const name = safeName(asset.name);
    const surfaceName = `${name}_surface`;
    const lines: string[] = [];
    const inputs = new Map<string, string>();
    const textures: Array<{ textureId: string; path: string }> = [];
    const paths = new Map<string, string>();
    const leftOut: string[] = [];
    const pathOf = (textureId: string): string | null => {
        const known = paths.get(textureId);
        if (known) return known;
        const file = fileOf(textureId);
        if (!file) return null;
        const taken = new Set(paths.values());
        const dot = file.lastIndexOf('.');
        const stem = (dot > 0 ? file.slice(0, dot) : file).replace(/[^\w .-]+/g, '_') || 'picture';
        const extension = dot > 0 ? file.slice(dot) : '.png';
        let path = `textures/${stem}${extension}`;
        for (let n = 2; taken.has(path); n++) path = `textures/${stem}_${n}${extension}`;
        paths.set(textureId, path);
        textures.push({ textureId, path });
        return path;
    };

    for (const value of surfaceValues(params, surface)) {
        inputs.set(value.name, `    <input name="${value.name}" type="${value.type}" value="${written(value.value)}" />`);
    }

    if (output) {
        for (const [key, target] of Object.entries(PICTURE_INPUTS)) {
            const source = sourceOf(graph, output.id, key);
            if (!source) continue;
            const inputName = surface === 'standard_surface' ? target.standard : target.openPbr;
            const { node } = source;
            const textureId = typeof node.params.texture === 'string' ? node.params.texture : '';
            const reads = node.type === 'texture' || node.type === 'normalMap' || node.type === MATERIAL_PICTURE_NODE_TYPE;
            const path = reads && textureId ? pathOf(textureId) : null;
            if (!path) {
                leftOut.push(key);
                continue;
            }
            const colour = textureSlot(node) === 'map' && target.type !== 'vector3';
            const colourSpace = colour ? ' colorspace="srgb_texture"' : '';
            const imageName = `${key}_image`;
            if (target.type === 'vector3') {
                const scale = node.type === 'normalMap' ? num(node.params.strength, 1) : 1;
                lines.push(`  <image name="${imageName}" type="vector3">`, `    <input name="file" type="filename" value="${escape(path)}" />`, '  </image>');
                lines.push(`  <normalmap name="${key}_map" type="vector3">`, `    <input name="in" type="vector3" nodename="${imageName}" />`, `    <input name="scale" type="float" value="${written(scale)}" />`, '  </normalmap>');
                inputs.set(inputName, `    <input name="${inputName}" type="vector3" nodename="${key}_map" />`);
                continue;
            }
            const channel = CHANNELS[source.output];
            const single = target.type === 'float';
            let from = imageName;
            let type: 'float' | 'color3' = single ? 'float' : 'color3';
            if (!single || channel === undefined || channel === 0) {
                // The whole picture (colour), or its first channel (one value).
                lines.push(`  <image name="${imageName}" type="${type}">`, `    <input name="file" type="filename" value="${escape(path)}"${colourSpace} />`, '  </image>');
            } else {
                // One channel of a packed picture.
                lines.push(`  <image name="${imageName}" type="color4">`, `    <input name="file" type="filename" value="${escape(path)}"${colourSpace} />`, '  </image>');
                lines.push(`  <extract name="${key}_channel" type="float">`, `    <input name="in" type="color4" nodename="${imageName}" />`, `    <input name="index" type="integer" value="${channel}" />`, '  </extract>');
                from = `${key}_channel`;
            }
            if (single && key === 'opacity' && surface === 'standard_surface') {
                // Standard Surface's opacity is a colour.
                lines.push(`  <convert name="${key}_gray" type="color3">`, `    <input name="in" type="float" nodename="${from}" />`, '  </convert>');
                from = `${key}_gray`;
                type = 'color3';
            }
            inputs.set(inputName, `    <input name="${inputName}" type="${type}" nodename="${from}" />`);
        }
        // What else is wired in, past what can be written, is left at its value.
        for (const link of graph.links) {
            if (link.toNode !== output.id || PICTURE_INPUTS[link.toInput] || leftOut.includes(link.toInput)) continue;
            if (link.toInput === 'worldPositionOffset' || link.toInput === 'occlusion' || link.toInput === 'selfShadow') continue;
            leftOut.push(link.toInput);
        }
    }

    // OpenPBR turns anisotropy by the surface's tangent, not by a value.
    if (surface === 'open_pbr_surface' && num(params.anisotropyRotation, 0) !== 0) leftOut.push('anisotropyRotation');

    const document = [
        '<?xml version="1.0"?>',
        '<materialx version="1.39" colorspace="lin_rec709">',
        ...lines,
        `  <${surface} name="${surfaceName}" type="surfaceshader">`,
        ...[...inputs.values()],
        `  </${surface}>`,
        `  <surfacematerial name="${name}" type="material">`,
        `    <input name="surfaceshader" type="surfaceshader" nodename="${surfaceName}" />`,
        '  </surfacematerial>',
        '</materialx>',
        '',
    ].join('\n');
    return { document, textures, leftOut };
};

// --- Reading -------------------------------------------------------------------------------------

/** A value as MaterialX writes it: "0.5" or "0.8, 0.8, 0.8". */
const parseValue = (text: string | null): number[] | null => {
    if (text === null) return null;
    const values = text.split(/[,\s]+/).filter(Boolean).map(Number);
    return values.length && values.every(Number.isFinite) ? values : null;
};

/** Where an input's picture is: its file, which channel, whether it is colour, and a normal map's strength. */
interface PictureSource { file: string; channel: 'rgb' | 'r' | 'g' | 'b' | 'a'; colour: boolean; normalScale?: number }

const elementNamed = (root: Element, name: string): Element | null => {
    for (const child of Array.from(root.children)) if (child.getAttribute('name') === name) return child;
    return null;
};

/** The picture an input reads, following nodegraph outputs, normalmap, extract and convert nodes to an image. */
const pictureOf = (root: Element, input: Element, scope: Element = root, depth = 0): PictureSource | null => {
    if (depth > 16) return null;
    const graphName = input.getAttribute('nodegraph');
    if (graphName) {
        const graph = elementNamed(root, graphName);
        const outputName = input.getAttribute('output');
        const output = graph ? Array.from(graph.getElementsByTagName('output')).find(candidate => !outputName || candidate.getAttribute('name') === outputName) : null;
        return graph && output ? pictureOf(root, output, graph, depth + 1) : null;
    }
    const nodeName = input.getAttribute('nodename');
    if (!nodeName) return null;
    const node = elementNamed(scope, nodeName) ?? elementNamed(root, nodeName);
    if (!node) return null;
    const inputOf = (name: string) => Array.from(node.children).find(child => child.tagName === 'input' && child.getAttribute('name') === name) ?? null;
    switch (node.tagName) {
        case 'image':
        case 'tiledimage': {
            const file = inputOf('file');
            const path = file?.getAttribute('value');
            if (!path) return null;
            const space = file?.getAttribute('colorspace') ?? node.getAttribute('colorspace') ?? '';
            const type = node.getAttribute('type') ?? 'color3';
            return { file: path, channel: type === 'float' ? 'r' : 'rgb', colour: /srgb/i.test(space) };
        }
        case 'normalmap': {
            const from = inputOf('in');
            const picture = from ? pictureOf(root, from, scope, depth + 1) : null;
            const scale = parseValue(inputOf('scale')?.getAttribute('value') ?? null)?.[0];
            return picture ? { ...picture, colour: false, normalScale: scale ?? 1 } : null;
        }
        case 'extract': {
            const from = inputOf('in');
            const picture = from ? pictureOf(root, from, scope, depth + 1) : null;
            const index = parseValue(inputOf('index')?.getAttribute('value') ?? null)?.[0] ?? 0;
            return picture ? { ...picture, channel: (['r', 'g', 'b', 'a'] as const)[Math.max(0, Math.min(3, index))] } : null;
        }
        case 'convert':
        case 'dot': {
            const from = inputOf('in');
            return from ? pictureOf(root, from, scope, depth + 1) : null;
        }
        default:
            return null;
    }
};

const SURFACES: readonly MaterialXSurface[] = ['standard_surface', 'open_pbr_surface'];

/** The surface node a document's material uses (or its first surface node). */
const surfaceNode = (root: Element): Element | null => {
    const material = root.getElementsByTagName('surfacematerial')[0];
    const shaderInput = material ? Array.from(material.children).find(child => child.getAttribute('name') === 'surfaceshader') : undefined;
    const named = shaderInput?.getAttribute('nodename');
    if (named) {
        const node = elementNamed(root, named);
        if (node && SURFACES.includes(node.tagName as MaterialXSurface)) return node;
    }
    for (const surface of SURFACES) {
        const node = root.getElementsByTagName(surface)[0];
        if (node) return node;
    }
    return null;
};

const parseDocument = (xml: string): Element => {
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    const root = parsed.documentElement;
    if (!root || root.tagName !== 'materialx' || parsed.getElementsByTagName('parsererror').length) throw new Error('This is not a MaterialX file this editor can read.');
    return root;
};

/** The pictures a MaterialX document's surface reads: each file, and whether it holds colour. */
export const materialXPictures = (xml: string): Array<{ path: string; colour: boolean }> => {
    const root = parseDocument(xml);
    const surface = surfaceNode(root);
    if (!surface) return [];
    const found = new Map<string, boolean>();
    for (const input of Array.from(surface.children)) {
        if (input.tagName !== 'input') continue;
        const picture = pictureOf(root, input);
        if (picture) found.set(picture.file, (found.get(picture.file) ?? false) || picture.colour);
    }
    return [...found].map(([path, colour]) => ({ path, colour }));
};

/** Which output input and setting each surface input sets, read back. */
const READ_NAMES: Record<MaterialXSurface, Record<string, string>> = {
    standard_surface: Object.fromEntries([...DIRECT.filter(m => m.standard).map(m => [m.standard!, m.key]), ['sheen_color', 'sheenColor'], ['opacity', 'opacity'], ['normal', 'normal'], ['coat_normal', 'coatNormal']]),
    open_pbr_surface: Object.fromEntries([...DIRECT.filter(m => m.openPbr).map(m => [m.openPbr!, m.key]), ['fuzz_color', 'sheenColor'], ['geometry_opacity', 'opacity'], ['geometry_normal', 'normal'], ['geometry_coat_normal', 'coatNormal']]),
};

export interface MaterialXImport {
    asset: MaterialAsset;
    /** Surface inputs read from something other than a value or a picture, in plain words. */
    leftOut: string[];
}

/**
 * A MaterialX document as a material: its surface's values on a Material Output, its pictures as Texture
 * Sample and Normal Map nodes wired in. `textureFor` gives the project texture id each picture file was
 * added as (materialXPictures lists them), or null where it was not.
 */
export const materialFromMaterialX = (xml: string, textureFor: (path: string) => string | null, id: string, fallbackName = 'MaterialX material'): MaterialXImport => {
    const root = parseDocument(xml);
    const surface = surfaceNode(root);
    if (!surface) throw new Error('This MaterialX file has no Standard Surface or OpenPBR surface.');
    const kind = surface.tagName as MaterialXSurface;
    const graph = createMaterialGraph();
    const output = graph.nodes[0];
    const params: Params = { ...output.params };
    const raw = new Map<string, number[]>();
    const leftOut: string[] = [];
    const names = READ_NAMES[kind];
    let row = 0;
    for (const input of Array.from(surface.children)) {
        if (input.tagName !== 'input') continue;
        const inputName = input.getAttribute('name') ?? '';
        const value = parseValue(input.getAttribute('value'));
        if (value) { raw.set(inputName, value); continue; }
        if (!input.getAttribute('nodename') && !input.getAttribute('nodegraph')) continue;
        const key = names[inputName];
        const picture = pictureOf(root, input);
        const textureId = picture ? textureFor(picture.file) : null;
        if (!key || !picture || !textureId) {
            leftOut.push(inputName);
            continue;
        }
        const nodeId = `${key}_picture`;
        const y = 40 + row++ * 150;
        if (key === 'normal' || key === 'coatNormal') {
            graph.nodes.push({ id: nodeId, type: 'normalMap', x: 120, y, params: { ...defaultParams('normalMap'), texture: textureId, strength: picture.normalScale ?? 1 } });
            graph.links.push({ fromNode: nodeId, fromOutput: 'out', toNode: output.id, toInput: key });
            continue;
        }
        graph.nodes.push({ id: nodeId, type: 'texture', x: 120, y, params: { ...defaultParams('texture'), texture: textureId, space: picture.colour ? 'color' : 'data' } });
        const single = key !== 'baseColor' && key !== 'specularColor' && key !== 'sheenColor' && key !== 'emissive' && key !== 'attenuationColor';
        graph.links.push({ fromNode: nodeId, fromOutput: single && picture.channel === 'rgb' ? 'r' : picture.channel, toNode: output.id, toInput: key });
        // A picture cutting the surface out: masked, as most such pictures are.
        if (key === 'opacity') params.blendMode = 'masked';
    }
    const get = (name: string): number[] | undefined => raw.get(name);
    for (const mapping of DIRECT) {
        const name = kind === 'standard_surface' ? mapping.standard : mapping.openPbr;
        const value = name ? get(name) : undefined;
        if (!value) continue;
        params[mapping.key] = mapping.type === 'float' ? value[0] : [value[0], value[1] ?? value[0], value[2] ?? value[0]];
    }
    const colour = (value: number[] | undefined): Vec3 | undefined => (value ? [value[0], value[1] ?? value[0], value[2] ?? value[0]] : undefined);
    if (kind === 'standard_surface') {
        const base = get('base')?.[0] ?? 1;
        if (base !== 1 && Array.isArray(params.baseColor)) params.baseColor = (params.baseColor as number[]).map(v => v * base);
        const rotation = get('specular_rotation')?.[0];
        if (rotation !== undefined) params.anisotropyRotation = rotation * 360;
        const sheen = get('sheen')?.[0] ?? 0;
        const sheenColor = colour(get('sheen_color')) ?? [1, 1, 1];
        params.sheenColor = sheenColor.map(v => v * sheen);
        const thickness = get('thin_film_thickness')?.[0] ?? 0;
        if (thickness > 0) { params.thinFilm = 1; params.thinFilmThickness = thickness; }
        const abbe = get('transmission_dispersion')?.[0] ?? 0;
        params.dispersion = abbe > 0 ? 20 / abbe : 0;
        const emission = get('emission')?.[0];
        if (emission !== undefined) params.emissiveStrength = emission;
        const opacity = get('opacity');
        if (opacity) params.opacity = opacity[0];
    } else {
        const base = get('base_weight')?.[0] ?? 1;
        if (base !== 1 && Array.isArray(params.baseColor)) params.baseColor = (params.baseColor as number[]).map(v => v * base);
        const fuzz = get('fuzz_weight')?.[0] ?? 0;
        const fuzzColor = colour(get('fuzz_color')) ?? [1, 1, 1];
        params.sheenColor = fuzzColor.map(v => v * fuzz);
        const filmWeight = get('thin_film_weight')?.[0];
        if (filmWeight !== undefined) params.thinFilm = filmWeight;
        const film = get('thin_film_thickness')?.[0];
        if (film !== undefined) params.thinFilmThickness = film * 1000;
        const scale = get('transmission_dispersion_scale')?.[0] ?? 0;
        const abbe = get('transmission_dispersion_abbe_number')?.[0] ?? 20;
        params.dispersion = scale > 0 && abbe > 0 ? (scale * 20) / abbe : 0;
        const luminance = get('emission_luminance')?.[0];
        if (luminance !== undefined) params.emissiveStrength = luminance / 1000;
        const opacity = get('geometry_opacity')?.[0];
        if (opacity !== undefined) params.opacity = opacity;
    }
    if (typeof params.opacity === 'number' && params.opacity < 1 && params.blendMode === 'opaque') params.blendMode = 'translucent';
    output.params = params;
    const material = root.getElementsByTagName('surfacematerial')[0];
    const name = (material?.getAttribute('name') ?? surface.getAttribute('name') ?? '').replace(/_/g, ' ').trim() || fallbackName;
    return { asset: { id, name: name.slice(0, 128), graph }, leftOut };
};
