import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Aperture, Check, Save, X } from 'lucide-react';
import { useAssets } from '../../context/AssetContext';
import { describeProviderFailure, hostProviderService } from '../../services/HostProviderService';
import { textureService } from '../../services/TextureGenerationService';
import { Button, IconButton, Popover, Segmented, Spinner } from '../UI/kit';
import { buildRenderBundle, frameHeight } from './renderBundle';

const PROVIDER = 'reframe';
const MODEL = 'path-tracer';

type Quality = 'preview' | 'good' | 'final';

const QUALITIES: readonly { value: Quality; label: string; hint: string; width: number; samples: number; bounces: number; denoise: boolean }[] = [
  { value: 'preview', label: 'Preview', hint: 'To check the framing and the light', width: 640, samples: 32, bounces: 4, denoise: false },
  { value: 'good', label: 'Good', hint: 'Clean enough to judge the picture', width: 1280, samples: 128, bounces: 6, denoise: true },
  { value: 'final', label: 'Final', hint: 'A finished frame', width: 1920, samples: 512, bounces: 8, denoise: true },
];

/** A full render can run for hours, on a computer that is not asked for anything else. */
const RENDER_WAIT_MS = 12 * 60 * 60 * 1000;
const SAVED_NAME_LENGTH = 40;

interface Finished {
  jobId: string;
  previewAssetId: string;
  url: string;
  width: number;
  height: number;
  seconds: number;
}

