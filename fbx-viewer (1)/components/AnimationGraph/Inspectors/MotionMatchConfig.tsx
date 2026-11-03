import React from 'react';
import { Footprints, Plus, X } from 'lucide-react';
import { GraphState } from '../../../types';
import { Select } from '../../UI/Select';

interface MotionMatchConfigProps {
    node: GraphState;
    updateState: (updates: Partial<GraphState>) => void;
    clipOptions: { label: string; value: string }[];
}

/**
 * A Motion Match state's clips: the locomotion it may play (idle, walks, runs, strafes, starts, stops,
 * turns). Each moment it plays the part of one that best carries on how the character is moving.
 */
export const MotionMatchConfig: React.FC<MotionMatchConfigProps> = ({ node, updateState, clipOptions }) => (
    <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-2xs font-bold text-gray-500">
            <Footprints size={11} /> Clips to match from
        </div>
        {node.blendSamples.map((sample, index) => (
            <div key={sample.id} className="grid grid-cols-[1fr_18px] items-center gap-1">
                <Select
                    value={sample.clipName}
                    onChange={(clipName) => updateState({ blendSamples: node.blendSamples.map((entry, i) => (i === index ? { ...entry, clipName } : entry)) })}
                    options={[{ label: 'Pick a clip...', value: '' }, ...clipOptions]}
                />
                <button
                    type="button"
                    aria-label={`Remove clip ${index + 1}`}
                    onClick={() => updateState({ blendSamples: node.blendSamples.filter((_, i) => i !== index) })}
                    className="text-gray-500 hover:text-red-400"
                >
                    <X size={12} />
                </button>
            </div>
        ))}
        <button
            type="button"
            onClick={() => updateState({ blendSamples: [...node.blendSamples, { id: crypto.randomUUID(), clipName: '', position: [0, 0] }] })}
            className="flex w-full items-center justify-center gap-1 rounded border border-gray-700 bg-gray-800 py-1 text-2xs text-gray-200 hover:bg-gray-700"
        >
            <Plus size={10} /> Clip
        </button>
        <p className="text-2xs leading-snug text-gray-500">
            The state plays whichever moment of these clips best carries on the character's movement and pose, and crossfades when another fits better.
            Clips that travel play in place; a clip made in place has its travel read from its feet. The more ways of moving they cover, the better it follows.
        </p>
    </div>
);
