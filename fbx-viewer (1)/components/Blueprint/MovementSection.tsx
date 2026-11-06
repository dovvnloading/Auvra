import React from 'react';
import { FootprintsIcon } from '../UI/Icons';
import type { MovementTuning } from '../../types';
import { DEFAULT_MOVEMENT_SETTINGS, SETTLE_HALF_LIVES } from '../../runtime/locomotion/characterMotion';
import { ScrubbableInput } from '../UI/Properties/ScrubbableInput';

/** The times a player feels, as the defaults give them. */
const DEFAULT_TIMES = {
    accelerate: Math.round(DEFAULT_MOVEMENT_SETTINGS.accelerationHalfLife * SETTLE_HALF_LIVES * 100) / 100,
    brake: Math.round(DEFAULT_MOVEMENT_SETTINGS.brakingHalfLife * SETTLE_HALF_LIVES * 100) / 100,
    turn: Math.round(DEFAULT_MOVEMENT_SETTINGS.turnHalfLife * SETTLE_HALF_LIVES * 100) / 100,
    turnFirst: DEFAULT_MOVEMENT_SETTINGS.turnFirstAngle,
};

interface MovementSectionProps {
    movement: MovementTuning;
    /** `coalesce` groups a drag's many changes into one undo step. */
    onChange: (changes: Partial<MovementTuning>, coalesce: string) => void;
}

const Row: React.FC<{ title: string; label: string; value: number; step: number; min: number; max: number; onChange: (value: number) => void }> = ({ title, label, value, step, min, max, onChange }) => (
    <div className="flex items-center justify-between gap-4">
        <span className="text-xs text-gray-400 shrink-0">{title}</span>
        <div className="w-28">
            <ScrubbableInput label={label} value={value} step={step} labelColor="text-blue-400" labelWidth="w-10" onChange={(v) => onChange(Math.min(max, Math.max(min, v)))} />
        </div>
    </div>
);

/**
 * How a player character gets going, stops and turns: the times it takes, as a player feels them. The
 * character's speed and facing follow springs that reach these in the time given.
 */
export const MovementSection: React.FC<MovementSectionProps> = ({ movement, onChange }) => (
    <div className="space-y-2">
        <label className="text-2xs font-bold text-gray-500 flex items-center gap-2">
            <FootprintsIcon size={12} /> Movement
        </label>
        <div className="bg-gray-800/50 rounded p-3 border border-gray-800 space-y-3">
            <Row title="Reaches full speed in (s)" label="Time" value={movement.accelerate ?? DEFAULT_TIMES.accelerate} step={0.02} min={0} max={5} onChange={(accelerate) => onChange({ accelerate }, 'movementAccelerate')} />
            <Row title="Stops in (s)" label="Time" value={movement.brake ?? DEFAULT_TIMES.brake} step={0.02} min={0} max={5} onChange={(brake) => onChange({ brake }, 'movementBrake')} />
            <Row title="Turns round in (s)" label="Time" value={movement.turn ?? DEFAULT_TIMES.turn} step={0.02} min={0} max={5} onChange={(turn) => onChange({ turn }, 'movementTurn')} />
            <Row title="Turn on the spot past (°)" label="Angle" value={movement.turnFirst ?? DEFAULT_TIMES.turnFirst} step={5} min={0} max={180} onChange={(turnFirst) => onChange({ turnFirst }, 'movementTurnFirst')} />
            <p className="text-2xs text-gray-500 leading-tight">
                Shorter times feel snappier; longer, heavier. Setting off from a standstill toward a way further round than the angle,
                the character turns on the spot first (stepping round with its turn clip, when its animation matches one), then sets off; 0 sets off at once.
            </p>
        </div>
    </div>
);
