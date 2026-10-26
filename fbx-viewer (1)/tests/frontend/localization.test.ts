import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  LOCALIZATION_DOCUMENT_ID,
  createDefaultLocalizationDocument,
  createLocalizationStore,
  interpolate,
  localeFallbackChain,
  localization,
  localizationSettingsFromDocuments,
  normalizeLocalizationSettings,
  t,
  translate,
  useLocale,
  useTranslation,
  type LocalizationSettings,
} from '../../runtime/localization';

const memoryStorage = (initial: Record<string, string> = {}): Storage => {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
  };
};

const tables: LocalizationSettings = {
  defaultLocale: 'en',
  locales: {
    en: { 'menu.play': 'Play', 'hud.score': 'Score: {score}', 'hud.greeting': 'Hello, {name}!', 'only.en': 'English only' },
    fr: { 'menu.play': 'Jouer', 'hud.score': 'Points : {score}', 'hud.greeting': '' },
    'fr-CA': { 'menu.play': 'Jouer!' },
  },
};

afterEach(() => {
  localization.reset();
  localization.setLocale(null);
});

describe('localization settings', () => {
  it('normalizes stored documents into runtime-safe tables', () => {
    const settings = normalizeLocalizationSettings({
      defaultLocale: 'de',
      locales: {
        // JSON.parse makes __proto__ an own key, as a hostile stored document would.
        en: JSON.parse('{"ok": "Fine", " padded": "dropped", "count": 3, "__proto__": "x", "constructor": "nope"}'),
        'not a locale': { a: 'b' },
        es: ['array tables are dropped'],
      },
    });
    expect(settings.defaultLocale).toBe('de');
    expect(settings.locales).toEqual({ en: { ok: 'Fine' }, es: {}, de: {} });
    expect(Object.getPrototypeOf(settings.locales.en)).toBe(Object.prototype);

    expect(normalizeLocalizationSettings({ defaultLocale: 7, locales: { ja: { a: 'b' } } }))
      .toEqual({ defaultLocale: 'ja', locales: { ja: { a: 'b' } } });
    expect(normalizeLocalizationSettings(undefined)).toEqual(createDefaultLocalizationDocument().settings);
  });

  it('finds the localization document among metadata documents', () => {
    const settings = localizationSettingsFromDocuments([
      { id: 'game-settings', settings: { name: 'Demo' } },
      { id: LOCALIZATION_DOCUMENT_ID, settings: tables },
    ]);
    expect(settings).toEqual(tables);
    expect(localizationSettingsFromDocuments(null).defaultLocale).toBe('en');
  });
});

describe('translation', () => {
  it('interpolates {name} placeholders and leaves unknown ones in place', () => {
    expect(interpolate('Hi {name}, {count} new', { name: 'Ada', count: 2 })).toBe('Hi Ada, 2 new');
    expect(interpolate('{ name } / {missing} / {empty}', { name: 'Bo', empty: null })).toBe('Bo / {missing} / {empty}');
    expect(interpolate('{toString}', {})).toBe('{toString}');
    expect(interpolate('No params {x}')).toBe('No params {x}');
  });

  it('falls back from the locale to its base language, then the default locale, then the key', () => {
    expect(localeFallbackChain(tables, 'fr-CA')).toEqual(['fr-CA', 'fr', 'en']);
    expect(localeFallbackChain(tables, 'de')).toEqual(['en']);

    expect(translate(tables, 'fr-CA', 'menu.play')).toBe('Jouer!');
    expect(translate(tables, 'fr-CA', 'hud.score', { score: 10 })).toBe('Points : 10');
    expect(translate(tables, 'fr', 'only.en')).toBe('English only');
    // Empty text is untranslated, so the default locale answers.
    expect(translate(tables, 'fr', 'hud.greeting', { name: 'Zoé' })).toBe('Hello, Zoé!');
    expect(translate(tables, 'fr', 'missing.key')).toBe('missing.key');
    expect(translate(tables, 'fr', 'toString')).toBe('toString');
    expect(translate(tables, null, 'menu.play')).toBe('Play');
  });
});

describe('localization store', () => {
  it('loads tables, resolves the player locale and persists the choice', () => {
    const storage = memoryStorage();
    const store = createLocalizationStore({ storage, storageKey: 'test.locale' });
    expect(store.t('menu.play')).toBe('menu.play');

    store.load({ id: LOCALIZATION_DOCUMENT_ID, settings: tables });
    expect(store.getSnapshot().locale).toBe('en');
    expect(store.getSnapshot().locales).toEqual(['en', 'fr', 'fr-CA']);

    expect(store.setLocale('fr')).toBe(true);
    expect(storage.getItem('test.locale')).toBe('fr');
    expect(store.t('hud.score', { score: 3 })).toBe('Points : 3');

    expect(store.setLocale('not a locale')).toBe(false);
    expect(store.getSnapshot().locale).toBe('fr');

    expect(store.setLocale(null)).toBe(true);
    expect(storage.getItem('test.locale')).toBeNull();
    expect(store.t('menu.play')).toBe('Play');
  });

  it('applies a remembered locale once tables containing it are loaded', () => {
    const store = createLocalizationStore({ storage: memoryStorage({ 'auvra.locale': 'fr-BE' }) });
    expect(store.getSnapshot()).toMatchObject({ locale: 'en', preferredLocale: 'fr-BE' });

    store.load(tables);
    // fr-BE is not authored, so its base language fr is used.
    expect(store.getSnapshot().locale).toBe('fr');
    expect(store.t('menu.play')).toBe('Jouer');

    store.reset();
    expect(store.getSnapshot()).toMatchObject({ locale: 'en', preferredLocale: 'fr-BE' });
  });

  it('keeps snapshots stable between changes and tolerates blocked storage', () => {
    const blocked = memoryStorage();
    blocked.setItem = () => { throw new Error('quota'); };
    const store = createLocalizationStore({ storage: blocked });
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    store.load(tables);
    expect(store.setLocale('fr')).toBe(true);
    expect(store.getSnapshot()).not.toBe(first);
    expect(store.getSnapshot().locale).toBe('fr');
  });

  it('re-renders hooks when the tables or locale change', () => {
    const store = createLocalizationStore({ storage: null });
    const { result } = renderHook(() => ({ t: useTranslation(store), locale: useLocale(store) }));
    expect(result.current.t('menu.play')).toBe('menu.play');

    act(() => { store.load(tables); });
    expect(result.current.t('menu.play')).toBe('Play');
    expect(result.current.locale.locales).toEqual(['en', 'fr', 'fr-CA']);
    expect(result.current.locale.defaultLocale).toBe('en');

    act(() => { result.current.locale.setLocale('fr-CA'); });
    expect(result.current.locale.locale).toBe('fr-CA');
    expect(result.current.t('menu.play')).toBe('Jouer!');
  });

  it('exposes t() bound to the shared store', () => {
    localization.load(tables);
    localization.setLocale('fr');
    expect(t('hud.score', { score: 9 })).toBe('Points : 9');
    localization.reset();
    expect(t('hud.score')).toBe('hud.score');
  });
});
