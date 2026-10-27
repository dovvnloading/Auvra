import React from 'react';
import { Bell, Layers, Plus, X } from 'lucide-react';
import { AnimNotify, GraphState } from '../../../types';
import { Select } from '../../UI/Select';
import { ScrubbableInput } from '../../UI/Properties/ScrubbableInput';

const NO_PLAY_RATE_PARAM_OPTIONS = [{ label: '-- None --', value: '' }];

interface SingleStateConfigProps {
    node: GraphState;
    updateState: (updates: Partial<GraphState>) => void;
    clipOptions: { label: string; value: string }[];
    /** The graph's Float variables that can drive the play rate, led by a None entry (value ''). */
    playRateParamOptions?: { label: string; value: string }[];
}

const ToggleRow: React.FC<{ label: string; checked: boolean; onChange: (checked: boolean) => void }> = ({ label, checked, onChange }) => (
    <label className="flex items-center justify-between group cursor-pointer p-2 bg-gray-900/50 rounded border border-gray-800 hover:border-gray-600 transition-colors">
        <span className="text-xs text-gray-400 font-medium">{label}</span>
        <div className={`w-8 h-4 rounded-full relative transition-colors ${checked ? 'bg-gray-200' : 'bg-gray-700'}`}>
             <div className={`absolute top-0.5 w-3 h-3 bg-gray-900 rounded-full transition-all ${checked ? 'left-4.5' : 'left-0.5'}`} style={{ left: checked ? 'calc(100% - 14px)' : '2px' }}></div>
        </div>
        <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            className="hidden"
        />
    </label>
);

/** Clip, looping, play rate, root motion and notifies for a Single state. */
export const SingleStateConfig: React.FC<SingleStateConfigProps> = ({
    node,
    updateState,
    clipOptions,
    playRateParamOptions = NO_PLAY_RATE_PARAM_OPTIONS
}) => {
    const playRate = typeof node.playRate === 'number' && Number.isFinite(node.playRate) ? node.playRate : 1;
    const notifies = node.notifies ?? [];

    const updateNotify = (id: string, updates: Partial<AnimNotify>) => {
        updateState({ notifies: notifies.map(n => n.id === id ? { ...n, ...updates } : n) });
    };

    return (
        <div className="space-y-4">
            <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
                 <div className="p-3 bg-gray-800 border-b border-gray-700">
                    <span className="text-xs font-medium text-gray-200 flex items-center gap-2">
                        <Layers size={12} className="text-gray-400" /> Animation Settings
                    </span>
                 </div>

                 <div className="p-3 space-y-4">
                    <div className="space-y-1.5">
                        <label className="text-[10px] uppercase text-gray-500 font-bold tracking-wider">Clip</label>
                        <Select
                            value={node.clipName || ''}
                            onChange={(val) => updateState({ clipName: val })}
                            options={clipOptions}
                            placeholder="-- Select Animation --"
                        />
                    </div>

                    <ToggleRow label="Loop Animation" checked={node.loop} onChange={(loop) => updateState({ loop })} />

                    <div className="space-y-1.5">
                        <label className="text-[10px] uppercase text-gray-500 font-bold tracking-wider">Play Rate</label>
                        <ScrubbableInput
                            label="Rate"
                            labelWidth="w-10"
                            step={0.05}
                            value={playRate}
                            onChange={(val) => {
                                if (Number.isFinite(val)) updateState({ playRate: val });
                            }}
                        />
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-[10px] uppercase text-gray-500 font-bold tracking-wider">Play Rate Variable</label>
                        <Select
                            value={node.playRateParam ?? ''}
                            onChange={(val) => updateState({ playRateParam: val === '' ? undefined : val })}
                            options={playRateParamOptions}
                            placeholder="Play Rate Variable"
                        />
                        <p className="text-[10px] text-gray-600">Multiplies the play rate each frame. A negative rate plays the clip backwards.</p>
                    </div>

                    <ToggleRow label="Root Motion" checked={!!node.rootMotion} onChange={(rootMotion) => updateState({ rootMotion })} />
                 </div>
            </div>

            {/* Notifies List */}
            <div className="space-y-3">
                <div className="flex items-center justify-between px-1">
                    <label className="text-[10px] uppercase text-gray-500 font-bold tracking-wider flex items-center gap-1.5">
                        <Bell size={10} /> Notifies
                    </label>
                    <button
                        onClick={() => {
                            const newNotify: AnimNotify = { id: crypto.randomUUID(), name: `Notify ${notifies.length + 1}`, time: 0 };
                            updateState({ notifies: [...notifies, newNotify] });
                        }}
                        aria-label="Add notify"
                        className="text-[10px] px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 text-gray-300 hover:text-white transition-colors flex items-center gap-1"
                    >
                        <Plus size={10} /> Add
                    </button>
                </div>

                <div className="space-y-2">
                    {notifies.map((notify) => (
                        <div key={notify.id} className="bg-gray-800 rounded-lg border border-gray-700 p-2 space-y-2">
                            <div className="flex items-center gap-2">
                                <input
                                    value={notify.name}
                                    onChange={(e) => updateNotify(notify.id, { name: e.target.value })}
                                    aria-label="Notify name"
                                    className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-[10px] text-white focus:border-gray-500 focus:outline-none"
                                />
                                <button
                                    onClick={() => updateState({ notifies: notifies.filter(n => n.id !== notify.id) })}
                                    aria-label={`Remove notify ${notify.name}`}
                                    className="text-gray-500 hover:text-red-400 p-1"
                                >
                                    <X size={12} />
                                </button>
                            </div>
                            <ScrubbableInput
                                label="Time"
                                labelWidth="w-10"
                                step={0.01}
                                value={Number.isFinite(notify.time) ? notify.time : 0}
                                onChange={(val) => {
                                    if (Number.isFinite(val)) updateNotify(notify.id, { time: Math.max(0, val) });
                                }}
                            />
                        </div>
                    ))}
                    {notifies.length === 0 && (
                        <div className="text-center py-4 border border-dashed border-gray-800 rounded bg-gray-900/50">
                            <p className="text-[10px] text-gray-600">No notifies. Each one raises a named event when playback reaches its time (seconds).</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
