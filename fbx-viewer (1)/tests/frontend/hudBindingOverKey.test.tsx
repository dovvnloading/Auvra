import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HUDRenderer } from '../../components/HUDEditor/HUDRenderer';
import { gameState } from '../../runtime/gameState';
import { localization } from '../../runtime/localization';
import type { HUDDocumentData } from '../../runtime/types';

const element = (id: string, type: string, props: Record<string, unknown>) => ({
    id,
    name: id,
    type,
    props,
    position: { x: 0, y: 0 },
    size: { width: 200, height: 40 },
    zIndex: 1,
    isVisible: true,
    isLocked: false,
});

const hud: HUDDocumentData = {
    id: 'hud',
    elements: [
        element('score', 'Text', { text: '0', textKey: 'hud.score', color: '#fff', bind: { text: 'vars.score' } }),
        element('play', 'Button', { label: 'Play', labelKey: 'menu.play', variant: 'primary', bind: { label: 'vars.cta' } }),
        element('missing', 'Text', { text: 'authored', textKey: 'hud.score', bind: { text: 'vars.missing' } }),
        element('colored', 'Text', { text: 'x', textKey: 'hud.score', bind: { color: 'vars.tint' } }),
    ],
};

const content = (container: HTMLElement, id: string) => container.querySelector(`[data-hud-element="${id}"]`) as HTMLElement;

beforeEach(() => {
    localization.load({ defaultLocale: 'en', locales: { en: { 'hud.score': 'Score', 'menu.play': 'Start' } } });
});

afterEach(() => {
    localization.reset();
    act(() => gameState.reset());
});

describe('HUD bindings over string keys', () => {
    it('shows the live value of a bound Text or Button label while playing, even with a string key set', () => {
        act(() => gameState.update({ vars: { score: 42, cta: 'Continue', tint: '#ff0000' } }));
        const { container, rerender } = render(<HUDRenderer document={hud} bindings />);

        expect(content(container, 'score')).toHaveTextContent('42');
        expect(content(container, 'play')).toHaveTextContent('Continue');
        // An unresolved binding keeps the authored content, so the key still wins.
        expect(content(container, 'missing')).toHaveTextContent('Score');
        // A binding on another prop leaves the key in charge of the text.
        expect(content(container, 'colored')).toHaveTextContent('Score');

        act(() => gameState.update({ vars: { score: 43, cta: 'Continue', tint: '#ff0000' } }));
        expect(content(container, 'score')).toHaveTextContent('43');

        // The editor preview has no live values, so the string key is shown.
        rerender(<HUDRenderer document={hud} />);
        expect(content(container, 'score')).toHaveTextContent('Score');
        expect(content(container, 'play')).toHaveTextContent('Start');
    });

    it('shows a bound boolean as text', () => {
        act(() => gameState.update({ vars: { score: true } }));
        const { container } = render(<HUDRenderer document={hud} bindings />);
        expect(content(container, 'score')).toHaveTextContent('true');
    });
});
