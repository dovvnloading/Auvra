import { int, out } from '../nodeKit';
import type { TexNodeDef } from '../types';

/**
 * THE TIME NODE
 *
 * The graph's time, going round its loop (the loop's length is the graph's Animation setting): seconds
 * into the loop, how far round it is, and that as a point going round a circle. Wired into settings
 * shown as pins, it animates them; what it drives at the loop's end meets what it drives at the start,
 * so the animation tiles in time. Only nodes it reaches draw again as the time changes.
 */

export const TIME_NODE_TYPE = 'time';

export const TIME_NODE: TexNodeDef = {
    type: TIME_NODE_TYPE,
    label: 'Time',
    category: 'Inputs and outputs',
    description: 'The graph\'s time going round its loop (set under the graph\'s Animation): seconds, how far round (0 to 1), and a point going round a circle, which noise can follow to loop with no jump. Wire it into a setting shown as a pin.',
    keywords: ['time', 'animation', 'animate', 'seconds', 'loop', 'phase', 'clock', 'frame'],
    inputs: [],
    outputs: [
        { ...out('color', 'out', 'Seconds'), kind: 'value' },
        { ...out('color', 'phase', 'How far round'), kind: 'value' },
        { ...out('color', 'circle', 'Round a circle'), kind: 'value' },
    ],
    params: [int('turns', 'Times round each loop', 1, 1, 64, { hint: 'How many times How far round and the circle go round in one loop: whole turns, so they still meet up at the loop\'s end.' })],
    sizeFrom: 'graph',
    bypass: false,
    settingsInShader: true,
    readsTime: () => true,
    async run(context) {
        const result: Record<string, ReturnType<typeof context.image>> = {};
        const glsl: Record<string, string> = {
            out: 'outColor = vec4(uTime, uTime, uTime, 1.0);',
            phase: 'float t = fract(uPhase * float(p_turns)); outColor = vec4(t, t, t, 1.0);',
            circle: 'float a = fract(uPhase * float(p_turns)) * TAU; outColor = vec4(cos(a), sin(a), 0.0, 1.0);',
        };
        for (const [key, body] of Object.entries(glsl)) {
            const image = context.image('color', 1, 1, 32);
            await context.pass(image, `void main() { ${body} }`);
            result[key] = image;
        }
        return result;
    },
};

/** The CPU twin of the Time node's values at a time (seconds into the loop) and phase. */
export const timeValues = (seconds: number, phase: number, turns = 1): { out: number; phase: number; circle: [number, number] } => {
    const t = (phase * turns) % 1;
    const a = t * Math.PI * 2;
    return { out: seconds, phase: t, circle: [Math.cos(a), Math.sin(a)] };
};
