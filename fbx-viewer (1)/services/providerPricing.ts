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

/**
 * What to sort by for "cheapest": a rough cost of one job, so that a price per image and one per second can be weighed.
 * A language model weighs its input and output as a short exchange would. Unknown prices sort last.
 */
export const modelCostWeight = (model: ProviderModel): number => {
  if (typeof model.priceMicroUsd !== 'number') return Number.POSITIVE_INFINITY;
  if (typeof model.outputPriceMicroUsd === 'number') return model.priceMicroUsd + model.outputPriceMicroUsd;
  return model.priceMicroUsd * (UNITS[model.priceUnit ?? '']?.perJob ?? 1);
};
