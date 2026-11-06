import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, CrossIcon, LoopIcon, ScissorsIcon } from '../Icons';
import type { ClipRange, ModelImportSettings } from '../../../types';
import { importFailureMessage } from '../../../utils/modelLoader';
import { MAX_MODEL_TARGET_SIZE, reportSize, resolveImportSettings, suggestedImportSettings } from '../../../utils/processing/ModelTransforms';
import { frameOfTime, takeLabel } from '../../../utils/clipRanges';
import { readFileTakes } from '../../../utils/clipTakes';
import type { ModelFileReport } from '../../../utils/fbxImport/nativeImporter';
import { Button, IconButton, Section, Segmented, Spinner, TextInput } from '../kit';
import { ClipRangeEditor } from '../Properties/ClipRangeEditor';

export interface ImportChoice {
  settings: ModelImportSettings;
  /** Image files found for the ones the model names but does not hold. */
  images: File[];
  /** Use these settings for the rest of the files being imported too. */
  applyToRest: boolean;
}

interface ImportOptionsDialogProps {
  /** The file being imported, or the model being changed. */
  name: string;
  /** Reads what the file holds, with any files found beside it that say more of it. */
  inspect: (beside?: readonly File[]) => Promise<ModelFileReport | null>;
  /** The file itself, to cut clips from its takes. */
  readFile: () => Promise<File>;
  /** A model's stored settings; a new file starts from what suits it. */
  initialSettings?: ModelImportSettings;
  /** Images already kept for the model, by file name. */
  knownImages?: readonly string[];
  /** The confirm button: 'Import' for a new file, 'Apply' for an imported model. */
  confirmLabel?: string;
  /** Files still to come after this one, in a batch. */
  remaining?: number;
  onConfirm: (choice: ImportChoice) => void;
  onCancel: () => void;
}

const UNIT_NAMES: readonly [number, string][] = [
  [0.001, 'millimetres'], [0.01, 'centimetres'], [0.0254, 'inches'], [0.1, 'decimetres'], [0.3048, 'feet'], [1, 'metres'], [1000, 'kilometres'],
];

const unitName = (metres: number): string | null => {
  if (!(metres > 0)) return null;
  const known = UNIT_NAMES.find(([size]) => Math.abs(size - metres) < size * 1e-3);
  return known ? known[1] : `units of ${Number(metres.toPrecision(3))} m`;
};

const count = (value: number, one: string, many = `${one}s`): string => `${value.toLocaleString()} ${value === 1 ? one : many}`;

const metres = (value: number): string => String(value >= 100 ? Math.round(value) : value >= 0.1 ? Number(value.toFixed(2)) : Number(value.toPrecision(2)));

const sizeText = (size: readonly number[]): string => `${size.map(metres).join(' × ')} m`;

/** Where a file came from, and what it says about itself. */
const describeSource = (report: ModelFileReport): string => {
  const parts: string[] = [];
  const maker = report.application || report.creator;
  if (maker) parts.push(maker.length > 36 ? `${maker.slice(0, 35)}…` : maker);
  if (report.format === 'fbx') parts.push(`FBX ${(report.version / 1000).toFixed(1)}`);
  else if (report.format === 'obj') parts.push('OBJ');
  else parts.push('glTF');
  const unit = unitName(report.metresPerUnit);
  if (unit) parts.push(unit);
  return parts.join(' · ');
};

const clipTime = (seconds: number): string => (seconds < 10 ? `${seconds.toFixed(2)} s` : `${seconds.toFixed(1)} s`);

/** What dropping animation keys is allowed to cost. */
const KEY_CHOICES = [
  { value: 'exact', label: 'Every key', hint: 'Keeps every key the file has.', threshold: 0 },
  { value: 'light', label: 'Light', hint: 'Drops keys that change nothing you could see. Bones stay within 0.05 mm.', threshold: undefined },
  { value: 'strong', label: 'Strong', hint: 'Drops many more. Fingertips can stray by about half a centimetre.', threshold: 1e-3 },
] as const;
type KeyChoice = (typeof KEY_CHOICES)[number]['value'];

const keyChoiceOf = (threshold: number | undefined): KeyChoice => (threshold === undefined ? 'light' : threshold === 0 ? 'exact' : threshold >= 1e-3 ? 'strong' : 'light');

