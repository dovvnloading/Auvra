import { useCallback, useSyncExternalStore } from 'react';

/** Stored in the project 'metadata' domain as the document { id: LOCALIZATION_DOCUMENT_ID, settings }. */
export const LOCALIZATION_DOCUMENT_ID = 'localization';

export const DEFAULT_LOCALE = 'en';

/** Key -> text for one locale. Text may contain {name} placeholders. */
export type StringTable = Record<string, string>;

export interface LocalizationSettings {
    defaultLocale: string;
    /** Locale code (e.g. 'en', 'fr-CA') -> string table. Always contains defaultLocale. */
    locales: Record<string, StringTable>;
}

export interface LocalizationDocument {
    id: string;
    settings: LocalizationSettings;
}

export type TranslationParams = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** fallback is the text used (with params) while no locale has the key, e.g. the English for a built-in string. */
export type Translate = (key: string, params?: TranslationParams, fallback?: string) => string;

export const createDefaultLocalizationDocument = (): LocalizationDocument => ({
    id: LOCALIZATION_DOCUMENT_ID,
    settings: { defaultLocale: DEFAULT_LOCALE, locales: { [DEFAULT_LOCALE]: {} } },
});

const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8}){0,3}$/;
const MAX_KEY_LENGTH = 200;
// Names that would reach Object.prototype through a plain object lookup or assignment.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const hasOwn = (target: object, key: string): boolean => Object.prototype.hasOwnProperty.call(target, key);

/** BCP 47 style codes such as 'en', 'pt-BR' or 'zh-Hant-TW'. */
export const isValidLocale = (value: unknown): value is string =>
    typeof value === 'string' && LOCALE_PATTERN.test(value) && !RESERVED_KEYS.has(value);

/** Keys are non-empty, at most 200 characters and have no leading or trailing whitespace ('hud.score', 'menu.play'). */
export const isValidStringKey = (value: unknown): value is string =>
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_KEY_LENGTH
    && value === value.trim()
    && !RESERVED_KEYS.has(value);

const normalizeTable = (value: unknown): StringTable => {
    const table: StringTable = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return table;
    for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
        if (isValidStringKey(key) && typeof text === 'string') table[key] = text;
    }
    return table;
};

/** Makes any stored value runtime-safe: drops invalid locales, keys and non-string text, and guarantees the default locale exists. */
export const normalizeLocalizationSettings = (value: unknown): LocalizationSettings => {
    const stored = (value && typeof value === 'object' ? value : {}) as { defaultLocale?: unknown; locales?: unknown };
    const locales: Record<string, StringTable> = {};
    if (stored.locales && typeof stored.locales === 'object' && !Array.isArray(stored.locales)) {
        for (const [locale, table] of Object.entries(stored.locales as Record<string, unknown>)) {
            if (isValidLocale(locale)) locales[locale] = normalizeTable(table);
        }
    }
    const defaultLocale = isValidLocale(stored.defaultLocale)
        ? stored.defaultLocale
        : Object.keys(locales)[0] ?? DEFAULT_LOCALE;
    if (!hasOwn(locales, defaultLocale)) locales[defaultLocale] = {};
    return { defaultLocale, locales };
};

/** Finds the localization document among the project's metadata documents. */
export const localizationSettingsFromDocuments = (documents: readonly unknown[] | null | undefined): LocalizationSettings => {
    const found = (documents ?? []).find((candidate) => (
        Boolean(candidate) && typeof candidate === 'object' && (candidate as { id?: unknown }).id === LOCALIZATION_DOCUMENT_ID
    )) as { settings?: unknown } | undefined;
    return normalizeLocalizationSettings(found?.settings);
};

/** Replaces {name} placeholders with params; placeholders without a value are left as written. */
export const interpolate = (template: string, params?: TranslationParams): string => {
    if (!params) return template;
    return template.replace(/\{\s*([A-Za-z0-9_.-]+)\s*\}/g, (match, name: string) => {
        if (!hasOwn(params, name)) return match;
        const value = params[name];
        return value === null || value === undefined ? match : String(value);
    });
};

/** Locales tried in order: the requested one, its base language ('fr' for 'fr-CA'), then the default. */
export const localeFallbackChain = (settings: LocalizationSettings, locale: string | null | undefined): string[] => {
    const chain: string[] = [];
    const push = (candidate: string | null | undefined) => {
        if (candidate && hasOwn(settings.locales, candidate) && !chain.includes(candidate)) chain.push(candidate);
    };
    push(locale);
    if (locale) push(locale.split(/[-_]/)[0]);
    push(settings.defaultLocale);
    return chain;
};

