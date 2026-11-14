import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ParticlesInspector } from '../../components/Environment/ParticlesInspector';
import { MAX_PARTICLE_FORCE_FIELDS, resolveParticleEffect } from '../../runtime/particleEffect';
import type { LevelComponent, LevelObject } from '../../types';

vi.mock('../../context/SceneContext', () => ({ useScene: () => ({ textures: [] }) }));

const object: LevelObject = {
    id: 'torch', levelId: 'scene', modelId: '', name: 'Torch', type: 'prop',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
};
const component: LevelComponent = { id: 'smoke', type: 'particles', enabled: true, props: { preset: 'smoke', rate: 17 } };

describe('particle force fields in the inspector', () => {
    it('adds independent fields, edits the selected field and preserves the original emitter', () => {
        const edits = vi.fn();
        function Inspector() {
            const [current, setCurrent] = useState(component);
            return <ParticlesInspector object={object} component={current} onChangeProps={patch => {
                edits(patch);
                setCurrent({ ...current, props: { ...current.props, ...patch } });
            }} />;
        }
        render(<Inspector />);
        fireEvent.click(screen.getByText('Force fields'));
        const add = () => screen.getByRole('button', { name: /Add force field/ });
        fireEvent.click(add());
        const first = within(screen.getByRole('group', { name: 'Field 1' }));
        expect(first.queryByLabelText('Axis X')).toBeNull();
        fireEvent.change(first.getByLabelText('Field type'), { target: { value: 'vortex' } });
        const setNumber = (label: string, number: number) => {
            const input = first.getByLabelText(label);
            fireEvent.change(input, { target: { value: String(number) } });
            fireEvent.blur(input);
        };
        setNumber('Axis Z', 0.5);
        setNumber('Center (m) X', -3);
        setNumber('Field strength', -18);
        setNumber('Field radius', 4);
        setNumber('Field falloff', 0);
        fireEvent.click(first.getByLabelText('Field enabled'));
        for (let i = 1; i < MAX_PARTICLE_FORCE_FIELDS; i++) fireEvent.click(add());
        expect(add()).toBeDisabled();
        const currentEffect = () => resolveParticleEffect(edits.mock.lastCall![0]);
        const effect = currentEffect();
        expect(effect.rate).toBe(17);
        expect(effect.forceFields[0]).toMatchObject({
            kind: 'vortex', center: [-3, 0, 0], axis: [0, 1, 0.5], strength: -18, radius: 4, falloff: 0, enabled: false,
        });
        expect(effect.forceFields[1]).toMatchObject({ kind: 'radial', enabled: true });
        fireEvent.click(first.getByRole('button', { name: 'Remove field 1' }));
        expect(add()).toBeEnabled();
        expect(currentEffect().forceFields).toEqual(effect.forceFields.slice(1));
        expect(first.queryByLabelText('Axis Z')).toBeNull();
    });
});
