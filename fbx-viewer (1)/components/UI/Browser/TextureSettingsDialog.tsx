import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CrossIcon } from '../Icons';
import type { TextureData } from '../../../types';
import { Button, IconButton, Section, Segmented, Spinner } from '../kit';
import { Select } from '../Select';
import { materialLibrary } from '../../../runtime/materials/materialLibrary';
import { limitPictureSize, pictureToRgba8, type DecodedPicture } from '../../../texturing/textureDecode';
import { decodePictureOffPage, encodeTextureOffPage } from '../../../texturing/texturePipeline';
import {
    FORMAT_WORDS,
    MAX_SIZE_CHOICES,
    keptFormat,
    limitedSize,
    wholeFormat,
    setTextureSettings,
    textureRole,
    textureSettingsOf,
    type KeptFormat,
    type TextureCompressionChoice,
    type TextureSettings,
} from '../../../texturing/textureSettings';
import { compressionSupport } from '../../../texturing/materialTextureLoader';
import { decodeLevel, textureMemoryBytes } from '../../../utils/textureCompression/materialTextureEncoder';
import { memoryWords } from '../../../texturing/textureBudget';

/**
 * TEXTURE SETTINGS
 *
 * How one texture is kept and drawn (read as colour or data, a normal map, compression, size limit,
 * wrap, filter, mips), with a preview of what compression does to it: the picture before and after,
 * side by side, and the memory each takes. Saved with the texture; material assets drawing it load it
 * again with the new settings.
 */

/** The largest side the preview compresses, so it stays quick whatever the texture's size. */
const PREVIEW_SIDE = 512;

const SOURCE_WORDS: Record<string, string> = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP', tiff: 'TIFF', exr: 'OpenEXR', hdr: 'Radiance HDR', tga: 'TGA', psd: 'Photoshop (flattened)' };

/** Draws RGBA bytes onto a canvas. */
const paint = (canvas: HTMLCanvasElement | null, rgba: Uint8Array, width: number, height: number) => {
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
};

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex min-h-[28px] items-center justify-between gap-3">
        <span className="text-2xs text-ink-3">{label}</span>
        {children}
    </div>
);

