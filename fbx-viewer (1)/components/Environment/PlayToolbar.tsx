import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Play, RefreshCw, RotateCcw, Search, Square, StepForward } from 'lucide-react';
import type { InspectedObject, RuntimeInspector } from '../../runtime/PauseController';

interface PlayToolbarProps {
    paused: boolean;
    onResume: () => void;
    onStep: () => void;
    onRestart: () => void;
    onStop: () => void;
    /** Reads the running scene; null before the runtime has mounted. */
    inspect: () => RuntimeInspector | null;
    /** Names of the level's objects by id, for the inspector. */
    objectNames: ReadonlyMap<string, string>;
    /** Bumps after each step so the inspector shows the new frame. */
    frame: number;
}

const BUTTON = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

const formatVector = (values: readonly number[], digits: number) => values.map(value => value.toFixed(digits)).join(', ');

/**
 * Play-in-editor controls. While the game runs the pointer is captured, so only a hint shows; once
 * paused (Escape) the bar offers Resume (F8), Step one frame (F10), Restart and Stop (Escape), and an
 * inspector listing every level object's live world transform.
 */
export const PlayToolbar: React.FC<PlayToolbarProps> = ({ paused, onResume, onStep, onRestart, onStop, inspect, objectNames, frame }) => {
    const [inspectorOpen, setInspectorOpen] = useState(false);
    const [filter, setFilter] = useState('');
    const [objects, setObjects] = useState<InspectedObject[]>([]);

    const refresh = useCallback(() => {
        const reader = inspect();
        setObjects(reader ? reader() : []);
    }, [inspect]);

    // A paused frame does not change, so read it once per pause and once per step.
    useEffect(() => {
        if (paused && inspectorOpen) refresh();
    }, [paused, inspectorOpen, frame, refresh]);

    useEffect(() => {
        if (!paused) return undefined;
        const onKey = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
            if (event.key === 'Escape') { event.preventDefault(); onStop(); }
            else if (event.key === 'F8') { event.preventDefault(); onResume(); }
            else if (event.key === 'F10') { event.preventDefault(); onStep(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [paused, onResume, onStep, onStop]);

    const rows = useMemo(() => {
        const query = filter.trim().toLowerCase();
        return objects
            .map(object => ({ ...object, name: objectNames.get(object.id) ?? object.id }))
            .filter(object => !query || object.name.toLowerCase().includes(query))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [objects, objectNames, filter]);

    if (!paused) {
        return (
            <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 z-40 px-2 py-1 rounded bg-black/40 text-[10px] text-gray-400">
                Esc: pause
            </div>
        );
    }

    return (
        <>
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1 p-1 rounded-lg bg-gray-900/95 border border-gray-700 shadow-xl cursor-default" role="toolbar" aria-label="Play controls">
                <span className="flex items-center gap-1.5 px-2 text-[10px] font-bold uppercase tracking-wider text-amber-400">
                    <span className="w-2 h-2 rounded-full bg-amber-400" /> Paused
                </span>
                <button type="button" onClick={onResume} className={`${BUTTON} bg-green-700 hover:bg-green-600 text-white`} title="Resume (F8)">
                    <Play size={12} /> Resume
                </button>
                <button type="button" onClick={onStep} className={`${BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200`} title="Step one frame (F10)">
                    <StepForward size={12} /> Step
                </button>
                <button type="button" onClick={onRestart} className={`${BUTTON} bg-gray-800 hover:bg-gray-700 text-gray-200`} title="Restart the level">
                    <RotateCcw size={12} /> Restart
                </button>
                <button
                    type="button"
                    onClick={() => setInspectorOpen(open => !open)}
                    className={`${BUTTON} ${inspectorOpen ? 'bg-blue-700 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-200'}`}
                    aria-pressed={inspectorOpen}
                    title="Inspect the running objects"
                >
                    <Search size={12} /> Inspect
                </button>
                <button type="button" onClick={onStop} className={`${BUTTON} bg-red-800 hover:bg-red-700 text-white`} title="Stop and return to the editor (Esc)">
                    <Square size={12} /> Stop
                </button>
            </div>

            {inspectorOpen && (
                <div className="absolute top-14 right-2 bottom-2 z-40 w-80 flex flex-col rounded-lg bg-gray-900/95 border border-gray-700 shadow-xl cursor-default" aria-label="Runtime inspector">
                    <div className="flex items-center gap-2 p-2 border-b border-gray-700">
                        <input
                            value={filter}
                            onChange={(event) => setFilter(event.target.value)}
                            placeholder="Filter objects..."
                            className="flex-1 bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                        />
                        <button type="button" onClick={refresh} className="text-gray-400 hover:text-white" title="Read the scene again" aria-label="Refresh">
                            <RefreshCw size={12} />
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-1 space-y-1">
                        {rows.length === 0 && <div className="p-2 text-[10px] text-gray-500 italic">No drawn level objects match.</div>}
                        {rows.map(row => (
                            <div key={row.id} className="px-2 py-1.5 rounded bg-gray-800/60 text-[10px] font-mono">
                                <div className="flex items-center gap-1.5 font-sans text-xs font-bold text-gray-200">
                                    {row.visible ? <Eye size={10} className="text-gray-500" /> : <EyeOff size={10} className="text-amber-500" />}
                                    <span className="truncate">{row.name}</span>
                                </div>
                                <div className="text-gray-400">pos {formatVector(row.position, 2)}</div>
                                <div className="text-gray-500">rot {formatVector(row.rotation, 1)}</div>
                            </div>
                        ))}
                    </div>
                    <div className="p-2 border-t border-gray-700 text-[10px] text-gray-500">
                        World transforms of objects drawn as their own group (with components, children or a timeline). Step to watch them change.
                    </div>
                </div>
            )}
        </>
    );
};
