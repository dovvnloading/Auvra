
import { useState, useCallback } from 'react';
import { textureService } from '../services/TextureGenerationService';

interface UseTextureGenerationResult {
  currentTextureBase64: string | null;
  generatedTextureUrl: string | null;
  isGenerating: boolean;
  error: string | null;
  setCurrentTexture: (data: string | null) => void;
  generate: (prompt: string, sourceImage: string, maskImage?: string) => Promise<void>;
  apply: () => string | null;
  discard: () => void;
}

export const useTextureGeneration = (initialTexture: string | null = null): UseTextureGenerationResult => {
  const [currentTextureBase64, setCurrentTextureBase64] = useState<string | null>(initialTexture);
  const [generatedTextureUrl, setGeneratedTextureUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async (prompt: string, sourceImage: string, maskImage?: string) => {
    
    if (!sourceImage || !prompt) return;

    setIsGenerating(true);
    setError(null);
    setGeneratedTextureUrl(null);

    try {
      // Pass both images to service
      const resultUrl = await textureService.generateTexture(sourceImage, prompt, maskImage);
      setGeneratedTextureUrl(resultUrl);
    } catch (err: any) {
      setError(err.message || "Generation failed. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  }, []);

  const apply = useCallback(() => {
    if (generatedTextureUrl) {
      const newTexture = generatedTextureUrl;
      setCurrentTextureBase64(newTexture); // Cycle forward
      setGeneratedTextureUrl(null); // Clear preview
      return newTexture;
    }
    return null;
  }, [generatedTextureUrl]);

  const discard = useCallback(() => {
    setGeneratedTextureUrl(null);
    setError(null);
  }, []);

  const setCurrentTexture = useCallback((data: string | null) => {
    setCurrentTextureBase64(data);
    setGeneratedTextureUrl(null);
    setError(null);
  }, []);

  return {
    currentTextureBase64,
    generatedTextureUrl,
    isGenerating,
    error,
    setCurrentTexture,
    generate,
    apply,
    discard
  };
};
