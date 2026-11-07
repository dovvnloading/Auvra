import React, { useImperativeHandle, useRef, useState } from 'react';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import type { MaterialAsset } from '../../../runtime/materials/materialLibrary';
import { RotateIcon, WarningIcon } from '../../UI/Icons';
import { Button, Spinner } from '../../UI/kit';
import { useTextureStore } from '../useTextureStore';
import { CAPTURE_FEWEST, CAPTURE_MOST, createCaptureMaterial, readCaptureSet, type CaptureSet } from './captureImport';
import { SliderRow } from './PaintFields';
import { PHOTO_ACCEPT } from './photoImport';

export interface CaptureMaterialPickerHandle {
    pick: () => void;
}

const SIDES = ['the right', 'the top right', 'the top', 'the top left', 'the left', 'the bottom left', 'the bottom', 'the bottom right'];
/** Which side a light comes from, in words. */
const sideOf = (azimuth: number) => SIDES[((Math.round(azimuth / (Math.PI / 4)) % 8) + 8) % 8];
const DEGREES = Math.PI / 180;

/** One photo, with where its light came from shown at its edge: dragging on it moves the light. */
const LightTile: React.FC<{ name: string; picture: string; azimuth: number; onChange: (azimuth: number) => void }> = ({ name, picture, azimuth, onChange }) => {
    const dragging = useRef(false);
    const aim = (event: React.PointerEvent<HTMLDivElement>) => {
        const box = event.currentTarget.getBoundingClientRect();
        const dx = event.clientX - (box.left + box.width / 2);
        const dy = event.clientY - (box.top + box.height / 2);
        if (Math.hypot(dx, dy) > 4) onChange(Math.atan2(-dy, dx));
    };
    const x = 50 + Math.cos(azimuth) * 42;
    const y = 50 - Math.sin(azimuth) * 42;
    return (
        <figure className="min-w-0">
            <div
                className="relative aspect-square cursor-crosshair overflow-hidden rounded border border-gray-700 bg-gray-950"
                title="Drag towards the side this photo's light came from"
                onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); aim(event); }}
                onPointerMove={(event) => { if (dragging.current) aim(event); }}
                onPointerUp={() => { dragging.current = false; }}
            >
                <img src={picture} alt="" draggable={false} className="h-full w-full select-none object-cover" />
                <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full">
                    <line x1={50} y1={50} x2={x} y2={y} stroke="rgb(255 214 120 / 0.9)" strokeWidth={1.5} strokeDasharray="3 2" />
                    <circle cx={x} cy={y} r={6} fill="rgb(255 214 120)" stroke="rgb(0 0 0 / 0.6)" strokeWidth={1} />
                </svg>
            </div>
            <figcaption className="mt-1 truncate text-2xs text-ink-2" title={name}>Lit from {sideOf(azimuth)}</figcaption>
        </figure>
    );
};

/**
 * Makes a texture graph material from three to eight photos of one surface, each lit from a different
 * side: the photos are read and their lights worked out (captureImport), shown for checking (each light
 * can be dragged, all can be turned round, and the light's height set), then the material is made.
 */