/**
 * Looks up key in locale, falling back to the default locale, then to fallback and finally to the key itself.
 * Empty text counts as untranslated.
 */
export const translate = (
    settings: LocalizationSettings,
    locale: string | null | undefined,
    key: string,
    params?: TranslationParams,
    fallback?: string,
): string => {
    const missing = typeof fallback === 'string' ? interpolate(fallback, params) : null;
    if (typeof key !== 'string') return missing ?? '';
    if (!isValidStringKey(key)) return missing ?? key;
    for (const candidate of localeFallbackChain(settings, locale)) {
        const table = settings.locales[candidate];
        if (hasOwn(table, key) && table[key] !== '') return interpolate(table[key], params);
    }
    return missing ?? key;
};

/**
 * English text of the player's built-in screens (title, pause and game-over menus, the Options screen
 * and toasts). A project translates them by adding these keys in the Localization panel; a key no
 * locale has keeps showing this English.
 */
export const BUILTIN_UI_STRINGS = {
    'ui.play': 'Play',
    'ui.continue': 'Continue',
    'ui.options': 'Options',
    'ui.resume': 'Resume',
    'ui.save': 'Save',
    'ui.load': 'Load',
    'ui.quitToTitle': 'Quit to Title',
    'ui.paused': 'Paused',
    'ui.noPlayableLevel': 'This build has no playable level.',
    'ui.loading': 'Loading',
    'ui.loadingContent': 'Loading game content...',
    'ui.startFailed': 'Could not start the game',
    'ui.startFailedHint': 'Web builds must be served over http(s); opening index.html from disk does not work.',
    'ui.gameOver': 'Game Over',
    'ui.gameOver.retry': 'Retry',
    'ui.gameOver.loadLastSave': 'Load Last Save',
    'ui.toast.saved': 'Game saved',
    'ui.toast.saveFailed': 'Could not save the game',
    'ui.toast.noSave': 'No saved game to load',
    'ui.toast.missingLevel': 'Level {level} is not in this build',
    'ui.options.back': 'Back',
    'ui.options.look': 'Look',
    'ui.options.mouseSensitivity': 'Mouse sensitivity',
    'ui.options.invertY': 'Invert vertical look',
    'ui.options.language': 'Language',
    'ui.options.textLanguage': 'Text language',
    'ui.options.audio': 'Audio',
    'ui.options.volume.master': 'Master',
    'ui.options.volume.music': 'Music',
    'ui.options.volume.sfx': 'Effects',
    'ui.options.volume.ui': 'Interface',
    'ui.options.controls': 'Controls',
    'ui.options.rebind': 'Rebind',
    'ui.options.pressKey': 'Press a key...',
    'ui.options.resetControls': 'Reset controls',
    'ui.touch.move': 'Move',
    'ui.touch.look': 'Look',
    'ui.dialogue.title': 'Conversation',
    'ui.dialogue.continue': 'Continue',
    'ui.dialogue.end': 'End',
} as const satisfies StringTable;

export type BuiltinUiKey = keyof typeof BUILTIN_UI_STRINGS;

/** Translates a built-in player string; untranslated keys show the English from BUILTIN_UI_STRINGS. */
export type UiText = (key: BuiltinUiKey, params?: TranslationParams) => string;

/** Key for an input action's label on the Options screen ('ui.options.action.Jump'); its fallback is the action's own label. */
export const uiActionLabelKey = (action: string): string => `ui.options.action.${action}`;

/** Every key used by any locale, sorted. */
export const collectStringKeys = (settings: LocalizationSettings): string[] => {
    const keys = new Set<string>();
    for (const table of Object.values(settings.locales)) Object.keys(table).forEach((key) => keys.add(key));
    return [...keys].sort((a, b) => a.localeCompare(b));
};

export interface LocalizationSnapshot {
    settings: LocalizationSettings;
    /** Locale in use: the player's preference when the project has it, otherwise the default locale. */
    locale: string;
    /** The player's chosen locale, kept even while the loaded tables do not contain it. */
    preferredLocale: string | null;
    /** Available locale codes, sorted. */
    locales: readonly string[];
}

export interface LocalizationStoreOptions {
    storage?: Storage | null;
    /** localStorage key for the player's chosen locale. */
    storageKey?: string;
}

const defaultStorage = (): Storage | null => {
    try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
};

const resolveActiveLocale = (settings: LocalizationSettings, preferred: string | null): string => {
    if (preferred && hasOwn(settings.locales, preferred)) return preferred;
    if (preferred) {
        const base = preferred.split(/[-_]/)[0];
        if (hasOwn(settings.locales, base)) return base;
    }
    return settings.defaultLocale;
};

