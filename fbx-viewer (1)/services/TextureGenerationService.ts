import { hostProviderService, HostProviderError, InferenceJob, MediaPreview } from './HostProviderService';
import { projectService } from '../utils/projectService';
import { frontendDiagnostics } from '../diagnostics/runtime';

export interface TextureGenerationResult extends MediaPreview { previewUrl: string; }
export interface TextureGenerationOptions {
  onProgress?: (progress: number, job: InferenceJob) => void;
}

const MAX_LOCAL_MEDIA_BYTES = 8 * 1024 * 1024;

/** Host-mediated media workflow. Provider calls never run in the browser. */
export class TextureGenerationService {
  private activeJobId: string | null = null;
  private completedJobId: string | null = null;
  private previewObjectUrl: string | null = null;

  /** Restyles `sourceImage` as the prompt says, or with none, makes a new image from the prompt alone. */
  async generateTexture(sourceImage: string | null, userPrompt: string, maskReferenceBase64?: string, options: TextureGenerationOptions = {}): Promise<TextureGenerationResult> {
    if (!userPrompt.trim()) throw new Error('Describe the desired material before generating.');
    if (maskReferenceBase64) throw new HostProviderError('Masked texture generation is not supported by the current host contract.', 'unsupported_capability');
    const sourceAssetId = sourceImage ? await this.ingestLocalAsset(sourceImage, 'source-texture') : null;
    const job = await hostProviderService.submitInference({
      capability: sourceAssetId ? 'media.edit' : 'media.generate',
      input: userPrompt.trim(), ...(sourceAssetId ? { assetIds: [sourceAssetId] } : {}), consent: 'explicit',
    });
    this.activeJobId = job.jobId || null; this.completedJobId = null;
    return this.waitForPreview(job, options.onProgress);
  }

  async cancel(): Promise<void> { if (this.activeJobId) await hostProviderService.cancelInference(this.activeJobId); this.activeJobId = null; }
  async retry(options: TextureGenerationOptions = {}): Promise<TextureGenerationResult> {
    if (!this.activeJobId) throw new Error('There is no texture job to retry.');
    return this.waitForPreview(await hostProviderService.retryInference(this.activeJobId), options.onProgress);
  }
  async discard(assetId: string): Promise<void> { const jobId = this.completedJobId || this.activeJobId; if (assetId && jobId) await hostProviderService.discardMedia(assetId, jobId); this.activeJobId = null; this.completedJobId = null; }
  async commit(assetId: string, payload: Record<string, unknown> = {}): Promise<MediaPreview> {
    if (!assetId) throw new Error('The generated media asset is unavailable.');
    if (!this.completedJobId) throw new Error('The generated media job is no longer available. Generate a new preview before committing.');
    const result = await hostProviderService.commitMedia({
      ...payload,
      jobId: this.completedJobId,
      previewAssetId: assetId,
      textureId: payload.textureId || assetId,
      name: payload.name || 'Generated Texture',
    });
    if (result.assetId && /^[0-9a-f]{64}$/.test(result.assetId)) {
      const previewUrl = await this.loadAsset(result.assetId);
      this.activeJobId = null; this.completedJobId = null;
      return { ...result, previewUrl };
    }
    this.activeJobId = null; this.completedJobId = null; return { ...result, previewUrl: '' };
  }

  private async waitForPreview(initial: InferenceJob, onProgress?: TextureGenerationOptions['onProgress']): Promise<TextureGenerationResult> {
    const job = await hostProviderService.waitForJob(initial, (current) => {
      onProgress?.(typeof current.progress === 'number' ? Math.max(0, Math.min(1, current.progress)) : 0, current);
    });
    if (job.status !== 'succeeded') throw new HostProviderError(job.error?.message || 'Texture generation failed.', job.error?.code, job.error?.retryable);
    const result = job.result && typeof job.result === 'object' ? job.result as MediaPreview : {};
    const previewAssetId = result.previewAssetId || (Array.isArray((result as { previewAssetIds?: unknown[] }).previewAssetIds) ? String((result as { previewAssetIds: unknown[] }).previewAssetIds[0] || '') : '');
    if (!/^[0-9a-f]{64}$/.test(previewAssetId)) throw new HostProviderError('The host returned an invalid preview content hash.', 'invalid_preview');
    let previewUrl = '';
    try { previewUrl = await this.loadAsset(previewAssetId); } catch { throw new HostProviderError('The host preview asset could not be resolved.', 'invalid_preview'); }
    this.completedJobId = job.jobId; this.activeJobId = null; return { ...result, assetId: previewAssetId, previewAssetId, previewUrl, jobId: job.jobId };
  }

  /**
   * An asset as a local URL. A host ticket can be read only once and images may not be loaded from it directly, while
   * a preview is both shown in the panel and put on the model.
   */
  private async loadAsset(assetId: string): Promise<string> {
    const response = await fetch(await projectService.resolveAsset(assetId));
    if (!response.ok) throw new Error('The asset could not be read.');
    const url = URL.createObjectURL(await response.blob());
    if (this.previewObjectUrl) URL.revokeObjectURL(this.previewObjectUrl);
    this.previewObjectUrl = url;
    return url;
  }

  private async ingestLocalAsset(value: string, name: string): Promise<string> {
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
  'generateTexture', 'cancel', 'retry', 'discard', 'commit',
]);
export const textureService = new TextureGenerationService();
