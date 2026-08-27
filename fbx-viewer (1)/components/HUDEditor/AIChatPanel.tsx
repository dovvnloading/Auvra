import React, { useEffect, useRef, useState } from 'react';
import { Bot, Box, Plus, Send, Target, Terminal } from 'lucide-react';
import { HUDElement } from './types';
import { hostProviderService, CommandProposal, InferenceJob } from '../../services/HostProviderService';

interface AIChatPanelProps {
    elements: HUDElement[];
    selectedElementId: string | null;
    onUpdateElement: (id: string, updates: Partial<HUDElement>) => void;
    onAgentCreate: (type: string, overrides: Partial<HUDElement>) => void;
    onSelectElement: (id: string | null) => void;
    onRefresh: () => void;
}

interface ChatMessage {
    role: 'user' | 'assistant';
    text: string;
}

interface ProposalState { proposal: CommandProposal; jobId: string; }

const PROVIDER_NOT_CONFIGURED = 'Describe a HUD change. The host will produce a reviewable proposal; nothing is applied automatically.';

export const AIChatPanel: React.FC<AIChatPanelProps> = ({
    elements,
    selectedElementId,
    onSelectElement,
    onRefresh
}) => {
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState<ChatMessage[]>([
        { role: 'assistant', text: PROVIDER_NOT_CONFIGURED }
    ]);
    const [proposalState, setProposalState] = useState<ProposalState | null>(null);
    const [approvedTransactionId, setApprovedTransactionId] = useState<string | null>(null);
    const [working, setWorking] = useState(false);
    const [proposalError, setProposalError] = useState<string | null>(null);
    const [activeContextId, setActiveContextId] = useState<string>('create');
    const messagesEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setActiveContextId(selectedElementId || 'create');
    }, [selectedElementId]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const waitForJob = async (initial: InferenceJob): Promise<InferenceJob> => {
        let job = initial;
        for (let attempt = 0; attempt < 120; attempt += 1) {
            if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') return job;
            if (!job.jobId) throw new Error('The host did not return a command job id.');
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
            job = await hostProviderService.getInference(job.jobId);
        }
        throw new Error('Command proposal timed out.');
    };

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();

        const request = input.trim();
        if (!request) return;

        setWorking(true); setProposalError(null); setProposalState(null);
        setMessages(previous => [...previous, { role: 'user', text: request }, { role: 'assistant', text: 'Preparing a deterministic command proposal…' }]);
        setInput('');
        try {
            const job = await hostProviderService.submitInference({
                capability: 'commands',
                input: request,
                ...(activeContextId === 'create' ? {} : { targetElementId: activeContextId }),
                consent: 'explicit',
            });
            const completed = await waitForJob(job);
            if (completed.status !== 'succeeded') throw new Error(completed.error?.message || 'The command job failed.');
            const proposal = await hostProviderService.previewCommand({ jobId: completed.jobId });
            setProposalState({ proposal, jobId: completed.jobId });
            setMessages(previous => [...previous, { role: 'assistant', text: proposal.summary || 'Proposal ready for review. No changes have been applied.' }]);
        } catch (cause) {
            setProposalError(cause instanceof Error ? cause.message : 'Command proposal failed.');
            setMessages(previous => [...previous, { role: 'assistant', text: 'No changes were applied.' }]);
        } finally { setWorking(false); }
    };

    const approveProposal = async () => {
        if (!proposalState) return;
        setWorking(true); setProposalError(null);
        try { const result = await hostProviderService.approveCommand({ proposalId: proposalState.proposal.proposalId }); const transactionId = result && typeof result === 'object' && typeof (result as { transactionId?: unknown }).transactionId === 'string' ? (result as { transactionId: string }).transactionId : null; setMessages(previous => [...previous, { role: 'assistant', text: 'Approved and applied as one host transaction.' }]); setApprovedTransactionId(transactionId); setProposalState(null); onRefresh(); }
        catch (cause) { setProposalError(cause instanceof Error ? cause.message : 'Proposal could not be approved.'); }
        finally { setWorking(false); }
    };

    const undoApprovedProposal = async () => {
        if (!approvedTransactionId) return;
        setWorking(true); setProposalError(null);
        try { await hostProviderService.undoCommand({ transactionId: approvedTransactionId }); setMessages(previous => [...previous, { role: 'assistant', text: 'Host-authoritative undo completed.' }]); setApprovedTransactionId(null); onRefresh(); }
        catch (cause) { setProposalError(cause instanceof Error ? cause.message : 'Undo is unavailable for this proposal.'); }
        finally { setWorking(false); }
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

            {proposalState && <div className="border-t border-blue-900/50 bg-blue-950/20 p-3 space-y-2">
                <div className="flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-wider text-blue-300">Review proposal</span><span className="text-[9px] text-gray-500">Job {proposalState.jobId}</span></div>
                <div className="max-h-28 overflow-auto rounded border border-gray-700 bg-gray-950 p-2 text-[10px] font-mono text-gray-300 whitespace-pre-wrap">{typeof proposalState.proposal.diff === 'string' ? proposalState.proposal.diff : JSON.stringify(proposalState.proposal.diff || proposalState.proposal.commands || {}, null, 2)}</div>
                <div className="grid grid-cols-2 gap-2"><button type="button" disabled={working} onClick={() => void approveProposal()} className="rounded bg-emerald-600 px-2 py-1.5 text-[10px] font-bold text-white disabled:opacity-50">Approve</button><button type="button" disabled={working} onClick={() => setProposalState(null)} className="rounded border border-gray-700 px-2 py-1.5 text-[10px] text-gray-300 disabled:opacity-50">Reject</button></div>
            </div>}
            {approvedTransactionId && !proposalState && <div className="border-t border-emerald-900/50 bg-emerald-950/20 p-3 flex items-center justify-between gap-2"><span className="text-[10px] text-emerald-300">Last proposal applied with host revision.</span><button type="button" disabled={working} onClick={() => void undoApprovedProposal()} className="rounded border border-amber-800 px-2 py-1 text-[10px] text-amber-300 disabled:opacity-50">Undo</button></div>}
            {proposalError && <div className="border-t border-red-900/50 bg-red-950/20 px-3 py-2 text-[10px] text-red-300">{proposalError}</div>}

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
                        disabled={!input.trim() || working}
                        className="px-3 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white border border-gray-700 rounded transition-colors disabled:opacity-50"
                    >
                        <Send size={14} />
                    </button>
                </div>
            </form>
        </div>
    );
};
