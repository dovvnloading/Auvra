import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { describeProviderFailure, hostProviderService, type ProviderModel } from '../../services/HostProviderService';
import { estimateJobCost, formatCost } from '../../services/providerPricing';
import { textureService } from '../../services/TextureGenerationService';
import type { MaterialGraph } from '../../runtime/materials/materialGraph';
import { graphFromTextures, type PaintedTextures } from './graphFromTextures';
import { useAssets } from '../../context/AssetContext';
import { Button, Popover, Spinner, TextArea } from '../UI/kit';

const MATERIAL_PROVIDER = 'fal';
const MAX_NAME = 128;

const textureName = (description: string, suffix: string): string => {
  const name = description.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const room = MAX_NAME - suffix.length;
  return `${name.length > room ? name.slice(0, room).trimEnd() : name}${suffix}`;
};

/** Paints a seamless material from a description, with its surface maps, and hands back a graph that draws with it. */
export const MaterialFromDescription: React.FC<{ onCreated: (name: string, graph: MaterialGraph) => void }> = ({ onCreated }) => {
  const { adoptHostTexture } = useAssets();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [model, setModel] = useState<ProviderModel | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const running = useRef<{ jobId: string; stopped: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    void hostProviderService.listModels(MATERIAL_PROVIDER, 'media.material').then((models) => setModel(models[0] ?? null), () => setModel(null));
  }, [open]);

  const cost = model ? estimateJobCost(model) : null;

  const paint = async () => {
    const wanted = description.trim();
    if (!wanted || !model || working) return;
    setWorking(true); setError(null);
    try {
      const route = await hostProviderService.loadConfiguredRoute('media.material');
      if (route?.modelId !== model.id) await hostProviderService.routeCapability(MATERIAL_PROVIDER, 'media.material', model.id);
      const job = await textureService.submit(null, wanted, 'media.material');
      running.current = { jobId: job.jobId, stopped: false };
      const preview = await textureService.follow(job);
      running.current = null;
      const dimensions = preview.dimensions ?? { width: 1024, height: 1024 };
      // Kept straight away: a material's graph draws with the project's textures, and has nowhere to wait for them.
      const keep = async (previewAssetId: string, suffix: string) => {
        const name = textureName(wanted, suffix);
        await textureService.commit(job.jobId, previewAssetId, { name });
        await adoptHostTexture(previewAssetId, name, previewAssetId, dimensions);
        return previewAssetId;
      };
      const textures: PaintedTextures = { color: await keep(preview.previewAssetId, '') };
      for (const item of preview.maps ?? []) {
        if (item.role === 'normal' || item.role === 'roughness' || item.role === 'metalness') textures[item.role] = await keep(item.previewAssetId, ` ${item.role}`);
      }
      onCreated(textureName(wanted, ''), graphFromTextures(textures));
      setOpen(false);
      setDescription('');
    } catch (cause) {
      if (!running.current?.stopped) setError(describeProviderFailure(cause instanceof Error ? cause.message : undefined) || 'The material could not be painted.');
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
      <Popover anchor={trigger} open={open} onClose={() => { if (!working) setOpen(false); }} width={320} label="New material from a description">
        <div className="space-y-2 p-3">
          <h3 className="text-xs font-medium text-ink">New material from a description</h3>
          <TextArea
            autoFocus
            aria-label="Describe the material"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void paint(); } }}
            disabled={working}
            placeholder="For example: mossy cobblestones, wet after rain"
            className="h-16"
          />
          <p className="text-2xs leading-4 text-ink-3">A seamless texture with normal, roughness and metal maps, wired into a new material.</p>
          {error && (
            <div role="alert" className="flex items-start gap-1.5 text-2xs text-ink">
              <AlertTriangle size={12} className="mt-0.5 shrink-0 text-bad" />
              <span className="selectable min-w-0">{error}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs tabular-nums text-ink-3">{cost !== null ? `About ${formatCost(cost)}` : model ? 'Price not known yet' : ''}</span>
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
