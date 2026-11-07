import React from 'react';
import { CheckIcon, CrossIcon } from '../../UI/Icons';
import { Button } from '../../UI/kit';
import { Select } from '../../UI/Select';
import { SliderRow } from './PaintFields';
import type { DecalSettings } from './PaintViewport';

/**
 * The decal tool's settings: the picture, its size, turn and strength, and keeping or giving up the decal
 * being placed. The decal itself is placed by clicking and dragging on the model.
 */
export const DecalPanel: React.FC<{
    decal: DecalSettings;
    onChange: (decal: DecalSettings) => void;
    textures: ReadonlyArray<{ id: string; name: string }>;
    /** A decal is on the model, waiting to be kept or given up. */
    placed: boolean;
    onKeep: () => void;
    onDrop: () => void;
}> = ({ decal, onChange, textures, placed, onKeep, onDrop }) => {
    const set = (patch: Partial<DecalSettings>) => onChange({ ...decal, ...patch });
    return (
        <section className="space-y-2 border-b border-zinc-800 p-3">
            <div className="text-2xs font-semibold text-zinc-300">Decal</div>
            <Select value={decal.textureId} placeholder="Pick its picture" options={textures.map((texture) => ({ value: texture.id, label: texture.name }))} onChange={(textureId) => set({ textureId: String(textureId) })} className="w-full" />
            <SliderRow label="Size" labelWidth="w-24" value={decal.size} min={0.01} max={1} onChange={(size) => set({ size })} />
            <SliderRow label="Turn" labelWidth="w-24" value={decal.angle} min={-180} max={180} step={1} suffix="°" onChange={(angle) => set({ angle })} />
            <SliderRow label="Strength" labelWidth="w-24" value={decal.strength} min={0} max={1} onChange={(strength) => set({ strength })} />
            <div className="flex gap-1.5">
                <Button size="sm" variant="primary" className="flex-1 justify-center" disabled={!placed} icon={<CheckIcon size={12} />} onClick={onKeep}>Lay it on</Button>
                <Button size="sm" variant="ghost" disabled={!placed} icon={<CrossIcon size={12} />} onClick={onDrop}>Give it up</Button>
            </div>
            <p className="text-2xs leading-snug text-zinc-500">
                Click the model to place the decal and drag to move it; after laying it on or giving it up, click again to place the next. It wraps over curves and across UV seams by the distance along the surface, so it does not stretch. Size is a share of the texture set's size; it lays its colour on base colour and emission, and the brush's values on the other channels it paints, through the picture's alpha.
            </p>
        </section>
    );
};
