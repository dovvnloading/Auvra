import React, { useEffect, useRef, useState } from 'react';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { describeProviderFailure, type ProviderModel } from '../../../services/HostProviderService';
import { formatCost } from '../../../services/providerPricing';
import type { TextureGraph } from '../../../texturing/graph/types';
import { encodePng } from '../../../texturing/png';
import { baseColourSource, isPhotoGraph, withAiMaps } from '../../../texturing/paint/photoMaterial';
import { SparklesIcon } from '../../UI/Icons';
import { Button, Spinner } from '../../UI/kit';
import type { TextureGraphSession } from '../textureGraphSession';
import { useTextureStore } from '../useTextureStore';
import { AI_MAPS_LARGEST, aiMapsCost, aiMapsModel, makeAiMaps } from './aiMaps';

/** The picture a node drew, top row first, at most AI_MAPS_LARGEST across, as PNG. */
const pictureOf = async (session: TextureGraphSession, nodeId: string): Promise<Blob | null> => {
    const image = session.imageOf(nodeId);
    if (!image) return null;
    const bytes = await session.gpu.readRgba8Later(image);
    if (!bytes) return null;
    const { width, height } = image;
    // The GPU reads the bottom row first.
    const rows = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) rows.set(bytes.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
    for (let i = 3; i < rows.length; i += 4) rows[i] = 255;
    const scale = Math.min(1, AI_MAPS_LARGEST / Math.max(width, height));
    if (scale === 1) return encodePng(rows, width, height);
    const full = document.createElement('canvas');
    full.width = width;
    full.height = height;
    full.getContext('2d')?.putImageData(new ImageData(rows, width, height), 0, 0);
    const small = document.createElement('canvas');
    small.width = Math.round(width * scale);
    small.height = Math.round(height * scale);
    const context = small.getContext('2d');
    if (!context) return null;
    context.imageSmoothingQuality = 'high';
    context.drawImage(full, 0, 0, small.width, small.height);
    return new Promise((resolve) => small.toBlob(resolve, 'image/png'));
};

/**
 * Refine with AI, for a graph made from photos, shown only while a provider for surface maps is set up:
 * the graph's tiled colour with its lighting taken out goes to the AI, and the maps it gives back come
 * into the graph beside its own, mixed by an AI maps parameter (photoMaterial.withAiMaps). Says what
 * it comes to before it runs.
 */
export const RefineWithAi: React.FC<{
    session: TextureGraphSession;
    graph: TextureGraph;
    /** The material's name, for the maps' names in the library. */
    name: string;
    onGraph: (next: TextureGraph) => void;
}> = ({ session, graph, name, onGraph }) => {
    const { store } = useTextureStore();
    const [model, setModel] = useState<ProviderModel | null>(null);
    const [state, setState] = useState<'idle' | 'making' | 'failed'>('idle');
    const [failure, setFailure] = useState<string | null>(null);
    const latest = useRef(graph);
    latest.current = graph;
    const photo = isPhotoGraph(graph);
    useEffect(() => {
        if (!photo) return;
        let live = true;
        void aiMapsModel().then((found) => { if (live) setModel(found); });
        return () => { live = false; };
    }, [photo]);
    if (!photo || !model) return null;
    // The graph's size is in powers of two.
    const cost = aiMapsCost(model, 2 ** Math.max(graph.size.w, graph.size.h));
    const refined = graph.nodes.some((node) => node.type === 'bitmap' && node.name?.startsWith('AI '));

    const refine = async () => {
        setState('making');
        setFailure(null);
        try {
            const source = baseColourSource(latest.current);
            const colour = source ? await pictureOf(session, source.id) : null;
            if (!colour) throw new Error('The colour is not drawn yet: wait for the graph to finish drawing, then try again.');
            const maps = await makeAiMaps(colour, model, name, store);
            onGraph(withAiMaps(latest.current, maps));
            setState('idle');
        } catch (error) {
            frontendDiagnostics.failure('photo_ai_maps_failed', error);
            setState('failed');
            setFailure(describeProviderFailure(error instanceof Error ? error.message : undefined) || 'The AI could not make maps for this colour.');
        }
    };

    return (
        <div className="space-y-1.5 border-t border-line pt-2">
            <div className="flex items-center gap-1.5">
                <span className="flex-1 text-2xs font-semibold text-ink-2">AI matching maps</span>
                {cost !== null && state !== 'making' && <span className="text-2xs tabular-nums text-ink-3">About {formatCost(cost)}</span>}
            </div>
            <p className="text-2xs leading-snug text-ink-3">
                Sends the tiled colour, with its lighting taken out, to an AI, and mixes the normal, roughness, metal and height it gives back with the ones worked out here. AI maps mixed in, under Parameters, sets how much.
            </p>
            {failure && <p role="alert" className="text-2xs leading-snug text-bad">{failure}</p>}
            <Button size="sm" icon={state === 'making' ? <Spinner /> : <SparklesIcon size={12} />} disabled={state === 'making'} onClick={() => void refine()}>
                {state === 'making' ? 'The AI is making maps…' : state === 'failed' ? 'Try again' : refined ? 'Refine with AI again' : 'Refine with AI'}
            </Button>
        </div>
    );
};
