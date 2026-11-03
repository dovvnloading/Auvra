import type { ProviderModel } from './HostProviderService';

/** How each of fal's billing units reads after a price, and about how many of them a square 1024 texture takes. */
const UNITS: Record<string, { label: string; perJob: number }> = {
  images: { label: 'image', perJob: 1 },
  megapixels: { label: 'MP', perJob: 1.05 },
  'processed megapixels': { label: 'MP', perJob: 1.05 },
  'compute seconds': { label: 's', perJob: 8 },
  seconds: { label: 's', perJob: 8 },
  units: { label: 'run', perJob: 1 },
  generations: { label: 'run', perJob: 1 },
  '1': { label: 'run', perJob: 1 },
  credits: { label: 'credit', perJob: 1 },
};

const dollars = (microUsd: number): string => {
  const value = microUsd / 1_000_000;
  if (value === 0) return '$0';
  if (value >= 1) return `$${value.toFixed(2)}`;
  // Enough digits to tell the very cheap apart.
  return `$${Number(value.toPrecision(2)).toString()}`;
};

/** A model's price as fal or the router bills it (a language model's as input / output tokens), or null while it is not known. */
export const formatModelPrice = (model: ProviderModel): string | null => {
  if (typeof model.priceMicroUsd !== 'number') return null;
  if (typeof model.outputPriceMicroUsd === 'number') return `${dollars(model.priceMicroUsd)} / ${dollars(model.outputPriceMicroUsd)} per 1M`;
  const unit = UNITS[model.priceUnit ?? ''];
  return `${dollars(model.priceMicroUsd)}/${unit?.label ?? (model.priceUnit || 'run')}`;
};

/** A price for a tight space: a language model's as input / output, without its unit. */
export const formatShortPrice = (model: ProviderModel): string | null => {
  if (typeof model.priceMicroUsd === 'number' && typeof model.outputPriceMicroUsd === 'number') return `${dollars(model.priceMicroUsd)} / ${dollars(model.outputPriceMicroUsd)}`;
  return formatModelPrice(model);
};

/**
 * About what one job of a media model comes to, in micro-USD, for a picture of so many megapixels. Null for a language
 * model, or while the price is not known.
 */
export const estimateJobCost = (model: ProviderModel, megapixels = 1.05): number | null => {
  if (typeof model.priceMicroUsd !== 'number' || typeof model.outputPriceMicroUsd === 'number') return null;
  const unit = model.priceUnit ?? '';
  return model.priceMicroUsd * (unit.includes('megapixel') ? megapixels : UNITS[unit]?.perJob ?? 1);
};

/** An amount as a person would read it, with enough digits to tell the very cheap apart. */
export const formatCost = (microUsd: number): string => dollars(microUsd);

/**
 * What to sort by for "cheapest": a rough cost of one job, so that a price per image and one per second can be weighed.
 * A language model weighs its input and output as a short exchange would. Unknown prices sort last.
 */
export const modelCostWeight = (model: ProviderModel): number => {
  if (typeof model.priceMicroUsd !== 'number') return Number.POSITIVE_INFINITY;
  if (typeof model.outputPriceMicroUsd === 'number') return model.priceMicroUsd + model.outputPriceMicroUsd;
  return model.priceMicroUsd * (UNITS[model.priceUnit ?? '']?.perJob ?? 1);
};
