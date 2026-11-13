import React, { useImperativeHandle, useRef, useState } from 'react';
import { ExternalLinkIcon } from '../UI/Icons';
import { IconButton, Popover } from '../UI/kit';
import { useAssets } from '../../context/AssetContext';
import { useNotification } from '../../context/NotificationContext';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { OUTPUT_NODE_TYPE, getMaterialNodeDefinition } from '../../runtime/materials/materialGraph';
import { MATERIALS_DOMAIN, materialAssetDocument, materialLibrary, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { materialFromMaterialX, materialToMaterialX, materialXPictures, type MaterialXSurface } from '../../texturing/materialX';
import { readMaterialXZip } from '../../texturing/materialXZip';
import { download, makeZip } from '../../texturing/zip';
import { projectService } from '../../utils/projectService';

/**
 * MaterialX in the Materials tab: a material written out as a .mtlx file with its pictures (one .zip), and a
 * .mtlx file read in as a new material with the pictures picked with it (texturing/materialX.ts).
 */

/** An input's name as the Material Output shows it. */
const inputWords = (key: string): string => getMaterialNodeDefinition(OUTPUT_NODE_TYPE)?.inputs.find(input => input.key === key)?.label.toLowerCase() ?? key;
const listWords = (items: readonly string[]): string => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

const SURFACES: ReadonlyArray<{ value: MaterialXSurface; title: string; text: string }> = [
    { value: 'standard_surface', title: 'Standard Surface', text: 'Read by most tools and MaterialX viewers.' },
    { value: 'open_pbr_surface', title: 'OpenPBR', text: 'The newer open surface, for tools that take it.' },
];

/** Writes the material as MaterialX with its pictures, as one .zip. */
export const MaterialXExportButton: React.FC<{ asset: MaterialAsset }> = ({ asset }) => {
    const { textures } = useAssets();
    const { addNotification } = useNotification();
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const write = async (surface: MaterialXSurface) => {
        setOpen(false);
        try {
            const current = materialLibrary.get(asset.id) ?? asset;
            const fileOf = (textureId: string): string | null => {
                const texture = textures.find(candidate => candidate.id === textureId);
                if (!texture) return null;
                return /\.[A-Za-z0-9]{2,5}$/.test(texture.name) ? texture.name : `${texture.name}.png`;
            };
            const exported = materialToMaterialX(current, surface, fileOf);
            const stem = current.name.replace(/[^\w .-]+/g, '_').trim() || 'material';
            const files: Array<{ name: string; data: Blob | Uint8Array }> = [{ name: `${stem}.mtlx`, data: new TextEncoder().encode(exported.document) }];
            for (const picture of exported.textures) {
                const texture = textures.find(candidate => candidate.id === picture.textureId)!;
                files.push({ name: picture.path, data: await (await fetch(texture.sourceUrl ?? texture.url)).blob() });
            }
            download(await makeZip(files), `${stem} (MaterialX).zip`);
            addNotification(exported.leftOut.length
                ? { message: `"${current.name}" is written as MaterialX. Its ${listWords(exported.leftOut.map(inputWords))} ${exported.leftOut.length === 1 ? 'is' : 'are'} worked out by the graph, so ${exported.leftOut.length === 1 ? 'it is' : 'they are'} written as set on the material.`, type: 'info' }
                : { message: `"${current.name}" is written as MaterialX, with its pictures.`, type: 'success' });
        } catch (failure) {
            frontendDiagnostics.failure('materialx_export_failed', failure);
            addNotification({ message: `"${asset.name}" could not be written as MaterialX.`, type: 'error' });
        }
    };
    return (
        <>
            <IconButton ref={anchor} label="Export as MaterialX, with its pictures" onClick={() => setOpen(true)}><ExternalLinkIcon size={14} /></IconButton>
            <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={260} label="Export as MaterialX">
                <div className="p-1">
                    {SURFACES.map(option => (
                        <button key={option.value} type="button" onClick={() => void write(option.value)} className="flex w-full flex-col rounded px-2 py-1.5 text-left hover:bg-white/5">
                            <span className="text-xs text-ink">{option.title}</span>
                            <span className="text-2xs leading-snug text-ink-3">{option.text}</span>
                        </button>
                    ))}
                </div>
            </Popover>
        </>
    );
};

export interface MaterialXImportHandle { pick(): void }

const fileName = (path: string): string => path.split(/[\\/]/).pop()!.toLowerCase();

/**
 * A hidden file picker reading either one MaterialX ZIP with its pictures or a
 * .mtlx document and manually selected pictures into a new project material.
 * `pick` opens it.
 */
export const MaterialXImport = React.forwardRef<MaterialXImportHandle, { onImported: (asset: MaterialAsset) => void }>(({ onImported }, ref) => {
    const input = useRef<HTMLInputElement>(null);
    const { addTexture } = useAssets();
    const { addNotification } = useNotification();
    useImperativeHandle(ref, () => ({ pick: () => input.current?.click() }), []);

    const read = async (files: File[]) => {
        const archive = files.find(file => /\.zip$/i.test(file.name));
        const document = files.find(file => /\.mtlx$/i.test(file.name));
        if (archive && files.length !== 1) {
            addNotification({ message: 'Choose one MaterialX ZIP, or pick a .mtlx file together with its pictures.', type: 'error' });
            return;
        }
        if (!archive && !document) {
            addNotification({ message: 'Pick a MaterialX .zip, or a .mtlx file together with the pictures it reads.', type: 'error' });
            return;
        }
        try {
            projectService.assertWritable();
            // Read all referenced archive members and verify their CRC before
            // uploading anything, keeping standalone .mtlx selection unchanged.
            const packed = archive ? await readMaterialXZip(archive) : null;
            const xml = packed?.xml ?? await document!.text();
            const wanted = materialXPictures(xml);
            const pictures = packed ? new Map(packed.pictures.map(({ path, file }) => [path, file])) : null;
            const ids = new Map<string, string>();
            const missing: string[] = [...(packed?.missing ?? [])];
            for (const picture of wanted) {
                const file = pictures ? pictures.get(picture.path)
                    : files.find(candidate => candidate.name.toLowerCase() === fileName(picture.path));
                const id = file ? await addTexture(file) : null;
                if (id) ids.set(picture.path, id);
                else if (!missing.includes(picture.path)) missing.push(picture.path);
            }
            const sourceName = packed?.documentName.split('/').pop() ?? document!.name;
            const { asset, leftOut } = materialFromMaterialX(xml, (path) => ids.get(path) ?? null, crypto.randomUUID(), sourceName.replace(/\.mtlx$/i, ''));
            await projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id: asset.id, value: materialAssetDocument(asset) }]);
            materialLibrary.upsert(asset);
            onImported(asset);
            const notes = [
                missing.length ? `${listWords(missing)} ${missing.length === 1 ? 'was' : 'were'} not picked with it` : '',
                leftOut.length ? `its ${listWords(leftOut.map(name => name.replace(/_/g, ' ')))} ${leftOut.length === 1 ? 'is' : 'are'} worked out in ways this editor does not read yet` : '',
            ].filter(Boolean);
            addNotification(notes.length
                ? { message: `"${asset.name}" is in this project, but ${notes.join('; ')}.`, type: 'info' }
                : { message: `"${asset.name}" is in this project, with its pictures.`, type: 'success' });
        } catch (failure) {
            frontendDiagnostics.failure('materialx_import_failed', failure);
            addNotification({ message: failure instanceof Error && /MaterialX/.test(failure.message) ? failure.message : 'The MaterialX file could not be read into this project.', type: 'error' });
        }
    };

    return (
        <input ref={input} type="file" multiple hidden aria-hidden accept=".zip,.mtlx,.png,.jpg,.jpeg,.webp,.tif,.tiff,.tga,.psd,.exr,.hdr"
            onChange={(event) => {
                const picked = Array.from(event.target.files ?? []);
                event.target.value = '';
                if (picked.length) void read(picked);
            }} />
    );
});
MaterialXImport.displayName = 'MaterialXImport';