/** Renders the view being looked at with Reframe, a path tracer on this computer, for a finished frame. */
export const RenderPanel: React.FC = () => {
  const { adoptHostTexture } = useAssets();
  const [open, setOpen] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [quality, setQuality] = useState<Quality>('good');
  const [phase, setPhase] = useState<string | null>(null);
  const [canStop, setCanStop] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState<Finished | null>(null);
  const [saved, setSaved] = useState(false);
  const [large, setLarge] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const running = useRef<{ jobId: string; stopped: boolean } | null>(null);
  const [choosing, setChoosing] = useState(false);

  const lookForReframe = useCallback(() => hostProviderService.listProviders()
    .then(() => hostProviderService.health(PROVIDER))
    .then((health) => setAvailable(health?.status === 'healthy'), () => setAvailable(false)), []);

  useEffect(() => {
    if (open) void lookForReframe();
  }, [lookForReframe, open]);

  const chooseFolder = async () => {
    setError(null);
    setChoosing(true);
    try {
      await hostProviderService.chooseFolder(PROVIDER);
      await lookForReframe();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That folder could not be used.');
    } finally {
      setChoosing(false);
    }
  };

  useEffect(() => hostProviderService.subscribe((job) => {
    if (job.jobId === running.current?.jobId && typeof job.progress === 'number') setProgress(job.progress);
  }), []);

  const render = useCallback(async () => {
    const chosen = QUALITIES.find((option) => option.value === quality)!;
    setError(null); setFinished(null); setSaved(false); setProgress(0);
    setPhase('Gathering the scene');
    const started = performance.now();
    try {
      const width = chosen.width;
      const height = frameHeight(width);
      const built = await buildRenderBundle({ width, height });
      if (!built) throw new Error('There is nothing in view to render.');
      const scene = await textureService.ingestPicture(new File([built.bundle], 'render-scene.bin', { type: 'application/octet-stream' }));
      const route = await hostProviderService.loadConfiguredRoute('media.render');
      if (route?.modelId !== MODEL) await hostProviderService.routeCapability(PROVIDER, 'media.render', MODEL);
      setPhase(`Rendering ${built.triangles.toLocaleString()} triangles`);
      const job = await textureService.submit(scene, JSON.stringify({ width, height, samples: chosen.samples, bounces: chosen.bounces, denoise: chosen.denoise }), 'media.render');
      running.current = { jobId: job.jobId, stopped: false };
      setCanStop(true);
      const preview = await textureService.follow(job, undefined, RENDER_WAIT_MS);
      setFinished({
        jobId: job.jobId, previewAssetId: preview.previewAssetId, url: preview.previewUrl,
        width, height, seconds: Math.round((performance.now() - started) / 1000),
      });
    } catch (cause) {
      if (!running.current?.stopped) setError(describeProviderFailure(cause instanceof Error ? cause.message : undefined) || 'The render could not be finished.');
    } finally {
      running.current = null;
      setCanStop(false);
      setPhase(null);
    }
  }, [quality]);

  const stop = () => {
    if (!running.current) return;
    running.current.stopped = true;
    void textureService.cancel(running.current.jobId).catch(() => undefined);
  };

  useEffect(() => {
    if (!large) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setLarge(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [large]);

  const save = async () => {
    if (!finished) return;
    setError(null);
    try {
      const name = `Render ${new Date().toISOString().slice(0, 19).replace('T', ' ').replaceAll(':', '-')}`.slice(0, SAVED_NAME_LENGTH);
      await textureService.commit(finished.jobId, finished.previewAssetId, { name });
      await adoptHostTexture(finished.previewAssetId, name, finished.previewAssetId, { width: finished.width, height: finished.height });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The render could not be saved.');
    }
  };

  const chosen = QUALITIES.find((option) => option.value === quality)!;
  return (
    <>
      <IconButton ref={trigger} label="Render this view" active={open || phase !== null} onClick={() => setOpen((value) => !value)}><Aperture size={14} /></IconButton>
      <Popover anchor={trigger} open={open} onClose={() => setOpen(false)} width={340} label="Render this view">
        <div className="space-y-2 p-3">
          <h3 className="text-xs font-medium text-ink">Render this view</h3>
          {available === false ? (
            <>
              <p className="text-2xs leading-4 text-ink-2">Reframe was not found on this computer. Rendering needs Reframe and an NVIDIA graphics card.</p>
              <Button size="sm" disabled={choosing} onClick={() => void chooseFolder()}>{choosing ? 'Waiting for the folder window' : 'Show where Reframe is kept'}</Button>
            </>
          ) : (
            <>
              <p className="text-2xs leading-4 text-ink-3">A path traced frame of what the camera sees, on this computer's graphics card. It costs nothing.</p>
              <Segmented label="Quality" value={quality} onChange={setQuality} disabled={phase !== null} options={QUALITIES.map(({ value, label, hint }) => ({ value, label, hint }))} />
              <p className="text-2xs tabular-nums text-ink-3">{chosen.width} wide, {chosen.samples} samples a pixel</p>
            </>
          )}
          {error && (
            <div role="alert" className="flex items-start gap-1.5 text-2xs text-ink">
              <AlertTriangle size={12} className="mt-0.5 shrink-0 text-bad" />
              <span className="selectable min-w-0">{error}</span>
            </div>
          )}
          {phase && (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-2xs text-ink-2">
                <span className="flex min-w-0 items-center gap-1.5 truncate"><Spinner className="text-accent" /> {phase}</span>
                <span className="tabular-nums text-ink-3">{Math.round(progress * 100)}%</span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-well"><div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            </div>
          )}
          {finished && !phase && (
            <div className="space-y-1.5">
              <button type="button" aria-label="See the render larger" onClick={() => setLarge(true)} className="block w-full overflow-hidden rounded-sm bg-well">
                <img src={finished.url} alt="The finished render" draggable={false} className="w-full" />
              </button>
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xs tabular-nums text-ink-3">{finished.width} × {finished.height}, {finished.seconds} s</span>
                {saved
                  ? <span className="flex items-center gap-1 text-2xs text-ink-2"><Check size={12} className="text-accent" /> In the library</span>
                  : <Button size="sm" icon={<Save size={12} />} onClick={() => void save()}>Save to library</Button>}
              </div>
            </div>
          )}
          {available !== false && (
            <div className="flex justify-end gap-1.5">
              {phase && <Button size="sm" disabled={!canStop} onClick={stop}>Stop</Button>}
              <Button variant="primary" disabled={phase !== null || available === null} onClick={() => void render()}>{finished ? 'Render again' : 'Render'}</Button>
            </div>
          )}
        </div>
      </Popover>
      {large && finished && createPortal(
        <div role="dialog" aria-label="The finished render" className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/85 p-6" onClick={() => setLarge(false)}>
          <img src={finished.url} alt="The finished render" draggable={false} className="max-h-full max-w-full object-contain" />
          <span className="absolute right-3 top-3"><IconButton label="Close" onClick={() => setLarge(false)}><X size={15} /></IconButton></span>
        </div>,
        document.body,
      )}
    </>
  );
};
