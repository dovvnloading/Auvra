import { useCallback, useSyncExternalStore } from 'react';
import { particlePreview } from '../../runtime/particlePreview';
import { PauseIcon, PlayIcon, ResetIcon, StepForwardIcon } from '../UI/Icons';

const button = 'inline-flex items-center gap-1 rounded px-1.5 py-1 text-gray-300 hover:bg-gray-700 focus-visible:ring-1';

export const ParticlePreviewControls = ({ objectId }: { objectId: string }) => {
    const subscribe = useCallback((listener: () => void) => particlePreview.subscribe(objectId, listener), [objectId]);
    const playing = useSyncExternalStore(subscribe, () => particlePreview.isPlaying(objectId));
    return (
        <div role="group" aria-label="Particle preview" className="flex flex-wrap items-center gap-1 text-2xs">
            <span className="mr-auto font-medium text-gray-400">Particle preview</span>
            <button type="button" className={button} onClick={() => particlePreview.toggle(objectId)}>
                {playing ? <PauseIcon size={12} /> : <PlayIcon size={12} />}{playing ? 'Pause' : 'Play'}
            </button>
            <button type="button" className={button} onClick={() => particlePreview.restart(objectId)}>
                <ResetIcon size={12} />Restart
            </button>
            <button type="button" className={button} onClick={() => particlePreview.step(objectId)}>
                <StepForwardIcon size={12} />Step 1/60 s
            </button>
        </div>
    );
};
