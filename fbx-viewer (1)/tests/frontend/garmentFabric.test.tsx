import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { GarmentFabricControls } from '../../components/Environment/GarmentFabricControls';
import { readFabricOverrides } from '../../runtime/garments/fitting';
import type { LevelComponent } from '../../types';

it('writes SI coefficients as one property change, preserves other overrides, and restores the preset', () => {
    const saved = vi.fn();
    function Editor() {
        const [props, setProps] = useState<LevelComponent['props']>({ fabric: 'linen', fabricProperties: { warp: 1600 } });
        return <GarmentFabricControls component={{ id: 'fit', type: 'garment', enabled: true, props }}
            onChangeProps={patch => { saved(patch); setProps({ ...props, ...patch }); }} />;
    }
    render(<Editor />);
    fireEvent.click(screen.getByText('Fabric properties'));
    const density = screen.getByLabelText('Areal density (g/m²)');
    expect(density).toHaveValue(220);
    fireEvent.change(density, { target: { value: '295' } });
    fireEvent.blur(density);
    expect(saved).toHaveBeenCalledExactlyOnceWith({ fabricProperties: { arealDensity: .295, warp: 1600 } });
    expect(screen.getByLabelText('Areal density (g/m²)')).toHaveValue(295);
    const bend = screen.getByLabelText('Bending stiffness (µN·m)');
    fireEvent.change(bend, { target: { value: '-5' } });
    fireEvent.blur(bend);
    expect(screen.getByRole('alert')).toHaveTextContent('Bending stiffness');
    expect(saved).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Restore preset values' }));
    expect(screen.getByLabelText('Warp stiffness (N/m)')).toHaveValue(2600);
    expect(screen.queryByRole('alert')).toBeNull();
});

it('drops invalid and redundant imported values while preserving explicit zero stiffness', () => {
    expect(readFabricOverrides('linen', { warp: 2600, weft: -1, shear: 0, bend: NaN,
        arealDensity: '100', gravity: 200 })).toEqual({ shear: 0 });
    expect(readFabricOverrides('cotton', { warp: 1800 })).toBeUndefined();
});
