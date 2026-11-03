import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describeProviderFailure, HostProviderService, hostProviderService, type ProviderModel } from '../../services/HostProviderService';
import { formatModelPrice, modelCostWeight } from '../../services/providerPricing';
import { filterModels, ModelPicker, sortModels } from '../../components/Settings/ModelPicker';
import { composeScriptRequest, extractScriptCode, MAX_REQUEST_CHARACTERS } from '../../components/Scripting/scriptAssistantPrompt';

const model = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({ id, name: id, ...extra });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('model prices', () => {
  it('says each of fal\'s billing units in short', () => {
    expect(formatModelPrice(model('a', { priceMicroUsd: 3000, priceUnit: 'megapixels' }))).toBe('$0.003/MP');
    expect(formatModelPrice(model('a', { priceMicroUsd: 40000, priceUnit: 'images' }))).toBe('$0.04/image');
    expect(formatModelPrice(model('a', { priceMicroUsd: 575, priceUnit: 'compute seconds' }))).toBe('$0.00057/s');
    expect(formatModelPrice(model('a', { priceMicroUsd: 1500000, priceUnit: 'units' }))).toBe('$1.50/run');
    expect(formatModelPrice(model('a', { priceMicroUsd: 5000, priceUnit: 'somethings' }))).toBe('$0.005/somethings');
  });

  it('gives a language model its input and output, and nothing for an unknown price', () => {
    expect(formatModelPrice(model('a', { priceMicroUsd: 29000, outputPriceMicroUsd: 30000, priceUnit: '1M tokens' }))).toBe('$0.029 / $0.03 per 1M');
    expect(formatModelPrice(model('a'))).toBeNull();
  });

  it('weighs a price per second against one per image, and an unknown one last', () => {
    const perSecond = modelCostWeight(model('a', { priceMicroUsd: 1000, priceUnit: 'compute seconds' }));
    const perImage = modelCostWeight(model('b', { priceMicroUsd: 3000, priceUnit: 'images' }));
    expect(perSecond).toBeGreaterThan(perImage);
    expect(modelCostWeight(model('c'))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('finding a model', () => {
  const models = [
    model('fal-ai/flux/dev', { name: 'FLUX dev', priceMicroUsd: 25000, priceUnit: 'megapixels' }),
    model('fal-ai/flux/schnell', { name: 'FLUX schnell', priceMicroUsd: 3000, priceUnit: 'megapixels' }),
    model('acme/unpriced', { name: 'Acme' }),
    model('acme/also-unpriced', { name: 'Aardvark', description: 'paints bricks' }),
  ];

  it('searches names, ids and descriptions by every word typed', () => {
    expect(filterModels(models, 'flux schnell').map((item) => item.id)).toEqual(['fal-ai/flux/schnell']);
    expect(filterModels(models, 'BRICKS').map((item) => item.id)).toEqual(['acme/also-unpriced']);
    expect(filterModels(models, '  ')).toHaveLength(4);
  });

  it('sorts the cheapest first, with those of unknown price by name after them', () => {
    expect(sortModels(models, 'cheapest').map((item) => item.name)).toEqual(['FLUX schnell', 'FLUX dev', 'Aardvark', 'Acme']);
    expect(sortModels(models, 'name').map((item) => item.name)).toEqual(['Aardvark', 'Acme', 'FLUX dev', 'FLUX schnell']);
  });

  it('lists what the host offers, and hands back the one chosen', async () => {
    vi.spyOn(hostProviderService, 'listModels').mockResolvedValue(models);
    const chosen = vi.fn();
    render(<ModelPicker providerId="fal" capability="media.edit" onChoose={chosen} />);
    await waitFor(() => expect(screen.getByLabelText('Models')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'schnell' } });
    expect(screen.getByLabelText('Models').querySelectorAll('li')).toHaveLength(1);
    fireEvent.click(screen.getByText('FLUX schnell'));
    expect(chosen.mock.calls[0][0].id).toBe('fal-ai/flux/schnell');
  });

  it('draws only so many rows of a long catalog, and says how many more there are', async () => {
    const many = Array.from({ length: 150 }, (_, index) => model(`acme/model-${index}`));
    vi.spyOn(hostProviderService, 'listModels').mockResolvedValue(many);
    render(<ModelPicker providerId="fal" capability="media.edit" onChoose={vi.fn()} />);
    await screen.findByText('50 more: keep typing to narrow them down.');
  });
});

/** A host that answers provider requests from a table, and records them. */
const fakeHost = (answer: (method: string, payload: Record<string, unknown>) => unknown) => {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const host = {
    session: 's', currentRevision: 1,
    request: async (request: { method: string; payload: Record<string, unknown> }) => {
      calls.push({ method: request.method, payload: request.payload });
      return { ok: true, result: answer(request.method, request.payload) };
    },
  };
  return { service: new HostProviderService(host as never), calls };
};

describe('the host provider service', () => {
  it('reads a catalog that runs over several messages', async () => {
    const { service, calls } = fakeHost((_method, payload) => (payload.cursor
      ? { models: [{ modelId: 'b', displayName: 'B', capabilities: ['media.edit'], priceMicroUsd: 3000, priceUnit: 'megapixels' }], cursor: '', hasMore: false }
      : { models: [{ modelId: 'a', displayName: 'A', capabilities: ['media.edit'] }], cursor: '1', hasMore: true }));
    const models = await service.listModels('fal', 'media.edit');
    expect(models.map((item) => item.id)).toEqual(['a', 'b']);
    expect(models[1].priceMicroUsd).toBe(3000);
    expect(calls[1].payload.cursor).toBe('1');
  });

  it('reads a catalog once however many tools ask, until the host says it changed', async () => {
    let emit: (event: unknown) => void = () => undefined;
    const calls: string[] = [];
    const host = {
      session: 's', currentRevision: 1,
      subscribe: (listener: (event: unknown) => void) => { emit = listener; return () => undefined; },
      request: async (request: { method: string }) => {
        calls.push(request.method);
        return { ok: true, result: { models: [{ modelId: 'a', displayName: 'A', capabilities: ['media.edit'] }], cursor: '', hasMore: false } };
      },
    };
    const service = new HostProviderService(host as never);
    await Promise.all([service.listModels('fal', 'media.edit'), service.listModels('fal', 'media.edit')]);
    await service.listModels('fal', 'media.edit');
    expect(calls).toHaveLength(1);
    emit({ event: 'provider.status', payload: {} });
    await service.listModels('fal', 'media.edit');
    expect(calls).toHaveLength(2);
  });

  it('moves a capability to one provider, the other keeping its other routes', async () => {
    const settings = (routes: { capability: string; modelId: string }[]) => ({
      enabled: true, routes, fallbackPolicy: 'none', requireCostConfirmation: true,
      budgets: { perJobMicroUsd: 0, dailyMicroUsd: 0, monthlyMicroUsd: 0 },
    });
    const { service, calls } = fakeHost((method, payload) => {
      if (method === 'provider.list') return { providers: [{ providerId: 'fal', route: 'cloud', capabilities: ['code'] }, { providerId: 'openai', route: 'cloud', capabilities: ['code', 'text'] }] };
      if (method === 'provider.getStatus') return payload.providerId === 'fal'
        ? { providerId: 'fal', settingsRevision: 2, settings: { ...settings([]), enabled: false } }
        : { providerId: 'openai', settingsRevision: 5, settings: settings([{ capability: 'code', modelId: 'gpt' }, { capability: 'text', modelId: 'gpt' }]) };
      return { settingsRevision: 9 };
    });
    await service.routeCapability('fal', 'code', 'mistralai/mistral-nemo');
    const configured = calls.filter((call) => call.method === 'provider.configure');
    expect(configured.map((call) => call.payload.providerId)).toEqual(['openai', 'fal']);
    expect((configured[0].payload.settings as { routes: unknown[] }).routes).toEqual([{ capability: 'text', modelId: 'gpt' }]);
    expect(configured[0].payload.expectedSettingsRevision).toBe(5);
    expect(configured[1].payload.settings).toMatchObject({ enabled: true, routes: [{ capability: 'code', modelId: 'mistralai/mistral-nemo' }] });
    expect(service.getConfiguredRoute('code')?.providerId).toBe('fal');
  });

  it('says a failure in words, keeping what the provider said itself', () => {
    expect(describeProviderFailure('provider_authentication')).toContain('rejected the key');
    expect(describeProviderFailure('Exhausted balance')).toBe('Exhausted balance');
  });
});

describe('the script assistant prompt', () => {
  const reference = [{ title: 'Objects', entries: [{ signature: 'ctx.self', description: "This script's object." }] }];

  it('carries the API, the script and the request', () => {
    const text = composeScriptRequest('  spin it ', 'const a = 1;', reference);
    expect(text).toContain('ctx.self');
    expect(text).toContain('const a = 1;');
    expect(text).toContain('What to do: spin it');
  });

  it('stays within what a request may carry, keeping the request', () => {
    const text = composeScriptRequest('spin it', 'x'.repeat(MAX_REQUEST_CHARACTERS * 2), reference);
    expect(text.length).toBeLessThanOrEqual(MAX_REQUEST_CHARACTERS);
    expect(text).toContain('What to do: spin it');
  });

  it('takes the code out of an answer, fenced or not', () => {
    expect(extractScriptCode('Here you go:\n```ts\nfunction onStart(ctx) {}\n```\nEnjoy!')).toBe('function onStart(ctx) {}');
    expect(extractScriptCode('function onStart(ctx) {}\n\n')).toBe('function onStart(ctx) {}');
  });
});
