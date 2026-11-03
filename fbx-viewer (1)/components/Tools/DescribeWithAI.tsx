import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { describeProviderFailure, hostProviderService, type InferenceJob, type ProviderCapability, type ProviderModel } from '../../services/HostProviderService';
import { estimateJobCost, formatCost } from '../../services/providerPricing';
import { picksFor } from '../../services/providerPicks';
import { textureService, type TexturePreview } from '../../services/TextureGenerationService';
import { Button, Popover, Spinner, TextArea } from '../UI/kit';

const PROVIDER = 'fal';
const MAX_NAME = 128;

/** A project texture's name from a description: what a file name could not hold is left out. */
export const nameFromWords = (words: string, suffix = ''): string => {
  const name = words.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const room = MAX_NAME - suffix.length;
  return `${name.length > room ? name.slice(0, room).trimEnd() : name}${suffix}`;
};

export interface PaintedFromWords {
  job: InferenceJob;
  preview: TexturePreview;
  words: string;
}

interface DescribeWithAIProps {
  capability: ProviderCapability;
  title: string;
  hint: string;
  placeholder: string;
  /** What the model is told, from what was typed. */
  instruction?: (words: string) => string;
  /** Takes the finished picture in. The window stays busy until this is through, and closes after. */
  onPainted: (painted: PaintedFromWords) => Promise<void>;
  /** What a run comes to, in megapixels, for a model priced by them. */
  megapixels?: number;
}

/** A button that opens a small window for describing a picture, which paints it and hands it over. */
export const DescribeWithAI: React.FC<DescribeWithAIProps> = ({ capability, title, hint, placeholder, instruction, onPainted, megapixels }) => {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [model, setModel] = useState<ProviderModel | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const running = useRef<{ jobId: string; stopped: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    void hostProviderService.listModels(PROVIDER, capability).then((models) => setModel(picksFor(PROVIDER, capability, models)[0]?.model ?? models[0] ?? null), () => setModel(null));
  }, [capability, open]);

  const cost = model ? estimateJobCost(model, megapixels) : null;

  const paint = async () => {
    const words = description.trim();
    if (!words || !model || working) return;
    setWorking(true); setError(null);
    try {
      const route = await hostProviderService.loadConfiguredRoute(capability);
      if (route?.modelId !== model.id) await hostProviderService.routeCapability(PROVIDER, capability, model.id);
      const job = await textureService.submit(null, instruction ? instruction(words) : words, capability);
      running.current = { jobId: job.jobId, stopped: false };
      const preview = await textureService.follow(job);
      running.current = null;
      await onPainted({ job, preview, words });
      setOpen(false);
      setDescription('');
    } catch (cause) {
      if (!running.current?.stopped) setError(describeProviderFailure(cause instanceof Error ? cause.message : undefined) || 'That could not be painted.');
    } finally {
      running.current = null;
      setWorking(false);
    }
  };

  /** A busy queue can hold a job for minutes. It ends as stopped, which needs no remark. */
  const stop = () => {
    if (!running.current) return;
    running.current.stopped = true;
    void textureService.cancel(running.current.jobId).catch(() => undefined);
  };

  return (
    <>
      <Button ref={trigger} size="sm" icon={<Sparkles size={12} />} aria-expanded={open} onClick={() => setOpen((value) => !value)}>Describe</Button>
      <Popover anchor={trigger} open={open} onClose={() => { if (!working) setOpen(false); }} width={320} label={title}>
        <div className="space-y-2 p-3">
          <h3 className="text-xs font-medium text-ink">{title}</h3>
          <TextArea
            autoFocus
            aria-label={title}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void paint(); } }}
            disabled={working}
            placeholder={placeholder}
            className="h-16"
          />
          <p className="text-2xs leading-4 text-ink-3">{hint}</p>
          {error && (
            <div role="alert" className="flex items-start gap-1.5 text-2xs text-ink">
              <AlertTriangle size={12} className="mt-0.5 shrink-0 text-bad" />
              <span className="selectable min-w-0">{error}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-2xs tabular-nums text-ink-3" title={model?.name || model?.id}>{cost !== null ? `About ${formatCost(cost)}` : model ? 'Price not known yet' : ''}</span>
            <div className="flex items-center gap-1.5">
              {working && <Button size="sm" onClick={stop}>Stop</Button>}
              <Button variant="primary" disabled={!description.trim() || !model || working} icon={working ? <Spinner /> : undefined} onClick={() => void paint()}>
                {working ? 'Painting' : 'Paint'}
              </Button>
            </div>
          </div>
        </div>
      </Popover>
    </>
  );
};
