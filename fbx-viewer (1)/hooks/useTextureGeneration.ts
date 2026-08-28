
import { useState, useCallback } from 'react';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { textureService, TextureGenerationResult } from '../services/TextureGenerationService';

interface UseTextureGenerationResult {
  currentTextureBase64: string | null;
  generatedTextureUrl: string | null;
  previewAssetId: string | null;
  progress: number;
  jobId: string | null;
  isGenerating: boolean;
  error: string | null;
  setCurrentTexture: (data: string | null) => void;
  generate: (prompt: string, sourceImage: string, maskImage?: string) => Promise<void>;
  apply: () => string | null;
  commit: (payload?: Record<string, unknown>) => Promise<string | null>;
  discard: () => Promise<void>;
  cancel: () => Promise<void>;
  retry: () => Promise<void>;
}

export const useTextureGeneration = (initialTexture: string | null = null): UseTextureGenerationResult => {
  const [currentTextureBase64, setCurrentTextureBase64] = useState<string | null>(initialTexture);
  const [preview, setPreview] = useState<TextureGenerationResult | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async (prompt: string, sourceImage: string, maskImage?: string) => {
    
    if (!sourceImage || !prompt) return;

    setIsGenerating(true); setError(null); setProgress(0); setPreview(null);

    try {
      // Pass both images to service
      const result = await textureService.generateTexture(sourceImage, prompt, maskImage, {
        onProgress: (value, job) => { setProgress(value); setJobId(job.jobId || null); },
      });
      setPreview(result); setProgress(1); setJobId(null);
    } catch (err: unknown) { setError(err instanceof Error ? err.message : "Generation failed. Please try again."); }
    finally { setIsGenerating(false); }
  }, []);

  // Applying a preview only returns its opaque URL. Durable promotion is commit().
  const apply = useCallback(() => preview?.previewUrl || null, [preview]);

  const commit = useCallback(async (payload: Record<string, unknown> = {}) => {
    if (!preview?.assetId) return null;
    try {
      const committed = await textureService.commit(preview.assetId, payload);
      const next = committed.previewUrl || preview.previewUrl || null;
      setCurrentTextureBase64(next); setPreview(null); setError(null); return next;
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Could not commit generated texture.'); return null; }
  }, [preview]);

  const discard = useCallback(async () => {
    if (preview?.assetId) await textureService.discard(preview.assetId);
    setPreview(null); setError(null); setProgress(0); setJobId(null);
  }, [preview]);

  const cancel = useCallback(async () => {
    try {
      await textureService.cancel();
      setError('Generation cancelled.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not cancel generation.');
    } finally {
      setIsGenerating(false); setJobId(null);
    }
  }, []);

  const retry = useCallback(async () => {
    setIsGenerating(true); setError(null);
    try {
      const result = await textureService.retry({ onProgress: (value, job) => { setProgress(value); setJobId(job.jobId || null); } });
      setPreview(result); setProgress(1); setJobId(null);
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Retry failed.'); }
    finally { setIsGenerating(false); }
  }, []);

  const setCurrentTexture = useCallback((data: string | null) => {
    setCurrentTextureBase64(data);
    setPreview(null); setError(null); setProgress(0); setJobId(null);
  }, []);

  return frontendDiagnostics.traceActions('texture_generation', {
    currentTextureBase64,
    generatedTextureUrl: preview?.previewUrl || null,
    previewAssetId: preview?.assetId || null,
    progress,
    jobId,
    isGenerating,
    error,
    setCurrentTexture,
    generate,
    apply,
    commit,
    discard,
    cancel,
    retry
  });
};
