import { OUTPUT_NODE_TYPE, defaultParams, normalizeMaterialGraph, type MaterialGraph, type MaterialGraphLink } from './materialGraph';

/**
 * STARTER MATERIALS
 *
 * Ready shader graphs offered when a material is made, each a few nodes with values close to the real
 * thing, to start from and to check the physical surface against photos. Colours are as picked (sRGB).
 *
 * - Car paint: a deep red base strewn with silver metal flakes, under a glossy coat tinted red (a candy
 *   finish): the flakes glint red through it, each catching the light at its own angle. Coats on cars are
 *   about 1.5 in index of refraction, which the coat uses.
 * - Frosted glass: clear soda-lime glass (index 1.52) seen through, its surface roughened so what is
 *   behind blurs.
 * - Velvet: a rich wine-red base under a bright pink sheen, as its standing fibres catch light at
 *   grazing angles. The base is light enough to read as red seen head-on, where the sheen gives little;
 *   the sheen is broad (roughness 0.65) and at full strength, so the edges glow over a wide band.
 * - Lacquered wood: grain drawn from stretched noise, under a satin lacquer coat.
 * - Rubber: a near-black, rough, plain surface: the standard material draws it.
 */

export interface StarterMaterial {
    key: string;
    name: string;
    /** What it is, in a few plain words. */
    description: string;
    graph: () => MaterialGraph;
}

const OUTPUT = 'output';

const output = (params: Record<string, unknown>, x = 480) => ({ id: OUTPUT, type: OUTPUT_NODE_TYPE, x, y: 120, params: { ...defaultParams(OUTPUT_NODE_TYPE), ...params } });

const node = (id: string, type: string, x: number, y: number, params: Record<string, unknown> = {}) => ({ id, type, x, y, params: { ...defaultParams(type), ...params } });

const wire = (fromNode: string, fromOutput: string, toNode: string, toInput: string): MaterialGraphLink => ({ fromNode, fromOutput, toNode, toInput });

export const STARTER_MATERIALS: readonly StarterMaterial[] = [
    {
        key: 'carPaint',
        name: 'Car paint',
        description: 'Red paint with metal flakes glinting under a glossy tinted coat.',
        graph: () => normalizeMaterialGraph({
            nodes: [output({
                baseColor: [0.45, 0.02, 0.03], metalness: 0.15, roughness: 0.4,
                coat: 1, coatRoughness: 0.02, coatColor: [1, 0.6, 0.58],
                flakeDensity: 0.45, flakeSize: 0.015, flakeColor: [0.92, 0.92, 0.92],
            })],
            links: [],
        }),
    },
    {
        key: 'frostedGlass',
        name: 'Frosted glass',
        description: 'Clear glass with a roughened surface that blurs what is behind it.',
        graph: () => normalizeMaterialGraph({
            nodes: [output({ baseColor: [1, 1, 1], metalness: 0, roughness: 0.35, transmission: 1, thickness: 0.01, ior: 1.52 })],
            links: [],
        }),
    },
    {
        key: 'velvet',
        name: 'Velvet',
        description: 'A deep wine colour with a soft, bright sheen at the edges.',
        graph: () => normalizeMaterialGraph({
            nodes: [output({ baseColor: [0.58, 0.07, 0.16], metalness: 0, roughness: 0.9, sheenColor: [1, 0.55, 0.7], sheenRoughness: 0.65 })],
            links: [],
        }),
    },
    {
        key: 'lacqueredWood',
        name: 'Lacquered wood',
        description: 'Wood grain under a satin lacquer coat.',
        graph: () => normalizeMaterialGraph({
            nodes: [
                output({ metalness: 0, roughness: 0.5, coat: 1, coatRoughness: 0.08 }, 720),
                // Grain: noise stretched along the board, then coloured from dark to light wood.
                node('stretch', 'tilingOffset', -40, 40, { tiling: [1.5, 12] }),
                node('grain', 'fractalNoise', 200, 40, { scale: 3, octaves: 4 }),
                node('wood', 'colorRamp', 440, 40, {
                    ramp: { stops: [{ position: 0.2, color: [0.3, 0.16, 0.08] }, { position: 0.5, color: [0.55, 0.33, 0.17] }, { position: 0.8, color: [0.7, 0.47, 0.27] }] },
                }),
            ],
            links: [wire('stretch', 'out', 'grain', 'position'), wire('grain', 'out', 'wood', 'fac'), wire('wood', 'out', OUTPUT, 'baseColor')],
        }),
    },
    {
        key: 'rubber',
        name: 'Rubber',
        description: 'Near-black, rough and dull.',
        graph: () => normalizeMaterialGraph({
            nodes: [output({ baseColor: [0.08, 0.08, 0.08], metalness: 0, roughness: 0.8 })],
            links: [],
        }),
    },
];
