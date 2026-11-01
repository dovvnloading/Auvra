import { hostProviderService, HostProviderError, InferenceJob, MediaPreview, type ProviderCapability } from './HostProviderService';
import { projectService } from '../utils/projectService';
import { nativeDomainRecords } from '../utils/projectRecords';
import { frontendDiagnostics } from '../diagnostics/runtime';

/** A finished job's picture. Its URL is the caller's: the picture stays loaded until the caller revokes it. */
export interface TexturePreview extends MediaPreview {
  jobId: string;
  previewAssetId: string;
  previewUrl: string;
  /** What a job that makes several maps made, the first of which is the preview above. */
  maps?: { role: string; previewAssetId: string; previewUrl: string }[];
}

const MAX_LOCAL_MEDIA_BYTES = 8 * 1024 * 1024;

/**
 * Host-mediated media workflow. Provider calls never run in the browser. Every job stands alone, so several can run at
 * once and their pictures can be compared before any is kept.
 */
export class TextureGenerationService {
  /** Asks for the source asset restyled as the prompt says, or with none, a new image from the prompt alone. */
  async submit(sourceAssetId: string | null, userPrompt: string, capability?: ProviderCapability): Promise<InferenceJob> {
    if (!userPrompt.trim()) throw new Error('Describe the desired material before generating.');
    return hostProviderService.submitInference({
      capability: capability ?? (sourceAssetId ? 'media.edit' : 'media.generate'),
      input: userPrompt.trim(), ...(sourceAssetId ? { assetIds: [sourceAssetId] } : {}), consent: 'explicit',
    });
  }

  /** Follows a job to its end, and loads the picture of one that succeeded. */
  async follow(initial: InferenceJob, onUpdate?: (job: InferenceJob) => void): Promise<TexturePreview> {
    const job = await hostProviderService.waitForJob(initial, onUpdate);
    if (job.status !== 'succeeded') throw new HostProviderError(job.error?.message || 'Texture generation failed.', job.error?.code, job.error?.retryable);
    const result = job.result && typeof job.result === 'object' ? job.result as MediaPreview : {};
    const previewAssetId = result.previewAssetId || (Array.isArray((result as { previewAssetIds?: unknown[] }).previewAssetIds) ? String((result as { previewAssetIds: unknown[] }).previewAssetIds[0] || '') : '');
    if (!/^[0-9a-f]{64}$/.test(previewAssetId)) throw new HostProviderError('The host returned an invalid preview content hash.', 'invalid_preview');
    let previewUrl = '';
    try { previewUrl = await this.loadAsset(previewAssetId); } catch { throw new HostProviderError('The host preview asset could not be resolved.', 'invalid_preview'); }
    const listed = Array.isArray((job as { previewMaps?: unknown }).previewMaps) ? (job as unknown as { previewMaps: { role: string; previewAssetId: string }[] }).previewMaps : [];
    const maps = await Promise.all(listed.map(async (item) => ({
      role: item.role,
      previewAssetId: item.previewAssetId,
      previewUrl: item.previewAssetId === previewAssetId ? previewUrl : await this.loadAsset(item.previewAssetId),
    })));
    return { ...result, assetId: previewAssetId, previewAssetId, previewUrl, jobId: job.jobId, maps };
  }

  async cancel(jobId: string): Promise<void> { await hostProviderService.cancelInference(jobId); }

  async discard(jobId: string, previewAssetId: string): Promise<void> { await hostProviderService.discardMedia(previewAssetId, jobId); }

  /** Keeps a preview in the project's texture library. The host lets go of the preview once it has. */
  async commit(jobId: string, previewAssetId: string, payload: Record<string, unknown> = {}): Promise<MediaPreview> {
    return hostProviderService.commitMedia({
      ...payload,
      jobId,
      previewAssetId,
      textureId: payload.textureId || previewAssetId,
      name: payload.name || 'Generated Texture',
    });
  }

  /**
   * An asset as a local URL. A host ticket can be read only once and images may not be loaded from it directly, while
   * a preview is both shown in the panel and put on the model.
   */
  private async loadAsset(assetId: string): Promise<string> {
    const response = await fetch(await projectService.resolveAsset(assetId));
    if (!response.ok) throw new Error('The asset could not be read.');
    return URL.createObjectURL(await response.blob());
  }

  /** The asset holding a model's own file, which the project already has. */
  async modelFileAsset(modelId: string): Promise<string> {
    const snapshot = await projectService.getSnapshotAll('models');
    const assetId = nativeDomainRecords(snapshot, 'models').find((record) => record.id === modelId)?.assetId;
    if (typeof assetId !== 'string') throw new Error('The model file could not be found in the project.');
    return assetId;
  }

  /** Gives the host a picture to work from, once however many jobs start from it. */
  async ingestLocalAsset(value: string, name = 'source-texture'): Promise<string> {
    if (/^[0-9a-f]{64}$/.test(value)) return value;
    if (!/^data:/i.test(value)) throw new Error('Media input must be a host asset id.');
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(value);
    if (!match) throw new Error('Selected media data is invalid.');
    const mime = match[1] || 'application/octet-stream';
    if (match[2] && match[3].length > Math.ceil(MAX_LOCAL_MEDIA_BYTES * 4 / 3) + 16) throw new Error('Selected media exceeds the 8 MiB host-ingestion limit.');
    if (!match[2] && match[3].length > MAX_LOCAL_MEDIA_BYTES * 4) throw new Error('Selected media exceeds the 8 MiB host-ingestion limit.');
    const bytes = match[2] ? Uint8Array.from(atob(match[3]), (character) => character.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(match[3]));
    if (bytes.byteLength > MAX_LOCAL_MEDIA_BYTES) throw new Error('Selected media exceeds the 8 MiB host-ingestion limit.');
    const blob = new Blob([bytes], { type: mime });
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    return projectService.uploadAsset(file);
  }
}

frontendDiagnostics.instrumentClass(TextureGenerationService, 'texture_generation', [
  'submit', 'follow', 'cancel', 'discard', 'commit',
]);
export const textureService = new TextureGenerationService();