const DEFAULT_SMOOTHING_ANGLE = 60;

const Row: React.FC<{ label: React.ReactNode; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="flex min-h-[24px] items-center justify-between gap-3 text-xs text-ink-2" title={hint}>
    <span className="min-w-0 truncate">{label}</span>
    {children}
  </div>
);

const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <>
    <dt className="text-ink-3">{label}</dt>
    <dd className="min-w-0 truncate text-ink-2 tabular-nums">{children}</dd>
  </>
);

const Check_: React.FC<{ label: string; checked: boolean; onChange: (checked: boolean) => void }> = ({ label, checked, onChange }) => (
  <input type="checkbox" aria-label={label} checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-3.5 w-3.5 shrink-0 accent-blue-500" />
);

/** What a model file holds and how to bring it in: its size, what to keep of it, and the images it needs. */
export const ImportOptionsDialog: React.FC<ImportOptionsDialogProps> = ({ name, inspect, readFile, initialSettings, knownImages, confirmLabel = 'Import', remaining = 0, onConfirm, onCancel }) => {
  const [report, setReport] = useState<ModelFileReport | null>(null);
  const [reading, setReading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [normalize, setNormalize] = useState(initialSettings?.normalize ?? false);
  const [targetSize, setTargetSize] = useState(String(initialSettings?.targetSize ?? 2));
  const [looseMeshes, setLooseMeshes] = useState(initialSettings?.looseMeshes ?? true);
  const [morphTargets, setMorphTargets] = useState(initialSettings?.morphTargets ?? true);
  const [recomputeNormals, setRecomputeNormals] = useState(initialSettings?.recomputeNormals ?? false);
  const [smoothingAngle, setSmoothingAngle] = useState(String(initialSettings?.smoothingAngle ?? DEFAULT_SMOOTHING_ANGLE));
  const [tangents, setTangents] = useState(initialSettings?.tangents ?? true);
  const [excludedClips, setExcludedClips] = useState<ReadonlySet<string>>(() => new Set(initialSettings?.excludedClips ?? []));
  const [clipRanges, setClipRanges] = useState<readonly ClipRange[]>(initialSettings?.clipRanges ?? []);
  const [cutting, setCutting] = useState<{ take?: string; clip?: string } | null>(null);
  const [keyChoice, setKeyChoice] = useState<KeyChoice>(keyChoiceOf(initialSettings?.keyThreshold));
  const [animationOff] = useState(initialSettings?.animation === false);
  const [showMore, setShowMore] = useState(false);
  const [offered, setOffered] = useState<readonly File[]>([]);
  const [materialsRead, setMaterialsRead] = useState<File | null>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  // The settings the file should start with come from what it holds, unless the model has its own.
  useEffect(() => {
    let current = true;
    setReading(true);
    inspect().catch((error: unknown) => {
      if (current) setReadError(importFailureMessage('This file cannot be imported', error));
      return null;
    }).then((read) => {
      if (!current) return;
      setReport(read);
      setReading(false);
      if (initialSettings) return;
      const suggested = suggestedImportSettings(read);
      setNormalize(suggested.settings.normalize);
      setTargetSize(String(suggested.settings.targetSize));
      setLooseMeshes(suggested.settings.looseMeshes ?? true);
      setNote(suggested.note ?? null);
    });
    return () => { current = false; };
    // Read once for the file the dialog opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // The cutting window answers Escape for itself while it is open.
    if (cutting) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    // In the capture phase: the dialog keeps keys typed in it from reaching the editor's shortcuts.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cutting, onCancel]);

  const size = Number(targetSize);
  const sizeValid = Number.isFinite(size) && size > 0 && size <= MAX_MODEL_TARGET_SIZE;
  const angle = Number(smoothingAngle);
  const angleValid = Number.isFinite(angle) && angle > 0 && angle <= 180;
  const hasLoose = (report?.looseMeshes?.length ?? 0) > 0;
  const clips = report?.clips ?? [];
  const holdsNothing = !!report && report.triangles === 0 && clips.length === 0;
  const canConfirm = !reading && !readError && !holdsNothing && (!normalize || sizeValid) && (!recomputeNormals || angleValid);
  // A file with one take can have been saved with it under another name; ranges go with it.
  const rangesFor = (take: string): readonly ClipRange[] => clipRanges.filter((range) => !range.attached && (range.take === take || (clips.length === 1 && !clips.some((clip) => clip.name === range.take))));
  const otherRanges = clipRanges.filter((range) => !clips.some((clip) => rangesFor(clip.name).includes(range)));
  const missingImages = useMemo(() => (report?.images ?? []).filter((image) => !image.embedded), [report]);
  /** Of what was picked, what the file asks for. A folder can hold much else, and more can be asked for once a material file is read. */
  const found = useMemo(() => {
    const byName = new Map(offered.map((file) => [file.name.toLowerCase(), file]));
    const wanted = new Map<string, File>();
    for (const image of missingImages) {
      const file = byName.get(image.file.toLowerCase());
      if (file) wanted.set(image.file.toLowerCase(), file);
    }
    return wanted;
  }, [offered, missingImages]);

  // An OBJ's material file holds its materials and names their images: with it found, there is more to say.
  const materialFile = report?.materialFile ? found.get(report.materialFile.toLowerCase()) : undefined;
  useEffect(() => {
    if (!materialFile) return;
    let current = true;
    inspect([materialFile]).then((read) => {
      if (!current || !read) return;
      setMaterialsRead(materialFile);
      setReport(read);
    }).catch(() => undefined);
    return () => { current = false; };
    // Read once for each material file found.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialFile]);
  const canTune = report?.format === 'fbx' || report?.format === 'obj';

  /** The model's size as it will come in. */
  const fileSize = report ? reportSize(report, looseMeshes) : null;
  const resultSize = useMemo(() => {
    if (!fileSize) return null;
    if (!normalize) return fileSize;
    const largest = Math.max(...fileSize);
    return largest > 0 && sizeValid ? fileSize.map((side) => side * (size / largest)) : null;
  }, [fileSize, normalize, size, sizeValid]);

  const takeImages = (list: FileList | null) => {
    if (!list?.length || !report) return;
    // Copied now: clearing the input to let the same file be picked again empties its list.
    const files = Array.from(list);
    setOffered((previous) => [...previous, ...files]);
  };

  const choose = (applyToRest: boolean) => {
    if (!canConfirm) return;
    const keptClips = clips.length - clips.filter((clip) => excludedClips.has(clip.name)).length + clipRanges.length;
    const threshold = KEY_CHOICES.find((choice) => choice.value === keyChoice)?.threshold;
    onConfirm({
      settings: resolveImportSettings({
        normalize,
        targetSize: sizeValid ? size : initialSettings?.targetSize,
        ...(hasLoose ? { looseMeshes } : {}),
        ...(canTune && (report?.blendShapes ?? 0) > 0 && !morphTargets ? { morphTargets: false } : {}),
        ...(canTune && recomputeNormals ? { recomputeNormals: true, smoothingAngle: angle } : {}),
        ...(canTune && !tangents ? { tangents: false } : {}),
        // Left as it was when the clips were not offered.
        ...(animationOff ? { animation: false } : {}),
        ...(clips.length > 0 && keptClips === 0 ? { animation: false } : {}),
        ...(excludedClips.size && keptClips > 0 ? { excludedClips: [...excludedClips] } : {}),
        ...(clipRanges.length ? { clipRanges: [...clipRanges] } : {}),
        ...(canTune && threshold !== undefined ? { keyThreshold: threshold } : {}),
      }),
      images: [...(materialsRead ? [materialsRead] : []), ...found.values()],
      applyToRest,
    });
  };

  const missingNames = missingImages.filter((image) => !knownImages?.some((known) => known.toLowerCase() === image.file.toLowerCase()));
  const stillMissing = missingNames.filter((image) => !found.has(image.file.toLowerCase())).length;
  const wholeCount = clips.length - clips.filter((clip) => excludedClips.has(clip.name)).length;
  const framesPerSecond = report?.framesPerSecond || 30;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Import options"
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <form
        className="flex max-h-full w-[480px] max-w-full flex-col overflow-hidden rounded-lg border border-line bg-ground shadow-[0_8px_32px_rgb(0_0_0/0.6)]"
        onSubmit={(event) => { event.preventDefault(); choose(false); }}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-3 py-2">
          <div className="min-w-0">
            <h2 className="text-xs font-semibold text-ink">{confirmLabel === 'Import' ? 'Import model' : 'Import settings'}</h2>
            <p className="truncate text-2xs text-ink-3" title={name}>{name}</p>
          </div>
          <IconButton label="Cancel" onClick={onCancel}><CrossIcon size={14} /></IconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Section>
            {reading && (
              <div className="flex h-6 items-center gap-2 text-xs text-ink-3"><Spinner /> Reading the file…</div>
            )}
            {!reading && !report && (
              <p className={`text-xs ${readError ? 'text-amber-400' : 'text-ink-3'}`}>{readError ?? 'This file could not be read ahead of importing. Importing it will say why.'}</p>
            )}
            {!reading && report && (
              <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-0.5 text-2xs">
                <Fact label="Source">{describeSource(report)}</Fact>
                {report.upAxis && report.upAxis !== '+Y' && <Fact label="Upright">Made {report.upAxis[1]} up, stood up on import</Fact>}
                {fileSize && normalize && <Fact label="In the file">{sizeText(fileSize)}</Fact>}
                <Fact label="Geometry">
                  {report.triangles > 0 ? `${count(report.meshes, 'mesh', 'meshes')}, ${count(report.triangles, 'triangle')}` : clips.length > 0 ? 'None: animation only' : 'None'}
                </Fact>
                {report.materials > 0 && <Fact label="Materials">{count(report.materials, 'material')}{report.images?.length ? `, ${count(report.images.length, 'image')}` : ''}</Fact>}
                {report.collisionMeshes > 0 && <Fact label="Collision">{count(report.collisionMeshes, 'shape')}, for colliders and rigid bodies</Fact>}
                {report.sockets > 0 && <Fact label="Sockets">{count(report.sockets, 'socket')}, added to the model</Fact>}
                {report.lodGroups > 0 && <Fact label="Detail">{count(report.lodGroups, 'detail group')}: the finest of each is kept, and simpler levels made from it</Fact>}
                {report.bones > 0 && (
                  <Fact label="Skeleton">
                    {count(report.bones, 'bone')}{report.maxInfluences > 4 ? `, up to ${report.maxInfluences} per vertex (the strongest 4 are kept)` : ''}
                  </Fact>
                )}
              </dl>
            )}
            {holdsNothing && <p className="mt-1 text-xs text-amber-400">This file holds no meshes and no animation, so there is nothing to import.</p>}
            {report?.warnings?.slice(0, 4).map((warning) => (
              <p key={warning} className="mt-1 text-2xs text-amber-400">{warning}</p>
            ))}
          </Section>

          <Section>
            <Row label="Size">
              <Segmented
                label="Size"
                value={normalize ? 'fit' : 'authored'}
                onChange={(value) => { setNormalize(value === 'fit'); setNote(null); }}
                options={[
                  { value: 'authored', label: 'As in the file', hint: 'Keeps the size and pivot the file says it has, in metres.' },
                  { value: 'fit', label: 'Fit to a size', hint: 'Scales it so its largest side is this long, centred and resting on the floor.' },
                ]}
              />
            </Row>
            {normalize && (
              <Row label="Largest side">
                <span className="flex items-center gap-1.5">
                  <TextInput
                    type="number"
                    aria-label="Target size"
                    min={0.001}
                    max={MAX_MODEL_TARGET_SIZE}
                    step="any"
                    value={targetSize}
                    onChange={(event) => { setTargetSize(event.target.value); setNote(null); }}
                    className="!w-20 text-right tabular-nums"
                  />
                  <span className="text-2xs text-ink-3">m</span>
                </span>
              </Row>
            )}
            {normalize && !sizeValid && <p className="mt-1 text-2xs text-amber-400">Enter a size above 0 and up to {MAX_MODEL_TARGET_SIZE.toLocaleString()} m.</p>}
            {note && <p className="mt-1 text-2xs text-ink-2">{note}</p>}
            {resultSize && <p className="mt-1 text-2xs text-ink-3 tabular-nums">Comes in at {sizeText(resultSize)}</p>}
          </Section>

          {canTune && (hasLoose || (report?.blendShapes ?? 0) > 0) && (
            <Section title="Keep">
              {hasLoose && (
                <Row
                  label={`${report!.looseMeshes.length === 1 ? report!.looseMeshes[0].name : count(report!.looseMeshes.length, 'mesh', 'meshes')} (${count(report!.looseMeshes.reduce((sum, mesh) => sum + mesh.triangles, 0), 'triangle')}), outside the skeleton`}
                  hint="A mesh the skeleton does not move. Some exporters leave stray ones in a rigged file."
                >
                  <Check_ label="Keep meshes outside the skeleton" checked={looseMeshes} onChange={setLooseMeshes} />
                </Row>
              )}
              {(report?.blendShapes ?? 0) > 0 && (
                <Row label={count(report!.blendShapes, 'blend shape')}>
                  <Check_ label="Keep blend shapes" checked={morphTargets} onChange={setMorphTargets} />
                </Row>
              )}
            </Section>
          )}

          {clips.length > 0 && !animationOff && (
            <Section
              title={clipRanges.length ? `Animation: ${count(wholeCount + clipRanges.length, 'clip')} from ${count(clips.length, 'take')}` : `Animation: ${wholeCount} of ${count(clips.length, 'clip')}`}
              actions={clips.length > 1 ? (
                <span className="flex items-center gap-0.5">
                  <Button size="sm" variant="ghost" onClick={() => setExcludedClips((previous) => new Set([...previous].filter((name) => !clips.some((clip) => clip.name === name))))}>All</Button>
                  <Button size="sm" variant="ghost" onClick={() => setExcludedClips((previous) => new Set([...previous, ...clips.map((clip) => clip.name)]))}>None</Button>
                </span>
              ) : undefined}
            >
              <div className="max-h-44 overflow-y-auto">
                {clips.map((clip) => (
                  <React.Fragment key={clip.name}>
                    <div className="flex h-6 items-center gap-1 text-xs text-ink-2">
                      <label className="flex min-w-0 flex-1 items-center gap-2" title={clip.name}>
                        <Check_
                          label={`Import ${takeLabel(clip.name)}`}
                          checked={!excludedClips.has(clip.name)}
                          onChange={(checked) => setExcludedClips((previous) => {
                            const next = new Set(previous);
                            if (checked) next.delete(clip.name); else next.add(clip.name);
                            return next;
                          })}
                        />
                        <span className="min-w-0 flex-1 truncate">{takeLabel(clip.name)}</span>
                        <span className="shrink-0 text-2xs text-ink-3 tabular-nums">{clipTime(clip.duration)}</span>
                      </label>
                      {clip.duration > 0
                        ? <IconButton label={`Cut ${takeLabel(clip.name)} into clips`} onClick={() => setCutting({ take: clip.name })}><ScissorsIcon size={12} /></IconButton>
                        : <span className="w-6 shrink-0" />}
                    </div>
                    {rangesFor(clip.name).map((range) => (
                      <button
                        key={range.name}
                        type="button"
                        title={range.loop ? `${range.name}: loops` : `${range.name}: plays once`}
                        onClick={() => setCutting({ take: clip.name, clip: range.name })}
                        className="flex h-5 w-full items-center gap-2 rounded pl-[22px] pr-7 text-left text-2xs text-ink-2 hover:bg-white/5"
                      >
                        <span className="min-w-0 flex-1 truncate">{takeLabel(range.name)}</span>
                        {range.loop && <LoopIcon size={10} className="shrink-0 text-ink-3" />}
                        <span className="shrink-0 text-ink-3 tabular-nums">
                          {frameOfTime(range.start, clip.start, framesPerSecond)}–{frameOfTime(range.end, clip.start, framesPerSecond)}
                        </span>
                      </button>
                    ))}
                  </React.Fragment>
                ))}
              </div>
              {otherRanges.length > 0 && (
                <p className="mt-1 text-2xs text-ink-3">{count(otherRanges.length, 'clip')} cut from takes not in this file: {otherRanges.map((range) => range.name).join(', ')}.</p>
              )}
              {canTune && (
                <div className="mt-1">
                  <Row label="Reduce keys">
                    <Segmented label="Reduce animation keys" value={keyChoice} onChange={setKeyChoice} options={KEY_CHOICES} />
                  </Row>
                </div>
              )}
            </Section>
          )}

          {missingNames.length > 0 && (
            <Section
              title={report?.format === 'obj'
                ? (stillMissing ? `Files beside the model: ${stillMissing}` : 'Files found')
                : (stillMissing ? `Images not in the file: ${stillMissing}` : 'Images found')}
              actions={(
                <span className="flex items-center gap-0.5">
                  <Button size="sm" onClick={() => filesRef.current?.click()}>{report?.format === 'obj' ? 'Find files…' : 'Find images…'}</Button>
                  <Button size="sm" variant="ghost" onClick={() => folderRef.current?.click()}>Folder…</Button>
                </span>
              )}
            >
              <ul className="max-h-24 overflow-y-auto">
                {missingNames.map((image) => {
                  const located = found.has(image.file.toLowerCase());
                  return (
                    <li key={image.file} className="flex h-5 items-center gap-1.5 text-2xs">
                      <span className="flex w-3 shrink-0 justify-center">{located && <CheckIcon size={12} className="text-accent" />}</span>
                      <span className={`min-w-0 truncate ${located ? 'text-ink-2' : 'text-ink-3'}`} title={image.file}>{image.file}</span>
                    </li>
                  );
                })}
              </ul>
              {stillMissing > 0 && <p className="mt-1 text-2xs text-ink-3">The model imports without them if they are not found.</p>}
              <input ref={filesRef} type="file" multiple accept="image/*,.tga,.tif,.tiff,.mtl" className="hidden" aria-hidden="true" tabIndex={-1} onChange={(event) => { takeImages(event.target.files); event.target.value = ''; }} />
              <input
                ref={folderRef}
                type="file"
                className="hidden"
                aria-hidden="true"
                tabIndex={-1}
                onChange={(event) => { takeImages(event.target.files); event.target.value = ''; }}
                {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
              />
            </Section>
          )}

          {canTune && (report?.triangles ?? 0) > 0 && (
            <Section>
              <button type="button" className="h-5 text-2xs text-ink-3 hover:text-ink-2" aria-expanded={showMore} onClick={() => setShowMore((open) => !open)}>
                {showMore ? 'Fewer options' : 'More options'}
              </button>
              {showMore && (
                <div className="mt-1">
                  <Row label="Normals" hint="The file's normals, or normals worked out from the faces.">
                    <Segmented
                      label="Normals"
                      value={recomputeNormals ? 'compute' : 'file'}
                      onChange={(value) => setRecomputeNormals(value === 'compute')}
                      options={[{ value: 'file', label: 'From the file' }, { value: 'compute', label: 'Work out' }]}
                    />
                  </Row>
                  {recomputeNormals && (
                    <Row label="Keep edges sharper than" hint="Where faces meet at more than this angle, the edge stays hard.">
                      <span className="flex items-center gap-1.5">
                        <TextInput type="number" aria-label="Smoothing angle" min={1} max={180} step={1} value={smoothingAngle} onChange={(event) => setSmoothingAngle(event.target.value)} className="!w-16 text-right tabular-nums" />
                        <span className="text-2xs text-ink-3">°</span>
                      </span>
                    </Row>
                  )}
                  <Row label="Tangents for normal maps" hint="Tangents worked out the standard way normal maps are baked against. Without them, the shader estimates them.">
                    <Check_ label="Generate tangents" checked={tangents} onChange={setTangents} />
                  </Row>
                </div>
              )}
            </Section>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-3 py-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          {remaining > 0 && <Button disabled={!canConfirm} onClick={() => choose(true)}>Import all {remaining + 1}</Button>}
          <Button type="submit" variant="primary" disabled={!canConfirm}>{confirmLabel}</Button>
        </div>
      </form>
      {cutting && (
        <ClipRangeEditor
          name={name}
          load={async (signal) => readFileTakes(await readFile(), {
            ...(hasLoose ? { looseMeshes } : {}),
            ...(!morphTargets ? { morphTargets: false } : {}),
            keyThreshold: KEY_CHOICES.find((choice) => choice.value === keyChoice)?.threshold,
          }, signal)}
          ranges={clipRanges}
          excludedClips={[...excludedClips]}
          initialTake={cutting.take}
          initialClip={cutting.clip}
          confirmLabel="Done"
          onConfirm={(result) => {
            setClipRanges(result.clipRanges);
            setExcludedClips(new Set(result.excludedClips));
            setCutting(null);
          }}
          onCancel={() => setCutting(null)}
        />
      )}
    </div>
  );
};

export default ImportOptionsDialog;
