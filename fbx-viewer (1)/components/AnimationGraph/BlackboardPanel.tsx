
import React, { useState } from 'react';
import { AnimationGraphData } from '../../types';
import { BlackboardInputs } from './panels/BlackboardInputs';
import { BlackboardVariables } from './panels/BlackboardVariables';
import { Select } from '../UI/Select';

interface BlackboardPanelProps {
    graph: AnimationGraphData;
    modelId: string;
    updateGraph: (modelId: string, data: Partial<AnimationGraphData>) => void;
}

export const BlackboardPanel: React.FC<BlackboardPanelProps> = ({ graph, modelId, updateGraph }) => {
    const [activeTab, setActiveTab] = useState('variables');

    const options = [
        { label: 'Variables', value: 'variables' },
        { label: 'Input Mappings', value: 'inputs' }
    ];

    return (
        <div className="flex-1 flex flex-col min-h-0 bg-gray-900">
            {/* Header / Selector */}
            <div className="p-3 border-b border-gray-800 bg-gray-950 shrink-0">
                <label className="text-[10px] uppercase text-gray-500 font-bold tracking-wider mb-1.5 block">
                    Blackboard Section
                </label>
                <Select 
                    value={activeTab}
                    onChange={(val) => setActiveTab(String(val))}
                    options={options}
                />
            </div>

            <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
                {activeTab === 'inputs' && (
                    <BlackboardInputs 
                        graph={graph} 
                        modelId={modelId} 
                        updateGraph={updateGraph} 
                    />
                )}
                {activeTab === 'variables' && (
                    <BlackboardVariables 
                        graph={graph} 
                        modelId={modelId} 
                        updateGraph={updateGraph} 
                    />
                )}
            </div>
        </div>
    );
};
