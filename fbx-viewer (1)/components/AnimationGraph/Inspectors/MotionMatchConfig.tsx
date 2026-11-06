import React, { useEffect, useMemo, useState } from 'react';
import type * as THREE from 'three';
import { CrossIcon, FootprintsIcon, PlusIcon, WarningIcon } from '../../UI/Icons';
import { GraphState } from '../../../types';
import { Select } from '../../UI/Select';
import { motionDatabaseWhenReady } from '../../../runtime/motionDatabase';
import { SAMPLE_RATE, type MotionDatabase } from '../../../runtime/motionMatching';

interface MotionMatchConfigProps {
    node: GraphState;
    updateState: (updates: Partial<GraphState>) => void;
    clipOptions: { label: string; value: string }[];
    /** The model the graph previews on, to show what the clips do on it. */
    model?: THREE.Object3D | null;
    clipByName?: (name: string) => THREE.AnimationClip | null;
}

/** What one clip does, in words: how fast and which way it travels, or how far it turns on the spot. */
export interface ClipMotionSummary {
    name: string;
    /** Metres (model units) a second over the ground. */
    speed: number;
    /** Degrees turned over the clip, left positive. */
    turn: number;
    text: string;
    /** Plays once (a start, a stop, a turn round) rather than looping. */
    once?: boolean;
}

/** A clip's way of travel, from its local direction (x to the left, z ahead). */
const wayOf = (x: number, z: number): string => {
    const angle = (Math.atan2(x, z) * 180) / Math.PI;
    const around = Math.abs(angle);
    if (around < 30) return 'forward';
    if (around > 150) return 'backward';
    if (around >= 60 && around <= 120) return angle > 0 ? 'to the left' : 'to the right';
    return `${angle > 0 ? 'left' : 'right'} of ${around < 90 ? 'ahead' : 'behind'}`;
};

/** What each of a database's own clips (not the mirrored copies) does. */
export const summarizeClips = (database: MotionDatabase, names: readonly string[]): ClipMotionSummary[] =>
    names.flatMap((name) => {
        const index = database.clips.findIndex(clip => clip.name === name);
        if (index < 0) return [];
        const clip = database.clips[index];
        const duration = (clip.samples.length - 1) / SAMPLE_RATE;
        const speed = database.clipSpeed(name);
        const turn = ((database.facingAt(index, duration) - database.facingAt(index, 0)) * 180) / Math.PI;
        if (!clip.loop) {
            // Played once: how it starts and how it ends.
            const edge = Math.min(2 / SAMPLE_RATE, duration / 4);
            const first = clip.samples[0], last = clip.samples[clip.samples.length - 1];
            const drop = (first.hips.y - first.root.y) - (last.hips.y - last.root.y);
            const startWay = database.travelAt(index, edge), endWay = database.travelAt(index, duration - edge);
            const startSpeed = Math.hypot(startWay.x, startWay.z), endSpeed = Math.hypot(endWay.x, endWay.z);
            const still = 0.25 * database.body;
            const side = turn > 0 ? 'left' : 'right';
            let once: string;
            if (drop > 0.3 * database.body) once = 'lands (once)';
            else if (Math.abs(turn) > 120) once = startSpeed > still ? `turns round to the ${side} while moving (once)` : `turns round to the ${side} on the spot (once)`;
            else if (startSpeed <= still && endSpeed > still) once = `sets off from standing, up to ${endSpeed.toFixed(1)} m/s (once)`;
            else if (startSpeed > still && endSpeed <= still) once = `stops from ${startSpeed.toFixed(1)} m/s (once)`;
            else if (Math.abs(turn) > 20 && startSpeed <= still) once = `turns ${Math.round(Math.abs(turn))}° ${side} on the spot (once)`;
            else once = 'plays once';
            return [{ name, speed, turn, text: once, once: true }];
        }
        // Its way over the whole clip, seen from the model's own forward (as the clip was made), not its chest.
        const first = clip.samples[0].root, last = clip.samples[clip.samples.length - 1].root;
        let text: string;
        if (speed > 0) text = `${Math.abs(turn) > 30 ? 'turns while it moves' : 'moves'} ${wayOf(last.x - first.x, last.z - first.z)} at ${speed.toFixed(1)} m/s`;
        else if (Math.abs(turn) > 20) text = `turns ${Math.round(Math.abs(turn))}° ${turn > 0 ? 'left' : 'right'} on the spot`;
        else text = 'stands';
        return [{ name, speed, turn, text }];
    });

