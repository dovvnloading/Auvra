import React from 'react';
import { Layers } from 'lucide-react';
import { GraphState } from '../../../types';
import { Select } from '../../UI/Select';

interface SingleStateConfigProps {
    node: GraphState;
    updateState: (updates: Partial<GraphState>) => void;
    clipOptions: { label: string; value: string }[];
}

export const SingleStateConfig: React.FC<SingleStateConfigProps> = ({ node, updateState, clipOptions }) => {
    return (
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
                
                <label className="flex items-center justify-between group cursor-pointer p-2 bg-gray-900/50 rounded border border-gray-800 hover:border-gray-600 transition-colors">
                    <span className="text-xs text-gray-400 font-medium">Loop Animation</span>
                    <div className={`w-8 h-4 rounded-full relative transition-colors ${node.loop ? 'bg-gray-200' : 'bg-gray-700'}`}>
                         <div className={`absolute top-0.5 w-3 h-3 bg-gray-900 rounded-full transition-all ${node.loop ? 'left-4.5' : 'left-0.5'}`} style={{ left: node.loop ? 'calc(100% - 14px)' : '2px' }}></div>
                    </div>
                    <input 
                        type="checkbox"
                        checked={node.loop}
                        onChange={(e) => updateState({ loop: e.target.checked })}
                        className="hidden"
                    />
                </label>
             </div>
        </div>
    );
};