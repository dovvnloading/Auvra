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

it('previews a measurement fit, then saves only its coefficients together with existing overrides', () => {
    const save = vi.fn();
    const component: LevelComponent = { id: 'fit', type: 'garment', enabled: true,
        props: { fabric: 'linen', fabricProperties: { damping: 4 } } };
    render(<GarmentFabricControls component={component} onChangeProps={save} />);
    fireEvent.click(screen.getByText('Fabric properties'));
    fireEvent.click(screen.getByText('Fit from swatch measurements'));
    const source = screen.getByLabelText('Swatch measurements');
    const header = 'test,width_mm,gauge_mm,displacement_mm,force_n,mass_g';
    fireEvent.change(source, { target: { value: header + '\nmass,100,100,,,2.4' } });
    expect(screen.getByRole('table')).toHaveTextContent('240 g/m²');
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply fitted properties' }));
    expect(save).toHaveBeenCalledTimes(1);
    const applied = save.mock.calls[0][0].fabricProperties;
    expect(applied.arealDensity).toBeCloseTo(.24, 12);
    expect(applied.damping).toBe(4);
    expect(applied.warp).toBeUndefined();
    fireEvent.change(source, { target: { value: header + '\nwarp,0,100,2,1,' } });
    expect(screen.getByRole('alert')).toHaveTextContent('positive unloaded dimensions');
    expect(screen.queryByRole('button', { name: 'Apply fitted properties' })).toBeNull();
});
