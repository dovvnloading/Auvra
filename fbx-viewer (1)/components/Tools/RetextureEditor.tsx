
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Box, Check, ChevronsLeftRight, Columns2, Grid3x3, Maximize, Palette, Plus, RotateCw, Save, Trash2, X } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { useNotification } from '../../context/NotificationContext';
import type { ProviderModel } from '../../services/HostProviderService';
import { materialLibrary } from '../../runtime/materials/materialLibrary';
import { estimateJobCost, formatCost } from '../../services/providerPricing';
import { AiRouteBar } from '../Settings/AiRouteBar';
import { Button, IconButton, PanelEdge, PanelTitle, Section, Segmented, Spinner, TextArea, Tooltip, usePanelWidth } from '../UI/kit';
import { AssetRail } from './Retexture/AssetRail';
import { RetextureStage, type StageLighting } from './Retexture/RetextureStage';
import { capabilityOfMode, retextureSessions, startingLookName, useRetextureSessions, type RetextureMode, type SessionPart, type SurfaceRole, type Take } from './Retexture/retextureSession';
import { STATE_WORDS, TakesStrip } from './Retexture/TakesStrip';

const SURFACE_WORDS: Record<SurfaceRole, string> = { normal: 'Normal', roughness: 'Roughness', metalness: 'Metal' };

const COUNTS = [{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '4', label: '4' }] as const;

const LIGHTING_OPTIONS: readonly { value: StageLighting; label: string; hint: string }[] = [
  { value: 'studio', label: 'Studio', hint: 'Three lights, as a product shot' },
  { value: 'daylight', label: 'Daylight', hint: 'One sun and a bright sky' },
  { value: 'flat', label: 'Flat', hint: 'Even light, for judging colour' },
];

const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable));
};

/** One remembered text between visits to the tab. */
let draftPrompt = '';
let lastModelId: string | null = null;
let lastProjectId: string | null | undefined;

