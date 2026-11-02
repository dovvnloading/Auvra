import React from 'react';
import { Button } from '../../UI/kit';
import { terrainToolStore, useTerrainToolState, type TerrainToolSettings } from './terrainTool';

/** Says so when a region is limiting the brushes, wherever a brush is up: otherwise they just seem not to work. */
export const TerrainRegionNote: React.FC<{ settings: TerrainToolSettings }> = ({ settings }) => {
    const { hasRegion } = useTerrainToolState();
    if (!hasRegion || !settings.regionLimit) return null;
    return (
        <div className="mt-1.5 flex items-center justify-between gap-2">
            <p className="text-2xs leading-relaxed text-ink-2">{settings.regionInvert ? 'Brushes only change the ground outside the region.' : 'Brushes only change the ground in the region.'}</p>
            <Button size="sm" onClick={() => terrainToolStore.command({ kind: 'clear-region' })}>Clear</Button>
        </div>
    );
};
