import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HUDRenderer } from '../../components/HUDEditor/HUDRenderer';
import { gameState } from '../../runtime/gameState';
import type { HUDDocumentData } from '../../runtime/types';

const textElement = (id: string, props: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    type: 'Text',
    props: { color: '#fff', fontSize: 16, ...props },
    position: { x: 100, y: 50 },
    size: { width: 200, height: 40 },
    zIndex: 1,
    isVisible: true,
    isLocked: false,
    ...extra,
});

afterEach(() => {
    act(() => gameState.reset());
});

describe('HUDRenderer', () => {
    it('renders registered visible elements read-only on the logical stage', () => {
        const hud: HUDDocumentData = {
            id: 'hud',
            elements: [
                textElement('title', { text: 'SCORE' }),
                textElement('hidden', { text: 'HIDDEN' }, { isVisible: false }),
                textElement('unknown', { text: 'UNKNOWN' }, { type: 'NotRegistered' }),
                { id: 'broken' },
            ],
        };
        const { container } = render(<HUDRenderer document={hud} />);

        expect(screen.getByText('SCORE')).toBeInTheDocument();
        expect(screen.queryByText('HIDDEN')).toBeNull();
        expect(screen.queryByText('UNKNOWN')).toBeNull();

        const root = container.querySelector('[data-hud-renderer="hud"]') as HTMLElement;
        expect(root.style.pointerEvents).toBe('none');
        const stage = root.firstElementChild as HTMLElement;
        expect(stage.style.width).toBe('1920px');
        expect(stage.style.height).toBe('1080px');
        const element = container.querySelector('[data-hud-element="title"]') as HTMLElement;
        expect(element.style.pointerEvents).toBe('none');
        expect(element.style.left).toBe('100px');
        expect(element.style.top).toBe('50px');
    });

    it('overrides bound props from the game state and follows updates', () => {
        const hud: HUDDocumentData = {
            id: 'hud',
            elements: [textElement('health', { text: 'authored', bind: { text: 'player.health', color: 'vars.missing' } })],
        };
        act(() => gameState.update({ player: { health: 80 } }));
        const { container, rerender } = render(<HUDRenderer document={hud} bindings />);

        const label = () => container.querySelector('[data-hud-element="health"] div div') as HTMLElement;
        expect(label()).toHaveTextContent('80');
        // An unresolved path keeps the authored value.
        expect(label().style.color).toBe('rgb(255, 255, 255)');

        act(() => gameState.update({ player: { health: 35 } }));
        expect(label()).toHaveTextContent('35');

        // Without bindings (the editor preview) the authored value is shown.
        rerender(<HUDRenderer document={hud} />);
        expect(label()).toHaveTextContent('authored');
    });

    it('loads the HUD compiler lazily and points Custom elements at the base-relative sandbox', async () => {
        const hud: HUDDocumentData = {
            id: 'hud',
            elements: [{ ...textElement('custom', { code: 'return <div />;' }), type: 'Custom' }],
        };
        const { container } = render(<HUDRenderer document={hud} />);

        const frame = await waitFor(() => {
            const found = container.querySelector('iframe');
            expect(found).not.toBeNull();
            return found as HTMLIFrameElement;
        });
        // Vite's BASE_URL is '/' under test; packaged builds substitute their configured base.
        expect(frame.getAttribute('src')).toBe('/hud-frame.html');
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    });
});
