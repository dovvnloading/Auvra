import React, { useMemo, useState, useSyncExternalStore } from 'react';
import { DownloadIcon, PlusIcon, TrashIcon } from '../../UI/Icons';
import { MATERIALS_DOMAIN, materialAssetDocument, materialLibrary, type MaterialAsset } from '../../../runtime/materials/materialLibrary';
import { createMaterialGraph } from '../../../runtime/materials/materialGraph';
import { projectService } from '../../../utils/projectService';
import { BUILT_IN_TEMPLATES, EXPORT_SOURCE_LABELS, isExportTemplatesAsset, readTemplates, type ChannelSource, type ExportSource, type ExportTemplate } from '../../../texturing/paint/exportTemplates';
import { PICTURE_FORMATS, type PictureFormat } from '../../../texturing/paint/pictureFiles';
import { Button, IconButton, Segmented } from '../../UI/kit';
import { Select } from '../../UI/Select';
import { DraftText } from '../TextureParamField';
import type { PaintSession } from './paintSession';

/**
 * Exporting a set's pictures with a template: a starting one or one kept in the project, changed here
 * (file kind, normal convention, padding, sizes, each picture's name and channels) and saved for anyone
 * working on the project.
 */

const CHANNEL_NAMES = ['Red', 'Green', 'Blue', 'Alpha'];
const SOURCES = Object.keys(EXPORT_SOURCE_LABELS) as ExportSource[];
/** A channel source as a choice in a list. */
const sourceKey = (source: ChannelSource): string => ('value' in source ? (source.value >= 0.5 ? 'white' : 'black') : `${source.from}:${source.component}`);
const sourceOf = (key: string): ChannelSource => (key === 'white' ? { value: 1 } : key === 'black' ? { value: 0 } : { from: key.split(':')[0] as ExportSource, component: Number(key.split(':')[1]) as 0 | 1 | 2 | 3 });
const SOURCE_OPTIONS = [
    ...SOURCES.flatMap((source) => (source === 'baseColor' || source === 'normal' || source === 'emissive'
        ? [0, 1, 2].map((component) => ({ value: `${source}:${component}`, label: `${EXPORT_SOURCE_LABELS[source]} ${CHANNEL_NAMES[component].toLowerCase()}` }))
        : [{ value: `${source}:0`, label: EXPORT_SOURCE_LABELS[source] }])),
    { value: 'black', label: 'Black (0)' },
    { value: 'white', label: 'White (1)' },
];

/** The asset the project keeps its export templates in, if it has one. */
const templatesAsset = (): MaterialAsset | undefined => materialLibrary.list().find((asset) => isExportTemplatesAsset(asset));

