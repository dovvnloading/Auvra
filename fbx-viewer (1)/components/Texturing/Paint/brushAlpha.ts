import type * as THREE from 'three';
import { builtInAlphaTexture } from '../../../texturing/paint/brushLibrary';
import { graphStamps } from '../../../texturing/paint/graphStamps';
import type { BrushSettings } from '../../../texturing/paint/strokes';
import type { PaintSession } from './paintSession';

/**
 * The picture a brush's dabs take their shape from: its alpha picture, or the texture graph it stamps
 * (drawn once for its values). `waiting` says why there is none yet when the brush needs one.
 */
export const brushAlpha = (brush: Pick<BrushSettings, 'shape' | 'alphaTexture' | 'graphStamp'>, session: PaintSession): { alpha: THREE.Texture | null; waiting: string | null } => {
    if (brush.shape === 'picture') return { alpha: brush.alphaTexture ? builtInAlphaTexture(brush.alphaTexture) ?? session.host.texture(brush.alphaTexture) : null, waiting: null };
    if (brush.shape !== 'graph') return { alpha: null, waiting: null };
    if (!brush.graphStamp) return { alpha: null, waiting: 'Pick the graph the brush stamps in the Brush panel.' };
    const host = session.stack.host;
    const got = graphStamps.get(brush.graphStamp, session.gpu, host.resolveGraph, host.graphTexture ?? host.texture);
    return { alpha: got.texture, waiting: got.texture ? null : got.error ?? 'The brush\'s graph is still drawing: paint again in a moment.' };
};