export const RetextureEditor: React.FC = () => {
  const { models, selectedModelId: sceneModelId, setModelTextureOverrides, updateModelMaterialOverrides, adoptHostTexture, projectStatus, isLoading } = useScene();
  const { addNotification } = useNotification();
  const sessions = useRetextureSessions();

  const left = usePanelWidth('retexture.assets', 216, 170, 360);
  const right = usePanelWidth('retexture.inspector', 272, 232, 420);

  // A project's previews go with it.
  useEffect(() => {
    if (lastProjectId !== undefined && lastProjectId !== projectStatus.projectId) sessions.reset();
    lastProjectId = projectStatus.projectId;
  }, [projectStatus.projectId, sessions]);

  useEffect(() => {
    sessions.onTextureKept = (id, name, dimensions) => adoptHostTexture(id, name, id, dimensions);
  }, [adoptHostTexture, sessions]);

  const paintable = useMemo(() => models.filter((model) => model.category !== 'Animation'), [models]);
  const [modelId, setModelId] = useState<string | null>(() => lastModelId ?? sceneModelId ?? null);
  const model = paintable.find((item) => item.id === modelId) ?? paintable[0] ?? null;
  useEffect(() => { lastModelId = model?.id ?? null; }, [model?.id]);

  const session = useMemo(() => (model ? sessions.open(model.id, model.name, model.object, model.textureOverrides, model.materialOverrides) : null),
    // Only a different model or a newly loaded one starts a session; saving changes the overrides and is not that.
    [model?.id, model?.object, sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!session) return undefined;
    sessions.attach(session);
    return () => sessions.detach(session);
  }, [session, sessions]);

  const part = session?.parts.find((item) => item.id === session.activePartId) ?? null;
  const worn = part?.takes.find((take) => take.id === part.worn) ?? null;

  // The result being looked at: what is on the model, or one that has not got that far.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  useEffect(() => { setFocusedId(part?.worn ?? null); }, [part?.id, part?.worn]);
  const focused = part?.takes.find((take) => take.id === focusedId) ?? null;

  const [prompt, setPromptState] = useState(draftPrompt);
  const setPrompt = (value: string) => { draftPrompt = value; setPromptState(value); };
  // A texture is always worked from. Painting from words alone is for what has none to work from.
  const [scope, setScope] = useState<'part' | 'all'>('part');
  const [blankWay, setBlankWay] = useState<'new' | 'whole'>('new');
  const texturedParts = useMemo(() => session?.parts.filter((item) => item.texture) ?? [], [session]);
  const wholeAllowed = texturedParts.length === 0;
  const mode: RetextureMode = part && !part.texture ? (blankWay === 'whole' && wholeAllowed ? 'whole' : 'new') : 'restyle';
  const everyPart = mode === 'restyle' && scope === 'all' && texturedParts.length > 1;
  const [routeModel, setRouteModel] = useState<ProviderModel | null>(null);
  const [count, setCount] = useState<'1' | '2' | '4'>('1');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [lighting, setLighting] = useState<StageLighting>('studio');
  const [floor, setFloor] = useState(true);
  const [turntable, setTurntable] = useState(false);
  const [frameSignal, setFrameSignal] = useState(0);
  const [glowPart, setGlowPart] = useState<SessionPart | null>(null);

  // Before and after, either side of a line dragged across the model.
  const [compareOn, setCompareOn] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [wornReady, setWornReady] = useState(false);
  useEffect(() => {
    let current = true;
    setWornReady(false);
    if (session && worn) void sessions.textureOf(session, worn).then((texture) => { if (current) setWornReady(Boolean(texture)); });
    return () => { current = false; };
  }, [session, sessions, worn]);
  const canCompare = Boolean(part && worn && wornReady);
  const comparison = useMemo(() => (compareOn && canCompare && part && session ? sessions.comparison(session, part) : null), [canCompare, compareOn, part, session, sessions]);
  useEffect(() => () => comparison?.end(), [comparison]);
  const compare = useMemo(() => (comparison ? { split, drawBefore: comparison.drawBefore, drawAfter: comparison.drawAfter } : null), [comparison, split]);
  const stage = useRef<HTMLDivElement>(null);

  const startSplitDrag = (event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const box = stage.current?.getBoundingClientRect();
      if (box) setSplit(Math.max(0.02, Math.min(0.98, (next.clientX - box.left) / box.width)));
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  // Painting from nothing goes through the object wherever its map is laid out over it, as a change to a map does.
  const onObject = Boolean(session && part && mode === 'new' && sessions.paintsOnObject(session, part));
  const cost = part ? sessions.estimate({ mode, model: routeModel }, onObject || mode === 'restyle') : null;
  const runs = everyPart ? texturedParts.length : Number(count);
  const canGenerate = Boolean(session && part && routeModel && prompt.trim());

  const generate = useCallback(async () => {
    if (!session || !part || !routeModel || !prompt.trim()) return;
    setMessage(null);
    try {
      for (const target of everyPart ? texturedParts : [part]) {
        await sessions.generate(session, target, { mode, prompt: prompt.trim(), model: routeModel, count: everyPart ? 1 : runs });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The texture could not be started.');
    }
  }, [everyPart, mode, part, prompt, routeModel, runs, session, sessions, texturedParts]);

  const pickTake = useCallback((take: Take | null) => {
    if (!session || !part) return;
    setMessage(null);
    setFocusedId(take?.id ?? null);
    if (!take || take.state === 'ready') sessions.wear(session, part, take?.id ?? null);
  }, [part, session, sessions]);

  const act = async (work: () => Promise<void>, failure: string) => {
    setBusy(true); setMessage(null);
    try { await work(); } catch (error) { setMessage(error instanceof Error ? error.message : failure); } finally { setBusy(false); }
  };

  const saveOnModel = (take: Take | null) => {
    if (!session || !part || !model) return;
    void act(async () => {
      await sessions.saveOnModel(session, part, take, { overrides: model.textureOverrides, materials: model.materialOverrides }, (overrides) => setModelTextureOverrides(model.id, overrides), (overrides) => updateModelMaterialOverrides(model.id, overrides));
      addNotification({ message: take ? `${part.name} now wears result ${take.number}.` : `${part.name} is back to what it wore.`, type: 'info' });
    }, 'This could not be saved on the model.');
  };

  const keepInLibrary = (take: Take) => {
    if (!session || !part) return;
    void act(async () => {
      await sessions.keep(session, part, take);
      addNotification({ message: `Result ${take.number} is in the texture library.`, type: 'info' });
    }, 'This could not be saved to the library.');
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void generate();
        return;
      }
      if (isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (!part) return;
        const order = [null, ...part.takes.filter((take) => take.state === 'ready')];
        const at = order.findIndex((take) => (take?.id ?? null) === (focused?.id ?? null));
        const next = order[at + (event.key === 'ArrowRight' ? 1 : -1)];
        if (next !== undefined) { event.preventDefault(); pickTake(next); }
      } else if (event.key.toLowerCase() === 'b') {
        setCompareOn((value) => !value);
      } else if (event.key.toLowerCase() === 'f') {
        setFrameSignal((value) => value + 1);
      } else if (event.key.toLowerCase() === 't') {
        setTurntable((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused?.id, generate, part, pickTake]);

  // A material graph decides how a part looks, whatever texture is on it.
  const shadingId = part?.materialNames.map((name) => model?.materialOverrides?.[name]?.materialId).find(Boolean);
  const shadingName = shadingId ? materialLibrary.list().find((asset) => asset.id === shadingId)?.name ?? 'A material' : null;

  const takeMaterialOff = () => {
    if (!session || !part || !model) return;
    void act(async () => {
      const overrides = { ...(model.materialOverrides ?? {}) };
      for (const name of part.materialNames) {
        if (!overrides[name]) continue;
        const { materialId: _material, parameters: _parameters, ...others } = overrides[name];
        if (Object.keys(others).length) overrides[name] = others;
        else delete overrides[name];
      }
      await updateModelMaterialOverrides(model.id, overrides);
      // Taking the material off puts the part back as it was imported.
      sessions.wear(session, part, part.worn, false);
    }, 'The material could not be taken off.');
  };

  useEffect(() => { void sessions.chooseCapableModel(); }, [sessions]);

  const [mapsModel, setMapsModel] = useState<ProviderModel | null>(null);
  useEffect(() => { void sessions.mapsModel().then(setMapsModel); }, [sessions]);
  const mapsCost = mapsModel ? estimateJobCost(mapsModel, session && part ? sessions.mapsMegapixels(session, part, focused?.size) : undefined) : null;

  const failed = focused?.state === 'failed' ? focused : null;
  const shownError = message ?? failed?.error ?? null;
  const shownPicture = focused?.state === 'ready' && focused.url ? focused.url : part && session ? sessions.previewOf(session, part) : null;
  const shownSize = focused?.state === 'ready' ? focused.size ?? part?.size : part?.size;
  const placeholder = mode === 'restyle'
    ? 'How should it change? For example: faded blue denim, worn at the knees'
    : mode === 'whole'
      ? 'What should the whole model look like? For example: battered army green steel with worn edges'
      : onObject
        ? 'What should it be? For example: battered army green steel with worn edges'
        : 'What should it be? For example: polished walnut';

  return (
    <div className="flex h-full w-full overflow-hidden bg-ground text-ink">
      <aside style={{ width: left.width }} className="flex shrink-0 flex-col bg-panel">
        <PanelTitle>Models</PanelTitle>
        <AssetRail models={paintable} selectedId={model?.id ?? null} onSelect={setModelId} loading={isLoading} />
      </aside>
      <PanelEdge side="left" width={left.width} onResize={left.setWidth} onDone={left.save} label="Resize the models panel" />

      <main className="flex min-w-0 flex-1 flex-col gap-px">
        <div ref={stage} className="relative min-h-0 flex-1 overflow-hidden">
          {model && session ? (
            <>
              <RetextureStage
                modelId={model.id}
                object={model.object}
                parts={session.parts}
                glowPart={glowPart}
                onPickPart={(picked) => sessions.setActivePart(session, picked.id)}
                lighting={lighting}
                floor={floor}
                turntable={turntable}
                frameSignal={frameSignal}
                compare={compare}
              />
              <div className="pointer-events-none absolute left-3 top-2.5 flex items-center gap-1.5 text-2xs text-ink-2 [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]">
                <span>{model.name}</span>
                {part && <><span className="text-ink-3">/</span><span className="text-ink">{part.name}</span></>}
              </div>
              <div role="toolbar" aria-label="View" className="absolute right-2 top-2 flex items-center gap-0.5 rounded bg-ground/80 p-0.5">
                <IconButton label={canCompare ? 'Compare before and after' : 'Compare appears once a result is on the model'} shortcut="B" active={Boolean(compare)} disabled={!canCompare} onClick={() => setCompareOn((value) => !value)}><Columns2 size={14} /></IconButton>
                <span className="mx-0.5 h-4 w-px bg-line" />
                <Segmented label="Lighting" value={lighting} onChange={setLighting} options={LIGHTING_OPTIONS} className="!bg-transparent" />
                <span className="mx-0.5 h-4 w-px bg-line" />
                <IconButton label="Floor" active={floor} onClick={() => setFloor((value) => !value)}><Grid3x3 size={14} /></IconButton>
                <IconButton label="Turntable" shortcut="T" active={turntable} onClick={() => setTurntable((value) => !value)}><RotateCw size={14} /></IconButton>
                <IconButton label="Frame the model" shortcut="F" onClick={() => setFrameSignal((value) => value + 1)}><Maximize size={14} /></IconButton>
              </div>
              {compare && (
                <div style={{ left: `${split * 100}%` }} className="absolute inset-y-0 z-10 w-px bg-accent">
                  <span className="absolute right-2 top-10 text-2xs text-ink [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]">Before</span>
                  <span className="absolute left-2 top-10 text-2xs text-ink [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]">After</span>
                  <button
                    type="button"
                    aria-label="Drag to compare"
                    onPointerDown={startSplitDrag}
                    className="absolute left-0 top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full bg-accent text-accent-ink"
                  >
                    <ChevronsLeftRight size={13} />
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 bg-panel text-ink-3">
              <Box size={28} strokeWidth={1.25} />
              <p className="text-xs">{isLoading ? 'Loading the project' : 'Import a model to paint it.'}</p>
            </div>
          )}
        </div>

        {part && (
          <TakesStrip
            part={part}
            focusedId={focusedId}
            onFocus={pickTake}
            actions={
              focused === null ? (
                part.saved === null
                  ? <span className="flex items-center gap-1 pr-1 text-2xs text-ink-3"><Check size={12} /> On the model</span>
                  : <Button variant="primary" disabled={busy} onClick={() => saveOnModel(null)}>{startingLookName(part) === 'Original' ? 'Use original' : 'Use this'}</Button>
              ) : focused.state === 'ready' ? (
                <>
                  <IconButton label={part.saved === focused.id ? 'On the model: replace it first to remove it' : `Remove result ${focused.number}`} size="md" disabled={busy || part.saved === focused.id} onClick={() => session && void sessions.remove(session, part, focused)}><Trash2 size={14} /></IconButton>
                  <Button icon={<Save size={13} />} disabled={busy || Boolean(focused.textureId)} onClick={() => keepInLibrary(focused)}>{focused.textureId ? 'In library' : 'Save to library'}</Button>
                  {part.saved === focused.id
                    ? <span className="flex h-7 items-center gap-1 px-2 text-xs text-ink-2"><Check size={13} className="text-accent" /> On the model</span>
                    : <Button variant="primary" disabled={busy || part.materialNames.length === 0} title={part.materialNames.length === 0 ? 'This part has no material name to save under' : undefined} onClick={() => saveOnModel(focused)}>Use on model</Button>}
                </>
              ) : focused.state === 'failed' ? (
                <>
                  <IconButton label={`Remove result ${focused.number}`} size="md" onClick={() => session && void sessions.remove(session, part, focused)}><Trash2 size={14} /></IconButton>
                  <Button disabled={!canGenerate} onClick={() => { setPrompt(focused.prompt); void generate(); }}>Try again</Button>
                </>
              ) : (
                <Button icon={<X size={13} />} disabled={!focused.jobId || focused.stopping} onClick={() => void sessions.cancel(focused)}>{focused.stopping ? 'Stopping' : 'Stop'}</Button>
              )
            }
          />
        )}

        <div className="shrink-0 bg-panel">
          {shadingName && (
            <div className="flex items-center gap-2 border-b border-line bg-warn/10 px-3 py-1 text-2xs text-ink">
              <Palette size={13} className="shrink-0 text-warn" />
              <span className="min-w-0 flex-1">{shadingName} shades this part, so a texture will not show on it.</span>
              <Button size="sm" disabled={busy} onClick={takeMaterialOff}>Take the material off</Button>
            </div>
          )}
          {shownError && (
            <div role="alert" className="flex items-start gap-2 border-b border-line bg-bad/10 px-3 py-1.5 text-2xs text-ink">
              <AlertTriangle size={13} className="mt-px shrink-0 text-bad" />
              <span className="selectable min-w-0 flex-1">{shownError}</span>
              {message && <button type="button" aria-label="Dismiss" onClick={() => setMessage(null)} className="text-ink-3 hover:text-ink"><X size={13} /></button>}
            </div>
          )}
          <div className="flex gap-2 p-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              {mode === 'restyle' ? (
                <Segmented
                  label="What to change"
                  value={everyPart ? 'all' : 'part'}
                  onChange={setScope}
                  disabled={!part}
                  className="self-start"
                  options={[
                    { value: 'part', label: 'This part', hint: 'Change the texture on this part, keeping its layout' },
                    { value: 'all', label: 'All parts', disabled: texturedParts.length < 2, hint: texturedParts.length < 2 ? 'This model has one texture' : `Change all ${texturedParts.length} textures, each from its own map` },
                  ]}
                />
              ) : (
                <Segmented
                  label="How to paint it"
                  value={mode}
                  onChange={setBlankWay}
                  disabled={!part}
                  className="self-start"
                  options={[
                    { value: 'new', label: 'New', hint: onObject ? 'This part has no texture, so it is painted on its shape, seen from every side' : 'This part has no texture and its faces share one map, so that is painted as a surface' },
                    { value: 'whole', label: 'Whole model', disabled: !wholeAllowed, hint: wholeAllowed ? 'Paint the model as a shape, seen from every side, with surface maps to match' : 'Only for a model with no textures: the others keep what they have and change from it' },
                  ]}
                />
              )}
              <TextArea
                aria-label="Description"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                disabled={!part}
                placeholder={placeholder}
                className="h-[52px]"
              />
            </div>
            <div className="flex w-56 shrink-0 flex-col justify-end gap-1.5">
              <AiRouteBar capability={onObject ? 'media.edit' : capabilityOfMode(mode)} label={mode === 'new' && !onObject ? 'Image model' : mode === 'whole' ? 'Whole-model model' : 'Retexture model'} onModelChange={setRouteModel} placement="top-end" />
              <div className="flex h-5 items-center justify-between gap-2 text-2xs text-ink-3">
                <span className="truncate tabular-nums">{cost === null ? (routeModel ? 'Price not known yet' : '') : `About ${formatCost(cost * runs)}${runs > 1 ? ` for ${runs}` : ''}`}</span>
                {!everyPart && <Tooltip text="How many results to paint"><span><Segmented label="How many results" value={count} onChange={setCount} options={COUNTS} /></span></Tooltip>}
              </div>
              <Button variant="primary" size="lg" className="w-full" disabled={!canGenerate} onClick={() => void generate()} title={routeModel ? undefined : 'Choose a model first'}>
                Generate <span className="text-2xs font-normal opacity-60">Ctrl Enter</span>
              </Button>
            </div>
          </div>
        </div>
      </main>

      <PanelEdge side="right" width={right.width} onResize={right.setWidth} onDone={right.save} label="Resize the parts panel" />
      <aside style={{ width: right.width }} className="flex shrink-0 flex-col bg-panel">
        <PanelTitle>Parts</PanelTitle>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ul aria-label="Parts" className="border-b border-line py-1">
            {session?.parts.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={item.id === part?.id || undefined}
                  title={item.rawName || undefined}
                  onClick={() => sessions.setActivePart(session, item.id)}
                  onMouseEnter={() => setGlowPart(item)}
                  onMouseLeave={() => setGlowPart(null)}
                  className={`flex h-8 w-full items-center gap-2 px-3 text-left transition-colors duration-75 ${item.id === part?.id ? 'bg-accent/15 text-ink' : 'text-ink-2 hover:bg-white/5 hover:text-ink'}`}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-well">
                    {item.thumbnail ? <img src={item.thumbnail} alt="" draggable={false} className="h-full w-full object-cover" /> : <Plus size={11} className="text-ink-3" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs">{item.name}</span>
                  {item.worn !== item.saved && <span title="Being tried on, not saved" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                  {item.takes.length > 0 && <span className="shrink-0 text-2xs tabular-nums text-ink-3">{item.takes.length}</span>}
                </button>
              </li>
            ))}
          </ul>

          {part && (
            <Section title="Texture" actions={shownSize ? <span className="text-2xs tabular-nums text-ink-3">{shownSize.width} × {shownSize.height}</span> : undefined}>
              {shownPicture
                ? <img src={shownPicture} alt={`${part.name} texture`} draggable={false} className="aspect-square w-full rounded-sm bg-well object-contain" />
                : <p className="text-2xs text-ink-3">No texture yet. Describe one below and press Generate.</p>}
            </Section>
          )}

          {focused?.state === 'ready' && focused.source && (
            <Section title="Keep original detail" actions={<span className="text-2xs tabular-nums text-ink-3">{Math.round(focused.keepOriginal * 100)}%</span>}>
              <input
                type="range"
                aria-label="Keep original detail"
                min={0}
                max={100}
                step={5}
                value={Math.round(focused.keepOriginal * 100)}
                disabled={part?.saved === focused.id}
                title={part?.saved === focused.id ? 'This result is on the model. Use the original to change it again.' : undefined}
                onChange={(event) => { if (session && part) void sessions.setKeepOriginal(session, part, focused, Number(event.target.value) / 100); }}
                className="w-full"
              />
              <p className="mt-1 text-2xs leading-4 text-ink-3">Fine detail from {focused.fromTake ? `result ${focused.fromTake}` : 'the map it came from'}: folds, seams and print stay where they were. Changing this costs nothing.</p>
            </Section>
          )}

          {focused?.state === 'ready' && (focused.maps.length > 0 || focused.mapsState !== 'none' || mapsModel) && (
            <Section
              title="Surface maps"
              actions={focused.mapsState === 'none' && mapsCost !== null ? <span className="text-2xs tabular-nums text-ink-3">About {formatCost(mapsCost)}</span> : undefined}
            >
              {focused.maps.length > 0 ? (
                <div className="grid grid-cols-3 gap-1.5">
                  {focused.maps.map((surface) => (
                    <figure key={surface.role} className="min-w-0">
                      <img src={surface.url} alt="" draggable={false} className="aspect-square w-full rounded-sm bg-well object-cover" />
                      <figcaption className="mt-0.5 truncate text-2xs text-ink-3">{SURFACE_WORDS[surface.role]}</figcaption>
                    </figure>
                  ))}
                </div>
              ) : focused.mapsState === 'making' ? (
                <div className="flex items-center gap-2 text-2xs text-ink-3"><Spinner className="text-accent" /> Making them</div>
              ) : (
                <>
                  <p className="mb-1.5 text-2xs leading-4 text-ink-3">Normal, roughness and metal maps made from this result, so light falls on it as it would on the real thing.</p>
                  {focused.mapsState === 'failed' && <p role="alert" className="selectable mb-1.5 text-2xs text-bad">{focused.mapsError}</p>}
                  <Button size="sm" disabled={!mapsModel} onClick={() => session && part && mapsModel && void sessions.makeMaps(session, part, focused, mapsModel)}>
                    {focused.mapsState === 'failed' ? 'Try again' : 'Make matching maps'}
                  </Button>
                </>
              )}
            </Section>
          )}

          {focused && (
            <Section
              title={`Result ${focused.number}`}
              actions={focused.state !== 'ready' ? <span className="text-2xs text-ink-3">{STATE_WORDS[focused.state]}</span> : undefined}
            >
              <p className="selectable text-xs leading-[18px] text-ink">{focused.prompt}</p>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-2xs">
                <dt className="text-ink-3">Model</dt><dd className="truncate text-ink-2" title={focused.modelName}>{focused.modelName}</dd>
                <dt className="text-ink-3">From</dt><dd className="text-ink-2">{focused.mode === 'new' ? (focused.sheet ? 'Its shape and the description' : 'The description alone') : focused.mode === 'whole' ? 'The whole model' : focused.fromTake ? `Result ${focused.fromTake}` : 'The original'}</dd>
                {focused.costMicroUsd !== null && <><dt className="text-ink-3">Cost</dt><dd className="tabular-nums text-ink-2">About {formatCost(focused.costMicroUsd)}</dd></>}
                {focused.finishedAt && <><dt className="text-ink-3">Took</dt><dd className="tabular-nums text-ink-2">{Math.round((focused.finishedAt - focused.startedAt) / 1000)} s</dd></>}
              </dl>
              <Button variant="ghost" size="sm" className="-ml-2 mt-1.5" onClick={() => setPrompt(focused.prompt)}>Use this description</Button>
            </Section>
          )}
        </div>
        {sessions.runs > 0 && (
          <div title="Worked out from catalog prices: provider accounts cannot be read from here" className="shrink-0 border-t border-line px-3 py-1.5 text-2xs tabular-nums text-ink-3">
            {sessions.runs} {sessions.runs === 1 ? 'run' : 'runs'} this session{sessions.unpricedRuns === sessions.runs ? '' : `, about ${formatCost(sessions.spentMicroUsd)}`}{sessions.unpricedRuns > 0 && sessions.unpricedRuns < sessions.runs ? ` and ${sessions.unpricedRuns} not priced yet` : ''}
          </div>
        )}
      </aside>
    </div>
  );
};
