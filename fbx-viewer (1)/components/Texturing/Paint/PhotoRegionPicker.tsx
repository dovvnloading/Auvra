import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAssets } from '../../../context/AssetContext';
import { cropScale, pickRegion, type RegionPick, type RegionPicture } from '../../../texturing/paint/photoRegion';
import { Button } from '../../UI/kit';
import { SliderRow } from './PaintFields';

/** The longest side a photo is looked at for picking. */
const WORKING = 256;

type Pair = [number, number];
const pairOf = (value: unknown, fallback: Pair): Pair => (Array.isArray(value) && value.length >= 2 && value.every((v) => typeof v === 'number') ? [value[0], value[1]] : fallback);

/**
 * Over a Bitmap's 2D view: its whole photo, where a click picks the material there (photoRegion), grown
 * by colour and texture within a tolerance. Everything else darkens and the best square of what was
 * picked is outlined; Use this square crops the Bitmap to it, so what comes after (Make it tile and the
 * rest) works from that material alone. The square then fills the picture, so with it goes `scale`: how
 * much of the world the picture stands for after, against before (cropScale), for the graph's size in
 * the world to follow and the bricks to keep their real size. Beside the button it says what changes.
 */
export const PhotoRegionPicker: React.FC<{
    textureId: string;
    cropFrom: unknown;
    cropSize: unknown;
    /** The metres across the graph's picture stands for now. */
    metres: number;
    onApply: (patch: { cropFrom: Pair; cropSize: Pair }, scale: number) => void;
    onClose: () => void;
}> = ({ textureId, cropFrom, cropSize, metres, onApply, onClose }) => {
    const { textures } = useAssets();
    const url = textures.find((texture) => texture.id === textureId)?.url;
    const [picture, setPicture] = useState<(RegionPicture & { shown: string }) | null>(null);
    const [failed, setFailed] = useState(false);
    const [seed, setSeed] = useState<Pair | null>(null);
    const [tolerance, setTolerance] = useState(0.5);
    const area = useRef<HTMLDivElement>(null);
    const shade = useRef<HTMLCanvasElement>(null);
    const [room, setRoom] = useState({ width: 0, height: 0 });

    // The photo read small, once.
    useEffect(() => {
        if (!url) { setFailed(true); return; }
        let live = true;
        const image = new Image();
        // A picture from elsewhere is asked for openly, so its pixels can be read.
        if (/^https?:/i.test(url) && new URL(url).origin !== window.location.origin) image.crossOrigin = 'anonymous';
        image.onload = () => {
            if (!live) return;
            const scale = Math.min(1, WORKING / Math.max(image.naturalWidth, image.naturalHeight));
            const width = Math.max(8, Math.round(image.naturalWidth * scale));
            const height = Math.max(8, Math.round(image.naturalHeight * scale));
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) { setFailed(true); return; }
            context.drawImage(image, 0, 0, width, height);
            let pixels: Uint8ClampedArray;
            try { pixels = context.getImageData(0, 0, width, height).data; } catch { setFailed(true); return; }
            const rgb = new Float32Array(width * height * 3);
            for (let i = 0; i < width * height; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = pixels[i * 4 + c] / 255;
            setPicture({ rgb, width, height, shown: url });
        };
        image.onerror = () => { if (live) setFailed(true); };
        image.src = url;
        return () => { live = false; };
    }, [url]);

    useLayoutEffect(() => {
        const element = area.current;
        if (!element) return;
        const measure = () => setRoom({ width: element.clientWidth, height: element.clientHeight });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const pick: RegionPick | null = useMemo(() => (picture && seed ? pickRegion(picture, seed[0], seed[1], tolerance) : null), [picture, seed, tolerance]);

    // Everything outside what was picked darkened.
    useEffect(() => {
        const canvas = shade.current;
        if (!canvas || !picture) return;
        canvas.width = picture.width;
        canvas.height = picture.height;
        const context = canvas.getContext('2d');
        if (!context) return;
        context.clearRect(0, 0, picture.width, picture.height);
        if (!pick) return;
        const frame = context.createImageData(picture.width, picture.height);
        for (let i = 0; i < pick.mask.length; i++) if (!pick.mask[i]) frame.data[i * 4 + 3] = 150;
        context.putImageData(frame, 0, 0);
    }, [pick, picture]);

    const scale = picture ? Math.min(room.width / picture.width, room.height / picture.height) : 0;
    const shown = picture ? { width: picture.width * scale, height: picture.height * scale } : { width: 0, height: 0 };
    const [fromX, fromY] = pairOf(cropFrom, [0, 0]);
    const [sizeX, sizeY] = pairOf(cropSize, [1, 1]);
    const cropped = fromX > 0 || fromY > 0 || sizeX < 1 || sizeY < 1;
    const square = pick?.square ?? null;

    const choose = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!picture || !scale) return;
        const box = event.currentTarget.getBoundingClientRect();
        setSeed([(event.clientX - box.left) / scale, (event.clientY - box.top) / scale]);
    };
    /** The crop a square gives, and how much of the world the picture then stands for against now. */
    const cropOf = (chosen: { x: number; y: number; size: number }, of: RegionPicture) => {
        const size: Pair = [chosen.size / of.width, chosen.size / of.height];
        return { patch: { cropFrom: [chosen.x / of.width, chosen.y / of.height] as Pair, cropSize: size }, scale: cropScale([sizeX, sizeY], size, of.width, of.height) };
    };
    const planned = picture && square ? cropOf(square, picture) : null;
    const apply = () => { if (planned) onApply(planned.patch, planned.scale); };
    const whole = () => { if (picture) onApply({ cropFrom: [0, 0], cropSize: [1, 1] }, cropScale([sizeX, sizeY], [1, 1], picture.width, picture.height)); };
    const shownMetres = (value: number) => (value >= 10 ? value.toFixed(0) : value >= 1 ? value.toFixed(1) : value.toFixed(2));

    return (
        <div
            className="absolute inset-0 z-10 flex flex-col bg-panel"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}
        >
            <div className="space-y-1.5 border-b border-line px-2 py-1.5">
                <p className="text-2xs leading-snug text-ink-2">
                    {pick
                        ? `What was picked covers ${Math.round(pick.share * 100)}% of the photo. ${square ? `Its best square, outlined, is ${Math.round((square.size / Math.min(picture!.width, picture!.height)) * 100)}% of the photo's shorter side.` : 'It has no room for a square: click elsewhere or raise the tolerance.'}`
                        : 'Click the material you want in the photo. What looks like it is picked, and its best square is what the material is made from.'}
                </p>
                <SliderRow label="Tolerance" value={tolerance} min={0} max={1} step={0.01} labelWidth="w-16"
                    hint="How different a part may look and still be picked: higher takes in more." onChange={setTolerance} />
                <div className="flex items-center gap-1.5">
                    <Button variant="ghost" size="sm" disabled={!cropped || !picture} onClick={whole} title="Make the material from the whole photo again (its size in the world goes back with it)">Whole photo</Button>
                    <span className="flex-1" />
                    <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
                    <Button variant="primary" size="sm" disabled={!planned} onClick={apply}>Use this square</Button>
                </div>
                {planned && Math.abs(planned.scale - 1) > 0.01 && (
                    <p className="text-2xs leading-snug text-ink-3">
                        The square will fill the picture, so the graph's size in the world goes from {shownMetres(metres)} m to {shownMetres(metres * planned.scale)} m across: the picture stands for the same piece of wall the square did, and its bumps keep their depth. On a model, repeat the material {(1 / planned.scale).toFixed(1)} times as often for the bricks to keep their size.
                    </p>
                )}
            </div>
            <div ref={area} className="relative min-h-0 flex-1">
                {failed && <p className="absolute inset-0 flex items-center justify-center text-2xs text-ink-3">The photo could not be read.</p>}
                {picture && scale > 0 && (
                    <div className="absolute cursor-crosshair" style={{ width: shown.width, height: shown.height, left: (room.width - shown.width) / 2, top: (room.height - shown.height) / 2 }} onPointerDown={choose}>
                        <img src={picture.shown} alt="" draggable={false} className="absolute inset-0 h-full w-full select-none" />
                        <canvas ref={shade} className="absolute inset-0 h-full w-full" />
                        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
                            {!pick && cropped && (
                                <rect x={fromX * shown.width} y={fromY * shown.height} width={sizeX * shown.width} height={sizeY * shown.height} fill="none" stroke="rgb(240 138 60 / 0.8)" strokeWidth={1} strokeDasharray="4 3" />
                            )}
                            {square && (
                                <rect x={square.x * scale} y={square.y * scale} width={square.size * scale} height={square.size * scale} fill="none" stroke="rgb(240 138 60)" strokeWidth={2} />
                            )}
                            {seed && <circle cx={seed[0] * scale} cy={seed[1] * scale} r={4} fill="rgb(240 138 60)" stroke="rgb(0 0 0 / 0.6)" />}
                        </svg>
                    </div>
                )}
            </div>
        </div>
    );
};