/**
 * Observable string tables plus the active locale. load() takes the project's localization settings;
 * setLocale() records the player's choice (saved to storage when available) and is resolved against
 * the loaded tables, so a choice made before the tables arrive applies once they do.
 */
export const createLocalizationStore = (options: LocalizationStoreOptions = {}) => {
    const storage = options.storage === undefined ? defaultStorage() : options.storage;
    let storageKey = options.storageKey ?? 'auvra.locale';
    const readPreferred = (): string | null => {
        try {
            const raw = storage?.getItem(storageKey) ?? null;
            return isValidLocale(raw) ? raw : null;
        } catch { return null; }
    };
    let preferred: string | null = readPreferred();
    let settings = normalizeLocalizationSettings(null);
    const listeners = new Set<() => void>();

    const build = (): LocalizationSnapshot => ({
        settings,
        locale: resolveActiveLocale(settings, preferred),
        preferredLocale: preferred,
        locales: Object.keys(settings.locales).sort((a, b) => a.localeCompare(b)),
    });
    let snapshot = build();

    const commit = () => {
        snapshot = build();
        listeners.forEach((listener) => listener());
    };

    const store = {
        /** Stable until the next change, so it is safe for useSyncExternalStore. */
        getSnapshot: (): LocalizationSnapshot => snapshot,
        /** Replaces the string tables with the project's localization settings (or a document carrying them). */
        load(value: unknown) {
            const source = value && typeof value === 'object' && 'settings' in value
                ? (value as { settings?: unknown }).settings
                : value;
            settings = normalizeLocalizationSettings(source);
            commit();
        },
        /** Records the player's locale; null follows the project's default. Returns false for an invalid code. */
        setLocale(locale: string | null): boolean {
            if (locale !== null && !isValidLocale(locale)) return false;
            if (locale === preferred) return true;
            preferred = locale;
            try {
                if (locale === null) storage?.removeItem(storageKey);
                else storage?.setItem(storageKey, locale);
            } catch { /* storage full or blocked: keep the choice in memory */ }
            commit();
            return true;
        },
        /** Keeps the player's locale under a per-game key (games built from different projects share a web origin). */
        scopeToGame(gameId: string) {
            const key = `auvra.locale.${gameId}`;
            if (key === storageKey) return;
            storageKey = key;
            preferred = readPreferred();
            commit();
        },
        /** Translates in the active locale; fallback is shown while no locale has the key. */
        t(key: string, params?: TranslationParams, fallback?: string): string {
            return translate(snapshot.settings, snapshot.locale, key, params, fallback);
        },
        /** Clears the tables back to an empty default; the player's preference is kept. */
        reset() {
            settings = normalizeLocalizationSettings(null);
            commit();
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
    return store;
};

export type LocalizationStore = ReturnType<typeof createLocalizationStore>;

/** Shared store for the running game and editor previews. */
export const localization = createLocalizationStore();

/** Translates with the shared store; for code outside React. Components should use useTranslation so they re-render on locale changes. */
export const t: Translate = (key, params, fallback) => localization.t(key, params, fallback);

/** Built-in player text from the shared store, for event handlers and other code outside render. */
export const uiText: UiText = (key, params) => localization.t(key, params, BUILTIN_UI_STRINGS[key]);

export interface LocaleState {
    locale: string;
    defaultLocale: string;
    preferredLocale: string | null;
    locales: readonly string[];
    setLocale: (locale: string | null) => boolean;
}

/** Active locale and the available locales; re-renders when either changes. */
export const useLocale = (store: LocalizationStore = localization): LocaleState => {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const setLocale = useCallback((locale: string | null) => store.setLocale(locale), [store]);
    return {
        locale: snapshot.locale,
        defaultLocale: snapshot.settings.defaultLocale,
        preferredLocale: snapshot.preferredLocale,
        locales: snapshot.locales,
        setLocale,
    };
};

/** A t() bound to the current snapshot, so components re-render when tables or the locale change. */
export const useTranslation = (store: LocalizationStore = localization): Translate => {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return useCallback<Translate>(
        (key, params, fallback) => translate(snapshot.settings, snapshot.locale, key, params, fallback),
        [snapshot],
    );
};

/** Built-in player text bound to the current snapshot; re-renders on locale or table changes like useTranslation. */
export const useUiText = (store: LocalizationStore = localization): UiText => {
    const translateKey = useTranslation(store);
    return useCallback<UiText>((key, params) => translateKey(key, params, BUILTIN_UI_STRINGS[key]), [translateKey]);
};
