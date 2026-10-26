import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  BUILTIN_UI_STRINGS,
  LOCALIZATION_DOCUMENT_ID,
  createLocalizationStore,
  localization,
  translate,
  uiActionLabelKey,
  uiText,
  type LocalizationSettings,
} from '../../runtime/localization';
import { createPlayerOptionsStore, defaultPlayerOptions } from '../../runtime/playerOptions';
import { DEFAULT_GAME_SETTINGS, type RuntimeHost } from '../../runtime/types';
import { gameState } from '../../runtime/gameState';
import { OptionsMenu } from '../../player/OptionsMenu';

const runtimeProps = vi.hoisted(() => ({ current: null as { host: RuntimeHost } | null }));

vi.mock('../../runtime/LevelRuntime', () => ({
  LevelRuntime: (props: { host: RuntimeHost }) => {
    runtimeProps.current = props;
    return <div data-testid="level-runtime" />;
  },
}));

const french: LocalizationSettings = {
  defaultLocale: 'en',
  locales: {
    en: {},
    fr: {
      'ui.play': 'Jouer',
      'ui.options': 'Options du jeu',
      'ui.paused': 'Pause',
      'ui.resume': 'Reprendre',
      'ui.gameOver': 'Partie terminée',
      'ui.toast.missingLevel': 'Niveau {level} absent',
      'ui.options.volume.music': 'Musique',
      'ui.options.back': '',
      [uiActionLabelKey('Jump')]: 'Sauter',
    },
  },
};

vi.mock('../../player/gamePack', () => ({
  loadGamePack: async () => ({
    manifest: { gameId: 'l10n-test', name: 'Demo Game', startupLevelId: 'level-1' },
    domains: { metadata: [{ id: LOCALIZATION_DOCUMENT_ID, settings: french }], hud: [] },
    resolveAssetUrl: async (id: string) => id,
    dispose: () => undefined,
  }),
}));

vi.mock('../../utils/projectHydration', () => ({
  loadGameContent: async () => ({
    content: {},
    levels: [{ id: 'level-1', name: 'Level 1' }],
    objects: [],
    hud: null,
    settings: { ...DEFAULT_GAME_SETTINGS, startupLevelId: 'level-1' },
  }),
}));

beforeEach(() => {
  window.localStorage.clear();
  runtimeProps.current = null;
  gameState.reset();
});

afterEach(() => {
  localization.reset();
  localization.setLocale(null);
});

describe('translation fallback', () => {
  it('uses the fallback (with params) only while no locale has the key', () => {
    expect(translate(french, 'fr', 'ui.play', undefined, 'Play')).toBe('Jouer');
    expect(translate(french, 'fr', 'ui.continue', undefined, 'Continue')).toBe('Continue');
    expect(translate(french, 'en', 'ui.play', undefined, 'Play')).toBe('Play');
    // Empty text is untranslated, so the fallback answers.
    expect(translate(french, 'fr', 'ui.options.back', undefined, 'Back')).toBe('Back');
    expect(translate(french, 'fr', 'ui.x', { n: 2 }, '{n} left')).toBe('2 left');
    expect(translate(french, 'fr', ' bad key', undefined, 'Shown')).toBe('Shown');
    // Without a fallback the key is still the last resort.
    expect(translate(french, 'fr', 'ui.continue')).toBe('ui.continue');

    const store = createLocalizationStore({ storage: null });
    store.load(french);
    store.setLocale('fr');
    expect(store.t('ui.toast.missingLevel', { level: 'cave' }, 'Level {level} is not in this build')).toBe('Niveau cave absent');
  });

  it('keeps every built-in string under the ui. prefix with English text', () => {
    for (const [key, english] of Object.entries(BUILTIN_UI_STRINGS)) {
      expect(key.startsWith('ui.')).toBe(true);
      expect(english.trim()).not.toBe('');
    }
    expect(uiText('ui.quitToTitle')).toBe('Quit to Title');
    localization.load(french);
    localization.setLocale('fr');
    expect(uiText('ui.play')).toBe('Jouer');
    expect(uiText('ui.quitToTitle')).toBe('Quit to Title');
  });
});

describe('OptionsMenu', () => {
  it('shows translated labels and English for untranslated keys', () => {
    const store = createPlayerOptionsStore('l10n-options', defaultPlayerOptions(DEFAULT_GAME_SETTINGS), null);
    render(<OptionsMenu store={store} onClose={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'Options' })).toBeInTheDocument();
    expect(screen.getByText('Music')).toBeInTheDocument();
    expect(screen.getByText('Jump')).toBeInTheDocument();

    act(() => {
      localization.load(french);
      localization.setLocale('fr');
    });
    expect(screen.getByRole('heading', { name: 'Options du jeu' })).toBeInTheDocument();
    expect(screen.getByText('Musique')).toBeInTheDocument();
    expect(screen.getByText('Sauter')).toBeInTheDocument();
    // Untranslated keys keep the English, including one whose text is empty.
    expect(screen.getByText('Effects')).toBeInTheDocument();
    expect(screen.getByText('Move forward')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.getByText('Language')).toBeInTheDocument();
    expect(screen.queryByText(/^ui\./)).toBeNull();
  });
});

describe('PlayerApp built-in menus', () => {
  it('translates the title, pause and game-over menus and toasts from the project tables', async () => {
    window.localStorage.setItem('auvra.locale.l10n-test', 'fr');
    const { PlayerApp } = await import('../../player/PlayerApp');
    render(<PlayerApp />);

    expect(await screen.findByRole('button', { name: 'Jouer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Options du jeu' })).toBeInTheDocument();
    expect(screen.queryByText(/^ui\./)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Jouer' }));
    expect(await screen.findByTestId('level-runtime')).toBeInTheDocument();
    const host = runtimeProps.current!.host;

    act(() => { host.requestPause(); });
    expect(screen.getByRole('heading', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reprendre' })).toBeInTheDocument();
    // Untranslated pause entries fall back to English.
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quit to Title' })).toBeInTheDocument();

    act(() => { host.openLevel('cave'); });
    expect(screen.getByText('Niveau cave absent')).toBeInTheDocument();

    act(() => { gameState.update({ player: { health: 0 } }); });
    expect(screen.getByRole('heading', { name: 'Partie terminée' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load Last Save' })).toBeInTheDocument();
    expect(screen.queryByText(/^ui\./)).toBeNull();
  });
});
