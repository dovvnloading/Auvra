import * as THREE from 'three';
import { layoutAlong, sampleAt, samplePath, type SurfacePath, type Vec3 } from '../../../texturing/paint/paths';
import { Stroke, type BrushSettings, type Dab, type HistoryEntry, type StrokeTarget, type StrokeView } from '../../../texturing/paint/strokes';
import type { PaintSession } from './paintSession';
import { brushAlpha } from './brushAlpha';

/**
 * Laying a path along its length (the brush, a ribbon, stitches from a texture graph, letters), as
 * surface dabs at its points: the same from the 3D view and the 2D painting view, which differ only in
 * how many pixels a dab spans (for its soft edge).
 */

/** One letter, white on black, as an alpha for a dab. */
export const glyphTexture = (character: string, font: string): { texture: THREE.CanvasTexture; advance: number } => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'black';
    context.fillRect(0, 0, 128, 128);
    context.fillStyle = 'white';
    context.font = `96px ${font}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(character, 64, 70);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.NoColorSpace;
    return { texture, advance: context.measureText(character).width / 128 };
};

/**
 * The path laid along its length on `target` with `brush` (mirrors and turned copies left out), as one
 * step to keep; null (with `onMessage` told why) when nothing could be laid. `pixelsAt` is how many
 * pixels a dab of a model-space radius spans where it lies.
 */
export const layPathAlong = async (options: {
    session: PaintSession;
    target: StrokeTarget;
    brush: BrushSettings;
    path: SurfacePath;
    view: StrokeView;
    pixelsAt: (point: THREE.Vector3, worldRadius: number) => number;
    onMessage: (message: string) => void;
}): Promise<HistoryEntry | null> => {
    const { session, target, brush, path, view, pixelsAt, onMessage } = options;
    const stack = session.stack;
    const plain: BrushSettings = { ...brush, mode: 'paint', buildUp: false, symmetry: { x: false, y: false, z: false }, radial: { count: 1, axis: 'y' } };
    const disposables: THREE.Texture[] = [];
    try {
        const style = path.style;
        const sizes = path.points.map((point) => point.size);
        const smallest = Math.max(1e-6, Math.min(...sizes));
        const gap = path.gap ?? 0.2;
        const surface: BrushSettings = style === 'ribbon' ? { ...plain, projection: 'surface', shape: 'square', hardness: 1 } : { ...plain, projection: 'surface' };
        const shaped = style === 'brush' ? brushAlpha(brush, session) : { alpha: null, waiting: null };
        if (shaped.waiting) { onMessage(shaped.waiting); return null; }
        const alpha = shaped.alpha;
        const stroke = new Stroke(stack, target, 'paint', surface, view, alpha, null);
        const dabOf = (sample: { position: Vec3; normal: Vec3; size: number; opacity: number; tangent: Vec3 }, scale = 1, follow = true): Dab => {
            const point = new THREE.Vector3(...sample.position);
            const worldRadius = sample.size * scale;
            return {
                x: 0, y: 0, angle: 0,
                radius: pixelsAt(point, worldRadius),
                flow: brush.flow * sample.opacity,
                point, normal: new THREE.Vector3(...sample.normal), worldRadius,
                ...(follow ? { across: new THREE.Vector3(...sample.tangent) } : {}),
            };
        };
        if (style === 'text') {
            const text = (path.text ?? '').trim() ? path.text! : 'Text';
            const font = path.font ?? 'sans-serif';
            const height = smallest * 2;
            const glyphs = [...text].map((character) => ({ character, ...glyphTexture(character, font) }));
            for (const glyph of glyphs) disposables.push(glyph.texture);
            const samples = samplePath(path.points, Math.max(smallest / 20, 1e-6), path.closed);
            const total = samples.length ? samples[samples.length - 1].distance : 0;
            const places = layoutAlong(glyphs.map((glyph) => Math.max(glyph.advance, 0.25) * height), total, gap * height * 0.25);
            glyphs.forEach((glyph, i) => {
                const at = places[i];
                const sample = at === null ? null : sampleAt(samples, at);
                if (sample && glyph.character.trim()) stroke.stamp([dabOf(sample)], glyph.texture);
            });
            if (places.some((place) => place === null)) onMessage('The path is too short for all of the text: the rest was left off.');
        } else if (style === 'stitches') {
            const entry = path.graphId ? stack.host.resolveGraph(path.graphId) : undefined;
            const output = entry?.graph.nodes.find((node) => node.type === 'output');
            if (!entry || !output) { stroke.cancel(); onMessage('Pick a texture graph to make the stitches from: each stitch is its first output.'); return null; }
            const image = await stack.graphOutput(path.graphId!, output.params.channel === 'custom' ? output.id : String(output.params.channel), {}, stack.tiles[0], `path:${path.id}`);
            if (!image) { stroke.cancel(); onMessage('The stitch graph could not be drawn.'); return null; }
            const samples = samplePath(path.points, smallest * 2 * (1 + gap), path.closed);
            stroke.stamp(samples.map((sample) => dabOf(sample)), image.target.texture);
        } else {
            const step = style === 'ribbon' ? smallest * 0.2 : Math.max(smallest * 2 * brush.spacing, smallest * 0.05);
            const samples = samplePath(path.points, step, path.closed);
            const dabs = samples.map((sample) => dabOf(sample, 1, style === 'ribbon' || brush.followStroke));
            for (let i = 0; i < dabs.length; i += 64) stroke.stamp(dabs.slice(i, i + 64), alpha);
        }
        return stroke.finish(`Paint ${path.name}`);
    } finally {
        for (const texture of disposables) texture.dispose();
    }
};
