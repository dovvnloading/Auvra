/// <reference types="vite/client" />
import type { ProviderCapability, ProviderModel } from './HostProviderService';

export type PickTier = 'Fast' | 'Balanced' | 'Best quality';

export interface ModelPick {
  id: string;
  tier: PickTier;
  /** What it is good for, in a few words. */
  note: string;
}

const LANGUAGE_PICKS: readonly ModelPick[] = [
  { id: 'openai/gpt-oss-20b', tier: 'Fast', note: 'Cheapest that keeps to the format reliably' },
  { id: 'anthropic/claude-haiku-5.5', tier: 'Balanced', note: 'Quick, and good with code' },
  { id: 'anthropic/claude-sonnet-5.5', tier: 'Best quality', note: 'For anything involved' },
];

/** A short list per job, so choosing a model does not mean reading a whole catalog. The full list stays a click away. */
const MODEL_PICKS: Readonly<Record<string, Partial<Record<ProviderCapability, readonly ModelPick[]>>>> = {
  fal: {
    'media.edit': [
      // Chosen by running a real model's views through them. Of the top models, these keep its shape and markings where others invent new ones.
      { id: 'blackforestlabs/flux-3/edit-image', tier: 'Best quality', note: 'Keeps shape and markings, adds real surface detail' },
      { id: 'bytedance/seedream/v5/pro/edit', tier: 'Best quality', note: 'The richest surfaces. Takes longer' },
      { id: 'google/nano-banana-2.1/edit', tier: 'Balanced', note: 'Quick, and stays nearest the original' },
    ],
    'media.generate': [
      { id: 'fal-ai/flux/schnell', tier: 'Fast', note: 'Quick drafts' },
      { id: 'fal-ai/patina/material', tier: 'Balanced', note: 'Seamless, with surface maps' },
      { id: 'fal-ai/flux-2', tier: 'Balanced', note: 'Cleaner detail' },
      { id: 'fal-ai/flux-2-pro', tier: 'Best quality', note: 'Fine detail, follows the description closely' },
    ],
    // Both were run against others: they paint a true panorama, where most paint a wide photograph.
    'media.sky': [
      { id: 'fal-ai/flux-2-max', tier: 'Best quality', note: 'A true panorama, the horizon across the middle' },
      { id: 'blackforestlabs/flux-3/text-to-image', tier: 'Best quality', note: 'The sharpest clouds. The horizon can sit a little high' },
    ],
    'media.decal': [
      { id: 'fal-ai/ideogram/v3/generate-transparent', tier: 'Best quality', note: 'Really transparent, and good with lettering and graphics' },
    ],
    'media.mesh': [
      { id: 'meshy/v6-lite/retexture', tier: 'Fast', note: 'Quicker, less detail' },
      { id: 'meshy/v7/retexture', tier: 'Best quality', note: 'Newest, sharpest detail' },
    ],
    code: LANGUAGE_PICKS,
    commands: LANGUAGE_PICKS,
    text: LANGUAGE_PICKS,
  },
};

/**
 * Small pictures of what the suggested image models paint: each from the same input and the same description, so they
 * can be compared, rather than each provider's own best showing.
 */
const SAMPLES = import.meta.glob('../components/Settings/modelSamples/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export const modelSample = (modelId: string): string | undefined => SAMPLES[`../components/Settings/modelSamples/${modelId.replaceAll('/', '-')}.webp`];

/** The picks a provider's catalog actually has for a capability, each with its model, in order. */
export const picksFor = (providerId: string, capability: ProviderCapability, models: readonly ProviderModel[]): (ModelPick & { model: ProviderModel })[] => {
  const byId = new Map(models.map((model) => [model.id, model]));
  return (MODEL_PICKS[providerId]?.[capability] ?? []).flatMap((pick) => {
    const model = byId.get(pick.id);
    return model ? [{ ...pick, model }] : [];
  });
};

/**
 * Models in an image catalog that do not paint from a description: cut-outs, upscalers, measuring tools and the like.
 * Hidden unless asked for, as they cannot do what the tool is for.
 */
const UTILITY_MODEL = /post[- ]?processing|background|birefnet|rembg|remove|eraser?\b|upscal|esrgan|aura-sr|codeformer|clarity|ddcolor|depth|preprocessor|segment|\bsam-?\d?\b|florence|caption|\bocr\b|detect|ffmpeg|frame|\bfilm\b|\brife\b|workflow-utilities|imageutils|nsfw|\bface|try-?on|lip-?sync|\bfill\b|expand|reframe|inpaint|outpaint|extract|layerize|redux|realtime/i;

export const isUtilityModel = (model: ProviderModel): boolean => UTILITY_MODEL.test(`${model.id} ${model.name ?? ''}`);