export const ExportPanel: React.FC<{ session: PaintSession; busy: boolean }> = ({ session, busy }) => {
    const library = useSyncExternalStore((listener) => materialLibrary.subscribe(listener), () => materialLibrary.version);
    const saved = useMemo(() => readTemplates(templatesAsset()?.paint?.exportTemplates), [library]); // eslint-disable-line react-hooks/exhaustive-deps
    const all = [...BUILT_IN_TEMPLATES, ...saved];
    const [templateId, setTemplateId] = useState(BUILT_IN_TEMPLATES[0].id);
    const [draft, setDraft] = useState<ExportTemplate | null>(null);
    const [convention, setConvention] = useState<'bottom' | 'top'>('top');
    const [message, setMessage] = useState<string | null>(null);
    const template = draft ?? all.find((each) => each.id === templateId) ?? BUILT_IN_TEMPLATES[0];
    const edit = (patch: Partial<ExportTemplate>) => setDraft({ ...template, ...patch });

    /** Keeps the project's templates (adding, replacing or removing one). */
    const keep = async (next: ExportTemplate[]) => {
        const current = templatesAsset();
        const asset: MaterialAsset = current
            ? { ...current, paint: { ...(current.paint ?? {}), exportTemplates: next } }
            : { id: crypto.randomUUID(), name: 'Paint export templates', graph: createMaterialGraph(), paint: { exportTemplates: next } };
        materialLibrary.upsert(asset);
        try {
            await projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id: asset.id, value: materialAssetDocument(asset) }]);
        } catch (error) {
            if (current) materialLibrary.upsert(current);
            else materialLibrary.remove(asset.id);
            throw error;
        }
    };

    const saveAs = async (name: string) => {
        const made: ExportTemplate = { ...template, id: `template:${Date.now().toString(36)}`, name: name.trim().slice(0, 60) || 'My template', builtIn: undefined };
        try {
            await keep([...saved.filter((each) => each.id !== made.id), made]);
            setDraft(null);
            setTemplateId(made.id);
            setMessage(`Saved "${made.name}" in the project.`);
        } catch (error) {
            setMessage(error instanceof Error ? error.message : 'The template could not be saved: is a project open?');
        }
    };

    const setPicture = (index: number, patch: Partial<ExportTemplate['pictures'][number]>) => edit({ pictures: template.pictures.map((picture, i) => (i === index ? { ...picture, ...patch } : picture)) });

    return (
        <section className="space-y-2">
            <div className="text-2xs font-semibold text-zinc-300">Export pictures</div>
            <div className="flex items-center gap-1.5">
                <Select value={template.id} options={all.map((each) => ({ value: each.id, label: each.builtIn ? each.name : `${each.name} (this project)` }))} onChange={(id) => { setDraft(null); setTemplateId(String(id)); }} className="min-w-0 flex-1" />
                {!template.builtIn && !draft && (
                    <IconButton label="Remove this template from the project" onClick={() => void keep(saved.filter((each) => each.id !== template.id)).then(() => setTemplateId(BUILT_IN_TEMPLATES[0].id), () => setMessage('The template could not be removed.'))}><TrashIcon size={12} /></IconButton>
                )}
            </div>
            <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-2xs text-zinc-400">File kind</span>
                <Select value={template.format} options={PICTURE_FORMATS.map((format) => ({ value: format.value, label: format.label }))} onChange={(format) => edit({ format: format as PictureFormat })} className="min-w-0 flex-1" />
            </div>
            <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-2xs text-zinc-400">Normal green</span>
                <Segmented value={template.normal} options={[{ value: 'openGl', label: 'Up (OpenGL)' }, { value: 'directX', label: 'Down (DirectX)' }]} onChange={(normal) => edit({ normal })} label="Normal green" />
            </div>
            <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-2xs text-zinc-400">UV origin</span>
                <Segmented value={convention} options={[{ value: 'top', label: 'Top left (glTF)' }, { value: 'bottom', label: 'Bottom left (FBX)' }]} onChange={setConvention} label="UV origin" />
            </div>
            <label className="flex items-center gap-1.5 text-2xs text-zinc-300">
                <input type="checkbox" className="accent-sky-500" checked={template.padding} onChange={(event) => edit({ padding: event.target.checked })} />
                Keep the padding past the islands (else black)
            </label>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-zinc-300">
                <span className="w-24 shrink-0 text-zinc-400">Sizes</span>
                {[9, 10, 11, 12].map((power) => (
                    <label key={power} className="flex items-center gap-1">
                        <input type="checkbox" className="accent-sky-500" checked={template.sizes.includes(power)} onChange={(event) => edit({ sizes: event.target.checked ? [...template.sizes, power].sort() : template.sizes.filter((size) => size !== power) })} />
                        {2 ** power}
                    </label>
                ))}
                {!template.sizes.length && <span className="text-zinc-500">(the set's own)</span>}
            </div>
            <div className="space-y-1.5">
                {template.pictures.map((picture, index) => (
                    <div key={index} className="space-y-1 rounded border border-zinc-800 bg-zinc-900/40 p-1.5">
                        <div className="flex items-center gap-1">
                            <DraftText label="Picture name" value={picture.name} maxLength={120} onCommit={(name) => setPicture(index, { name })} className="min-w-0 flex-1" />
                            <IconButton label="Remove this picture" onClick={() => edit({ pictures: template.pictures.filter((_, i) => i !== index) })}><TrashIcon size={11} /></IconButton>
                        </div>
                        <div className="grid grid-cols-2 gap-1">
                            {picture.channels.map((channel, c) => (
                                <Select key={c} value={sourceKey(channel)} options={SOURCE_OPTIONS.map((option) => ({ ...option, label: `${CHANNEL_NAMES[picture.channels.length === 1 ? 0 : c][0]}: ${option.label}` }))}
                                    onChange={(key) => setPicture(index, { channels: picture.channels.map((each, i) => (i === c ? sourceOf(String(key)) : each)) })} className="w-full" />
                            ))}
                        </div>
                        <Segmented value={String(picture.channels.length)} options={[{ value: '1', label: 'Grey' }, { value: '3', label: 'Colour' }, { value: '4', label: 'With alpha' }]}
                            onChange={(count) => setPicture(index, { channels: Array.from({ length: Number(count) }, (_, i) => picture.channels[i] ?? (i === 3 ? { value: 1 } : picture.channels[0])) })} label="Channels" />
                    </div>
                ))}
                <Button size="sm" variant="ghost" icon={<PlusIcon size={12} />} onClick={() => edit({ pictures: [...template.pictures, { name: '$set_Picture', channels: [{ from: 'roughness', component: 0 }] }] })}>Add a picture</Button>
            </div>
            <p className="text-2xs leading-snug text-zinc-500">Names take $set, $model, $tile (UDIM tile) and $size. With several sizes ticked, each goes in a folder of its own; with several tiles, their numbers go in the names.</p>
            {draft && (
                <div className="flex items-center gap-1.5">
                    <DraftText label="New template name" value="" allowEmpty placeholder="Save these settings as..." maxLength={60} onCommit={(name) => { if (name.trim()) void saveAs(name); }} className="min-w-0 flex-1" />
                    <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Undo changes</Button>
                </div>
            )}
            {message && <p className="text-2xs text-zinc-400">{message}</p>}
            <Button className="w-full justify-center" disabled={busy || !template.pictures.length} icon={<DownloadIcon size={13} />} onClick={() => void session.exportWithTemplate(template, convention === 'bottom')}>Download pictures</Button>
        </section>
    );
};
