import * as THREE from 'three';
import { bool, float, out, select, vec2 } from '../nodeKit';
import type { TexNodeDef } from '../types';

/**
 * TEXT
 *
 * Letters in a font of the user's choice, laid out by the browser on a 2D canvas and taken onto the
 * GPU: white on black, for masks, labels, stamps and engravings. A font setting holds a font family's
 * name; the fonts offered are those this computer has.
 */

/** Fonts offered: the editor's own, the generic families every browser has, and ones most computers have. */
export const FONT_CHOICES: readonly string[] = [
    'Inter Variable', 'sans-serif', 'serif', 'monospace',
    'Arial', 'Arial Black', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Segoe UI', 'Calibri',
    'Georgia', 'Times New Roman', 'Palatino Linotype', 'Garamond', 'Cambria',
    'Courier New', 'Consolas', 'Lucida Console', 'Impact', 'Comic Sans MS',
];
const GENERIC: ReadonlySet<string> = new Set(['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy']);

/** A family as CSS reads it: generic ones bare, named ones quoted. */
export const cssFamily = (font: string): string => (GENERIC.has(font) ? font : `"${font.replace(/["\\]/g, '')}", sans-serif`);

let found: string[] | null = null;
/**
 * The fonts this computer has, of FONT_CHOICES: a named font counts when text set in it measures
 * differently from both generic fallbacks. Worked out once; everything where it cannot be measured.
 */
export const availableFonts = (): string[] => {
    if (found) return found;
    const context = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    if (!context) return [...FONT_CHOICES];
    const sample = 'mmmmmmmmmmlliWW@#0123';
    const width = (family: string) => { context.font = `48px ${family}`; return context.measureText(sample).width; };
    const fallbacks = ['monospace', 'serif'].map((generic) => width(generic));
    found = FONT_CHOICES.filter((font) => GENERIC.has(font) || ['monospace', 'serif'].some((generic, index) => width(`"${font}", ${generic}`) !== fallbacks[index]));
    return found;
};

export interface TextLayout {
    font: string;
    lines: string[];
    /** Pixels from line to line. */
    lineHeight: number;
    align: CanvasTextAlign;
}

/** How text is set at a picture's height: its CSS font, its lines and their spacing. */
export const textLayout = (params: Readonly<Record<string, unknown>>, height: number): TextLayout => {
    const size = Math.max(1, Number(params.size) * height || 1);
    const lines = String(params.text ?? '').replace(/\r/g, '').split('\n').slice(0, 64);
    return {
        font: `${params.italic ? 'italic ' : ''}${params.bold ? 'bold ' : ''}${Math.round(size)}px ${cssFamily(String(params.font || 'sans-serif'))}`,
        lines,
        lineHeight: size * (Number(params.spacing) || 1.2),
        align: params.align === 'left' ? 'left' : params.align === 'right' ? 'right' : 'center',
    };
};

/** The largest side text is laid out at; bigger pictures take it scaled up. */
const MOST_TEXT_SIZE = 4096;

export const TEXT_NODE: TexNodeDef = {
    type: 'text',
    label: 'Text',
    category: 'Shapes',
    description: 'Writes text in a font of your choice, white on black: for masks, labels, stamps and engravings. New lines start new lines.',
    keywords: ['text', 'letters', 'font', 'type', 'label', 'words', 'writing', 'stamp'],
    inputs: [],
    outputs: [out('gray')],
    params: [
        { key: 'text', label: 'Text', kind: 'string', default: 'Auvra' },
        { key: 'font', label: 'Font', kind: 'font', default: 'sans-serif' },
        float('size', 'Size', 0.2, 0.01, 2, { softMax: 1, hint: 'The letters\' height, as a part of the picture\'s height.' }),
        bool('bold', 'Bold', true),
        bool('italic', 'Italic', false),
        select('align', 'Lined up', 'centre', [['left', 'Left'], ['centre', 'Centre'], ['right', 'Right']]),
        vec2('position', 'Where', [0.5, 0.5], 0, 1),
        float('rotation', 'Turn (degrees)', 0, -360, 360, { step: 1 }),
        float('spacing', 'Line spacing', 1.2, 0.5, 3),
    ],
    sizeFrom: 'graph',
    async run(context) {
        const image = context.image('gray');
        const scale = Math.min(1, MOST_TEXT_SIZE / Math.max(context.width, context.height));
        const width = Math.max(1, Math.round(context.width * scale));
        const height = Math.max(1, Math.round(context.height * scale));
        const offscreen = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : null;
        const element = offscreen ? null : Object.assign(document.createElement('canvas'), { width, height });
        const draw: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = offscreen ? offscreen.getContext('2d') : element!.getContext('2d');
        if (!draw) throw new Error('Text cannot be laid out here.');
        const layout = textLayout(context.params, height);
        draw.fillStyle = '#000';
        draw.fillRect(0, 0, width, height);
        draw.fillStyle = '#fff';
        draw.font = layout.font;
        draw.textAlign = layout.align;
        draw.textBaseline = 'middle';
        const position = Array.isArray(context.params.position) ? context.params.position.map(Number) : [0.5, 0.5];
        draw.translate(position[0] * width, position[1] * height);
        draw.rotate((Number(context.params.rotation) || 0) * Math.PI / 180);
        const top = -(layout.lines.length - 1) * layout.lineHeight / 2;
        layout.lines.forEach((line, index) => draw.fillText(line, 0, top + index * layout.lineHeight));
        // A graph's pictures keep their bottom row first (the 2D view shows the first row at the bottom):
        // turned over on the way, the canvas's top row is the picture's top, and the text reads upright.
        const texture = new THREE.CanvasTexture((offscreen ?? element!) as unknown as HTMLCanvasElement);
        texture.flipY = true;
        texture.colorSpace = THREE.NoColorSpace;
        texture.needsUpdate = true;
        try {
            await context.pass(image, 'void main() { outColor = vec4(texture(source, vUv).r); }', { inputs: { source: texture } });
        } finally {
            texture.dispose();
        }
        return { out: image };
    },
};
