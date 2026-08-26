import React, { useEffect, useRef, useState } from 'react';
import { Bot, Box, Plus, Send, Target, Terminal } from 'lucide-react';
import { HUDElement } from './types';

interface AIChatPanelProps {
    elements: HUDElement[];
    selectedElementId: string | null;
    onUpdateElement: (id: string, updates: Partial<HUDElement>) => void;
    onAgentCreate: (type: string, overrides: Partial<HUDElement>) => void;
    onSelectElement: (id: string | null) => void;
}

interface ChatMessage {
    role: 'user' | 'assistant';
    text: string;
}

const PROVIDER_NOT_CONFIGURED =
    'HUD assistant provider is not configured. Add a text provider before using the assistant.';

export const AIChatPanel: React.FC<AIChatPanelProps> = ({
    elements,
    selectedElementId,
    onSelectElement
}) => {
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState<ChatMessage[]>([
        { role: 'assistant', text: PROVIDER_NOT_CONFIGURED }
    ]);
    const [activeContextId, setActiveContextId] = useState<string>('create');
    const messagesEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setActiveContextId(selectedElementId || 'create');
    }, [selectedElementId]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const handleSubmit = (event: React.FormEvent) => {
        event.preventDefault();

        const request = input.trim();
        if (!request) return;

        setMessages(previous => [
            ...previous,
            { role: 'user', text: request },
            { role: 'assistant', text: PROVIDER_NOT_CONFIGURED }
        ]);
        setInput('');
    };

    const modeClassName =
        activeContextId === 'create'
            ? 'bg-gray-800 border-gray-700 text-gray-400'
            : 'bg-blue-900/20 border-blue-800/50 text-blue-300';

    return (
        <div className="flex flex-col h-full bg-gray-900 border-t border-gray-800">
            <div className="p-4 bg-gray-800/30 border-b border-gray-800 space-y-3 shrink-0">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded bg-gray-900 border border-gray-700 flex items-center justify-center shrink-0">
                        <Terminal size={16} className="text-blue-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                            Assistant Context Target
                        </h3>
                    </div>
                </div>

                <div className="relative">
                    <select
                        value={activeContextId}
                        onChange={(event) => {
                            const value = event.target.value;
                            setActiveContextId(value);
                            onSelectElement(value === 'create' ? null : value);
                        }}
                        className="w-full bg-gray-900 border border-gray-700 text-xs text-white rounded px-2 py-1.5 focus:border-blue-500 focus:outline-none appearance-none"
                    >
                        <option value="create">Create New Element</option>
                        {elements.length > 0 && <option disabled>--- EDITING ---</option>}
                        {elements.map(element => (
                            <option key={element.id} value={element.id}>
                                {element.name} ({element.type})
                            </option>
                        ))}
                    </select>
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-gray-500">
                        <Target size={10} />
                    </div>
                </div>

                <div className={'text-[9px] px-2 py-1 rounded border flex items-center justify-between ' + modeClassName}>
                    <span className="font-bold uppercase tracking-wider">
                        {activeContextId === 'create' ? 'MODE: GENERATION' : 'MODE: MODIFICATION'}
                    </span>
                    {activeContextId === 'create' ? <Plus size={10} /> : <Box size={10} />}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-gray-900">
                {messages.map((message, index) => {
                    const messageClassName =
                        message.role === 'user'
                            ? 'bg-blue-900/20 border-blue-900/50'
                            : 'bg-gray-800 border-gray-700';

                    return (
                        <div
                            key={message.role + '-' + index}
                            className={'p-2 rounded-md text-xs leading-relaxed border ' + messageClassName}
                        >
                            <div className="flex items-center gap-2 mb-1 opacity-50 text-[9px] font-bold uppercase tracking-wider">
                                {message.role === 'user' ? (
                                    <span className="text-blue-300">User Input</span>
                                ) : (
                                    <span className="text-gray-400 flex items-center gap-1">
                                        <Bot size={8} /> System
                                    </span>
                                )}
                            </div>
                            <div className="text-gray-200">{message.text}</div>
                        </div>
                    );
                })}
                <div ref={messagesEndRef} />
            </div>

            <form onSubmit={handleSubmit} className="p-3 bg-gray-950 border-t border-gray-800">
                <div className="relative flex gap-2">
                    <input
                        type="text"
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        placeholder={
                            activeContextId === 'create'
                                ? 'Describe UI to generate...'
                                : 'Describe changes...'
                        }
                        className="flex-1 bg-gray-900 border border-gray-700 hover:border-gray-600 rounded px-3 py-2 text-xs text-white focus:outline-none focus:border-blue-500 transition-colors"
                    />
                    <button
                        type="submit"
                        disabled={!input.trim()}
                        className="px-3 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white border border-gray-700 rounded transition-colors disabled:opacity-50"
                    >
                        <Send size={14} />
                    </button>
                </div>
            </form>
        </div>
    );
};