/** What is missing from a state's clips, in words, for the inspector to warn about. */
export const coverageWarnings = (summaries: readonly ClipMotionSummary[]): string[] => {
    const warnings: string[] = [];
    if (!summaries.length) return warnings;
    const loops = summaries.filter(clip => !clip.once);
    if (!loops.some(clip => clip.speed === 0 && Math.abs(clip.turn) <= 20)) warnings.push('No clip stands still: the character keeps stepping when it stops. Add an idle.');
    if (!loops.some(clip => clip.speed > 0)) warnings.push('No clip travels: add walks or runs.');
    if (!summaries.some(clip => clip.speed === 0 && Math.abs(clip.turn) > 20) && !summaries.some(clip => clip.once && /on the spot/.test(clip.text))) {
        warnings.push('No clip turns on the spot, so turning in place slides the feet. One side is enough: the other is mirrored.');
    }
    return warnings;
};

/**
 * A Motion Match state's clips: the locomotion it may play (idle, walks, runs, strafes, starts, stops,
 * turns). Each moment it plays the part of one that best carries on how the character is moving.
 */
export const MotionMatchConfig: React.FC<MotionMatchConfigProps> = ({ node, updateState, clipOptions, model = null, clipByName }) => {
    const names = useMemo(() => [...new Set(node.blendSamples.map(sample => sample.clipName).filter((name): name is string => !!name))], [node.blendSamples]);
    const clips = useMemo(() => names.map(name => clipByName?.(name) ?? null).filter((clip): clip is THREE.AnimationClip => !!clip), [names, clipByName]);
    const [summaries, setSummaries] = useState<ClipMotionSummary[] | null>(null);
    useEffect(() => {
        setSummaries(null);
        if (!model || !clips.length) return undefined;
        // Built in the background (the same database play uses); looked for again until it is ready.
        let timer: ReturnType<typeof setTimeout> | null = null;
        const look = () => {
            const built = motionDatabaseWhenReady(model, clips);
            if (built) {
                setSummaries(built.database ? summarizeClips(built.database, clips.map(clip => clip.name)) : []);
                return;
            }
            timer = setTimeout(look, 100);
        };
        look();
        return () => { if (timer) clearTimeout(timer); };
    }, [model, clips]);
    const warnings = summaries ? coverageWarnings(summaries) : [];

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-2xs font-bold text-gray-500">
                <FootprintsIcon size={11} /> Clips to match from
            </div>
            {node.blendSamples.map((sample, index) => {
                const summary = summaries?.find(entry => entry.name === sample.clipName);
                return (
                    <div key={sample.id} className="space-y-0.5">
                        <div className="grid grid-cols-[1fr_18px] items-center gap-1">
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
                                <CrossIcon size={12} />
                            </button>
                        </div>
                        {summary && <p className="pl-1 text-2xs text-gray-500">{summary.text}</p>}
                    </div>
                );
            })}
            <button
                type="button"
                onClick={() => updateState({ blendSamples: [...node.blendSamples, { id: crypto.randomUUID(), clipName: '', position: [0, 0] }] })}
                className="flex w-full items-center justify-center gap-1 rounded border border-gray-700 bg-gray-800 py-1 text-2xs text-gray-200 hover:bg-gray-700"
            >
                <PlusIcon size={10} /> Clip
            </button>
            {warnings.map(warning => (
                <p key={warning} className="flex gap-1.5 text-2xs leading-snug text-amber-300/90">
                    <WarningIcon size={11} className="mt-px shrink-0" /> {warning}
                </p>
            ))}
            <p className="text-2xs leading-snug text-gray-500">
                The state plays whichever moment of these clips best carries on the character's movement and pose, switching at once and easing the pose across
                when another fits better. Each clip is also matched mirrored, so a turn or a strafe one way covers the other. Clips that travel play in place;
                a clip made in place has its travel read from its feet.
            </p>
        </div>
    );
};