export const TextureSettingsDialog: React.FC<{ texture: TextureData; onClose: () => void }> = ({ texture, onClose }) => {
    const stored = textureSettingsOf(texture.id) ?? texture.settings ?? {};
    const [settings, setSettings] = useState<TextureSettings>(stored);
    const [picture, setPicture] = useState<DecodedPicture | null>(null);
    const [readError, setReadError] = useState<string | null>(null);
    const [comparing, setComparing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const before = useRef<HTMLCanvasElement>(null);
    const after = useRef<HTMLCanvasElement>(null);
    const change = (patch: Partial<TextureSettings>) => setSettings((current) => {
        const next: TextureSettings = { ...current, ...patch };
        for (const key of Object.keys(patch) as Array<keyof TextureSettings>) if (patch[key] === undefined) delete next[key];
        return next;
    });

    // The file itself, read whole once.
    useEffect(() => {
        let current = true;
        fetch(texture.sourceUrl ?? texture.url)
            .then(response => response.arrayBuffer())
            .then(buffer => decodePictureOffPage(new Uint8Array(buffer), texture.name))
            .then(decoded => { if (current) setPicture(decoded); }, (error: unknown) => {
                if (current) setReadError(error instanceof Error ? error.message : 'The picture could not be read.');
            });
        return () => { current = false; };
    }, [texture.sourceUrl, texture.url, texture.name]);

    const role = textureRole(settings.normalMap ? 'normal' : 'map', settings);
    const support = useMemo(() => compressionSupport(), []);
    const drawn = limitedSize(texture.dimensions.width || 1, texture.dimensions.height || 1, settings.maxSize);
    const source = settings.source;
    // Once read, the picture says whether it holds light beyond white (older imports marked every EXR so).
    const hdr = picture ? picture.hdr : source?.hdr === true;
    const depth = picture?.depth ?? source?.depth ?? 8;
    const format: KeptFormat = keptFormat(role, settings, { bptc: true, rgtc: true }, {
        channels: picture?.channels ?? source?.channels ?? 4, depth, hdr, ...drawn,
    });
    const onThisDevice = keptFormat(role, settings, support, { channels: picture?.channels ?? source?.channels ?? 4, depth, hdr, ...drawn });
    const mips = settings.mips !== false;
    const wholeBytes = textureMemoryBytes(texture.dimensions.width || 1, texture.dimensions.height || 1, wholeFormat({ depth, hdr }), mips);
    const keptBytes = textureMemoryBytes(drawn.width, drawn.height, format, mips);

    // Before and after compression, side by side, at a size the preview compresses quickly.
    useEffect(() => {
        if (!picture) return;
        let current = true;
        const shown = limitPictureSize(picture, Math.min(settings.maxSize ?? PREVIEW_SIDE, PREVIEW_SIDE));
        const rgba = pictureToRgba8(shown, shown.depth === 32 && role === 'colour');
        paint(before.current, rgba, shown.width, shown.height);
        if (format === 'rgba8' || format === 'half' || shown.width % 4 || shown.height % 4) {
            paint(after.current, rgba, shown.width, shown.height);
            return;
        }
        setComparing(true);
        const kind = role === 'colour' ? 'colour' : role;
        encodeTextureOffPage(rgba.slice(), shown.width, shown.height, format, kind, false)
            .then(([level]) => {
                if (current) paint(after.current, decodeLevel(level.data, level.width, level.height, format), level.width, level.height);
            })
            .catch(() => undefined)
            .finally(() => { if (current) setComparing(false); });
        return () => { current = false; };
    }, [picture, format, role, settings.maxSize]);

    const save = async () => {
        setSaving(true);
        setSaveError(null);
        try {
            // The project store is reached only on saving, so showing the browser opens no database.
            const { dbOperations } = await import('../../../utils/db');
            // What the picture holds, as read now, so the memory view counts it the same way.
            const saved: TextureSettings = picture && settings.source
                ? { ...settings, source: { format: settings.source.format, depth: settings.source.depth, channels: settings.source.channels, ...(picture.hdr ? { hdr: true } : {}) } }
                : settings;
            await dbOperations.updateTextureSettings(texture.id, saved);
            setTextureSettings(texture.id, saved);
            materialLibrary.reloadTexture(texture.id);
            onClose();
        } catch (error) {
            setSaveError(error instanceof Error ? error.message : 'The settings could not be saved: is a project open?');
        } finally {
            setSaving(false);
        }
    };

    const compressionOptions: Array<{ value: TextureCompressionChoice; label: string }> = [
        { value: 'auto', label: 'By what it is (recommended)' },
        { value: 'bc7', label: 'Colour (BC7)' },
        { value: 'bc5', label: 'Normal map (BC5)' },
        { value: 'bc4', label: 'One channel (BC4)' },
        { value: 'none', label: 'None (largest)' },
    ];

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Texture settings"
            onKeyDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <div className="flex max-h-full w-[520px] max-w-full flex-col overflow-hidden rounded-lg border border-line bg-ground shadow-[0_8px_32px_rgb(0_0_0/0.6)]">
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-3 py-2">
                    <div className="min-w-0">
                        <h2 className="text-xs font-semibold text-ink">Texture settings</h2>
                        <p className="truncate text-2xs text-ink-3" title={texture.name}>
                            {texture.name} · {texture.dimensions.width}×{texture.dimensions.height}
                            {source ? ` · ${SOURCE_WORDS[source.format] ?? source.format}, ${source.depth} bits a channel` : ''}
                        </p>
                    </div>
                    <IconButton label="Close" onClick={onClose}><CrossIcon size={14} /></IconButton>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <Section title="What it is">
                        <Row label="Read as">
                            <Segmented label="Read as" value={settings.colorSpace ?? 'auto'}
                                options={[{ value: 'auto', label: 'By use', hint: 'Colour where a material reads colour, data where it reads data' }, { value: 'colour', label: 'Colour' }, { value: 'data', label: 'Data', hint: 'Masks, roughness, metalness, height: values kept as stored' }]}
                                onChange={(value) => change({ colorSpace: value === 'auto' ? undefined : value })} />
                        </Row>
                        <Row label="Normal map">
                            <Segmented label="Normal map" value={settings.normalMap ? 'yes' : 'no'}
                                options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]}
                                onChange={(value) => change({ normalMap: value === 'yes' ? true : undefined })} />
                        </Row>
                    </Section>
                    <Section title="How it is kept">
                        <Row label="Compression">
                            <div className="w-52"><Select value={settings.compression ?? 'auto'} placeholder="Compression" options={compressionOptions}
                                onChange={(value: TextureCompressionChoice) => change({ compression: value === 'auto' ? undefined : value })} className="w-full" /></div>
                        </Row>
                        <Row label="Size limit">
                            <div className="w-52"><Select value={settings.maxSize ?? 0} placeholder="Size limit"
                                options={[{ value: 0, label: 'Its own size' }, ...MAX_SIZE_CHOICES.map(size => ({ value: size, label: `${size} pixels` }))]}
                                onChange={(value: number) => change({ maxSize: value || undefined })} className="w-full" /></div>
                        </Row>
                        <Row label="Mip levels">
                            <Segmented label="Mip levels" value={mips ? 'on' : 'off'}
                                options={[{ value: 'on', label: 'On', hint: 'Smaller copies for far away: smooth at a distance' }, { value: 'off', label: 'Off' }]}
                                onChange={(value) => change({ mips: value === 'off' ? false : undefined })} />
                        </Row>
                    </Section>
                    <Section title="How it is drawn">
                        <Row label="Edges">
                            <Segmented label="Edges" value={settings.wrap ?? 'repeat'}
                                options={[{ value: 'repeat', label: 'Repeat' }, { value: 'clamp', label: 'Stretch edge' }, { value: 'mirror', label: 'Mirror' }]}
                                onChange={(value) => change({ wrap: value === 'repeat' ? undefined : value })} />
                        </Row>
                        <Row label="Filter">
                            <Segmented label="Filter" value={settings.filter ?? 'linear'}
                                options={[{ value: 'linear', label: 'Smooth' }, { value: 'nearest', label: 'Pixelated' }]}
                                onChange={(value) => change({ filter: value === 'linear' ? undefined : value })} />
                        </Row>
                    </Section>
                    <Section title="Before and after">
                        {readError ? <p className="text-2xs text-amber-400">{readError}</p> : !picture ? (
                            <div className="flex h-6 items-center gap-2 text-2xs text-ink-3"><Spinner /> Reading the picture…</div>
                        ) : (
                            <div className="grid grid-cols-2 gap-2">
                                <figure className="space-y-1">
                                    <canvas ref={before} aria-label="As imported" className="aspect-square w-full rounded border border-line bg-black object-contain [image-rendering:pixelated]" />
                                    <figcaption className="text-2xs text-ink-3">As imported: {memoryWords(wholeBytes)} uncompressed</figcaption>
                                </figure>
                                <figure className="space-y-1">
                                    <canvas ref={after} aria-label="As kept" className="aspect-square w-full rounded border border-line bg-black object-contain [image-rendering:pixelated]" />
                                    <figcaption className="text-2xs text-ink-3">
                                        {comparing ? 'Compressing…' : `As kept: ${memoryWords(keptBytes)}`} · {FORMAT_WORDS[format]}
                                    </figcaption>
                                </figure>
                            </div>
                        )}
                        {onThisDevice !== format && (
                            <p className="mt-1 text-2xs leading-snug text-ink-3">This computer's graphics card cannot take that compression, so here it is kept whole; a computer that can takes it compressed.</p>
                        )}
                        {hdr && <p className="mt-1 text-2xs leading-snug text-ink-3">Light beyond white is kept as 16-bit floating point: no compression keeps it yet.</p>}
                        {!hdr && depth === 32 && role === 'colour' && format === 'half' && (
                            <p className="mt-1 text-2xs leading-snug text-ink-3">Floating-point colour is kept as 16-bit floating point, as it holds light rather than screen colours. Pick a compression above to compress it.</p>
                        )}
                    </Section>
                </div>
                <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-3 py-2">
                    {saveError && <span className="mr-auto text-2xs text-amber-400">{saveError}</span>}
                    <Button onClick={onClose}>Cancel</Button>
                    <Button variant="primary" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
                </div>
            </div>
        </div>
    );
};