export const CaptureMaterialPicker = React.forwardRef<CaptureMaterialPickerHandle, { onMade: (asset: MaterialAsset) => void; className?: string }>(({ onMade, className = '' }, ref) => {
    const input = useRef<HTMLInputElement>(null);
    const { store } = useTextureStore();
    const [status, setStatus] = useState<string | null>(null);
    const [set, setSet] = useState<CaptureSet | null>(null);
    const [azimuths, setAzimuths] = useState<number[]>([]);
    const [elevation, setElevation] = useState(40);
    const [working, setWorking] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    useImperativeHandle(ref, () => ({ pick: () => input.current?.click() }));

    const read = (files: File[]) => {
        setStatus(`Reading ${files.length} photos…`);
        void readCaptureSet(files).then((read) => {
            setStatus(null);
            setFailure(null);
            setSet(read);
            setAzimuths(read.estimate.azimuths);
        }, (error: unknown) => {
            frontendDiagnostics.failure('capture_material_read_failed', error);
            setStatus(error instanceof Error ? error.message : 'The photos could not be read.');
        });
    };
    const close = () => { if (!working) setSet(null); };
    const make = () => {
        if (!set) return;
        setWorking(true);
        setFailure(null);
        // A frame first, so the dialog says it is working before the sums take the thread.
        window.setTimeout(() => {
            void createCaptureMaterial(set, azimuths, elevation * DEGREES, store).then((asset) => {
                setWorking(false);
                setSet(null);
                onMade(asset);
            }, (error: unknown) => {
                frontendDiagnostics.failure('capture_material_failed', error);
                setWorking(false);
                setFailure(error instanceof Error ? error.message : 'The material could not be made from these photos.');
            });
        }, 30);
    };

    return (
        <>
            <input ref={input} type="file" multiple accept={PHOTO_ACCEPT} className="hidden" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) read(files); }} />
            {status && <p className={`text-2xs leading-snug text-ink-3 ${className}`} role="status">{status}</p>}
            {set && (
                <div
                    className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
                    onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); close(); } }}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <div role="dialog" aria-modal="true" aria-labelledby="capture-title" className="max-h-full w-[560px] max-w-full space-y-3 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 p-4 shadow-2xl">
                        <h2 id="capture-title" className="text-sm font-semibold text-ink">Material from photos lit from several sides</h2>
                        <p className="text-xs leading-snug text-ink-2">
                            The light directions below were worked out from the photos. If one looks wrong, drag on that photo towards the side its light came from.
                        </p>
                        {!set.sameSize && (
                            <p className="flex items-start gap-1.5 text-2xs leading-snug text-warn"><WarningIcon size={12} className="mt-px shrink-0" />These photos are not all one size. They need to be taken from one spot, with the camera held still.</p>
                        )}
                        {set.estimate.fit < 0.6 && (
                            <p className="flex items-start gap-1.5 text-2xs leading-snug text-warn"><WarningIcon size={12} className="mt-px shrink-0" />These photos differ by more than their light. Check they show the same surface, from the same spot.</p>
                        )}
                        <div className="grid grid-cols-4 gap-2">
                            {set.thumbnails.map((picture, index) => (
                                <LightTile key={set.names[index] + index} name={set.names[index]} picture={picture} azimuth={azimuths[index] ?? 0}
                                    onChange={(azimuth) => setAzimuths((list) => list.map((value, at) => (at === index ? azimuth : value)))} />
                            ))}
                        </div>
                        <SliderRow label="Light height" value={elevation} min={10} max={80} step={1} suffix="°" labelWidth="w-24"
                            hint="How high the light stood over the surface: 30 to 50 degrees suits most captures. Lower makes the relief read shallower."
                            onChange={setElevation} />
                        {failure && <p className="text-2xs leading-snug text-bad" role="alert">{failure}</p>}
                        <div className="flex items-center gap-2">
                            <Button variant="ghost" size="sm" icon={<RotateIcon size={12} />} disabled={working}
                                title="For a relief that reads inside out, raised parts sunk: every light turned to the opposite side"
                                onClick={() => setAzimuths((list) => list.map((azimuth) => azimuth + Math.PI))}>Turn all lights round</Button>
                            <span className="flex-1" />
                            {working && <span className="flex items-center gap-1.5 text-2xs text-ink-2"><Spinner />Working out the normal and colour…</span>}
                            <Button variant="ghost" disabled={working} onClick={close}>Cancel</Button>
                            <Button variant="primary" disabled={working} onClick={make}>Make the material</Button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
});
CaptureMaterialPicker.displayName = 'CaptureMaterialPicker';

/** What the New menu says of a capture. */
export const CAPTURE_MENU_TEXT = `${CAPTURE_FEWEST} to ${CAPTURE_MOST} photos of one surface from the same spot, each with the light from a different side: its true normal, colour and height worked out from how the light falls.`;
