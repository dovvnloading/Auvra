import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Send, Sparkles } from 'lucide-react';
import { HUDElement } from './types';
import { hostProviderService, CommandProposal, describeProviderFailure } from '../../services/HostProviderService';
import { AiRouteBar } from '../Settings/AiRouteBar';
import { Button, IconButton, Spinner, TextArea } from '../UI/kit';
import { Select } from '../UI/Select';

/** A proposal's effect on the HUD, to show on the canvas before anything is applied. */
export interface HUDProposalPreview {
    changed: HUDElement[];
    removed: string[];
}

interface AIChatPanelProps {
    elements: HUDElement[];
    selectedElementId: string | null;
    onUpdateElement: (id: string, updates: Partial<HUDElement>) => void;
    onAgentCreate: (type: string, overrides: Partial<HUDElement>) => void;
    onSelectElement: (id: string | null) => void;
    onRefresh: () => void;
    /** What the proposal under review would do, or null with none. */
    onPreviewChange?: (preview: HUDProposalPreview | null) => void;
}

interface ChatMessage {
    role: 'user' | 'assistant';
    text: string;
}

interface ProposalState { proposal: CommandProposal; jobId: string; }

const INTRODUCTION = 'Describe what you want on the HUD. You will see it on the canvas before anything changes.';

const CHANGE_WORDS: Record<string, string> = { create: 'Add', update: 'Change', delete: 'Remove' };

/** The host's line about one change, as a person would say it. */
export const describeHudChange = (summary: string): string => {
    const match = /^(create|update|delete) HUD element (.+)$/.exec(summary);
    return match ? `${CHANGE_WORDS[match[1]]} ${match[2]}` : summary;
};

const proposalPreview = (proposal: CommandProposal): HUDProposalPreview | null => {
    const preview = proposal.preview as { changed?: unknown; removed?: unknown } | undefined;
    if (!preview || !Array.isArray(preview.changed) || !Array.isArray(preview.removed)) return null;
    return { changed: preview.changed as HUDElement[], removed: preview.removed as string[] };
};

const proposalLines = (proposal: CommandProposal): string[] => (Array.isArray(proposal.diff) ? proposal.diff : [])
    .map((item) => (item && typeof (item as { summary?: unknown }).summary === 'string' ? describeHudChange((item as { summary: string }).summary) : ''))
    .filter(Boolean);

export const AIChatPanel: React.FC<AIChatPanelProps> = ({
    elements,
    selectedElementId,
    onSelectElement,
    onRefresh,
    onPreviewChange,
}) => {
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState<ChatMessage[]>([{ role: 'assistant', text: INTRODUCTION }]);
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
    }, [messages, working]);

    useEffect(() => {
        onPreviewChange?.(proposalState ? proposalPreview(proposalState.proposal) : null);
    }, [onPreviewChange, proposalState]);
    useEffect(() => () => onPreviewChange?.(null), [onPreviewChange]);

    const say = (text: string) => setMessages(previous => [...previous, { role: 'assistant', text }]);

    const submit = async () => {
        const request = input.trim();
        if (!request || working) return;

        setWorking(true); setProposalError(null); setProposalState(null); setApprovedTransactionId(null);
        setMessages(previous => [...previous, { role: 'user', text: request }]);
        setInput('');
        try {
            const job = await hostProviderService.submitInference({
                capability: 'commands',
                input: request,
                ...(activeContextId === 'create' ? {} : { targetElementId: activeContextId }),
                consent: 'explicit',
            });
            const completed = await hostProviderService.waitForJob(job);
            if (completed.status !== 'succeeded') throw new Error(completed.error?.message || 'The model could not work this out.');
            const proposal = await hostProviderService.previewCommand({ jobId: completed.jobId });
            setProposalState({ proposal, jobId: completed.jobId });
            say(proposal.summary || 'Here it is, for you to look over. Nothing has changed yet.');
        } catch (cause) {
            setProposalError(describeProviderFailure(cause instanceof Error ? cause.message : undefined) || 'The model could not work this out.');
            say('Nothing was changed.');
        } finally { setWorking(false); }
    };

    const approveProposal = async () => {
        if (!proposalState) return;
        setWorking(true); setProposalError(null);
        try {
            const result = await hostProviderService.approveCommand({ proposalId: proposalState.proposal.proposalId });
            const transactionId = result && typeof result === 'object' && typeof (result as { transactionId?: unknown }).transactionId === 'string' ? (result as { transactionId: string }).transactionId : null;
            say('Applied.');
            setApprovedTransactionId(transactionId);
            setProposalState(null);
            onRefresh();
        } catch (cause) { setProposalError(cause instanceof Error ? cause.message : 'This could not be applied.'); }
        finally { setWorking(false); }
    };

    const rejectProposal = () => {
        setProposalState(null);
        say('Left as it was.');
    };

    const undoApprovedProposal = async () => {
        if (!approvedTransactionId) return;
        setWorking(true); setProposalError(null);
        try {
            await hostProviderService.undoCommand({ transactionId: approvedTransactionId });
            say('Undone.');
            setApprovedTransactionId(null);
            onRefresh();
        } catch (cause) { setProposalError(cause instanceof Error ? cause.message : 'This can no longer be undone.'); }
        finally { setWorking(false); }
    };

    const lines = proposalState ? proposalLines(proposalState.proposal) : [];
    const contextOptions = [
        { value: 'create', label: 'Something new' },
        ...elements.map((element) => ({ value: element.id, label: element.name })),
    ];

    return (
        <div className="flex h-full flex-col bg-panel">
            <div className="shrink-0 space-y-1.5 border-b border-line p-2">
                <AiRouteBar capability="commands" label="HUD model" />
                <div className="flex items-center gap-2">
                    <span className="shrink-0 text-2xs text-ink-3">Working on</span>
                    <Select
                        className="min-w-0 flex-1"
                        placeholder="What the change is about"
                        value={activeContextId}
                        options={contextOptions}
                        onChange={(value: string) => {
                            setActiveContextId(value);
                            onSelectElement(value === 'create' ? null : value);
                        }}
                    />
                </div>
            </div>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                {messages.map((message, index) => (
                    message.role === 'user' ? (
                        <div key={index} className="selectable ml-6 rounded bg-raised px-2 py-1.5 text-xs leading-[18px] text-ink">{message.text}</div>
                    ) : (
                        <div key={index} className="selectable flex gap-2 text-xs leading-[18px] text-ink-2">
                            <Sparkles size={12} className="mt-[3px] shrink-0 text-ink-3" />
                            <span className="min-w-0">{message.text}</span>
                        </div>
                    )
                ))}
                {working && !proposalState && <div className="flex items-center gap-2 text-xs text-ink-3"><Spinner className="text-accent" /> Working it out</div>}
                <div ref={messagesEndRef} />
            </div>

            {proposalState && (
                <div className="shrink-0 space-y-1.5 border-t border-line p-2">
                    <div className="text-2xs text-ink-3">
                        {proposalPreview(proposalState.proposal) ? 'Dashed on the canvas. Nothing has changed yet.' : 'Nothing has changed yet.'}
                    </div>
                    {lines.length > 0 && (
                        <ul className="selectable max-h-24 space-y-0.5 overflow-y-auto text-xs text-ink">
                            {lines.map((line, index) => <li key={index}>{line}</li>)}
                        </ul>
                    )}
                    <div className="flex justify-end gap-1.5 pt-0.5">
                        <Button variant="ghost" disabled={working} onClick={rejectProposal}>Reject</Button>
                        <Button variant="primary" disabled={working} onClick={() => void approveProposal()}>Apply</Button>
                    </div>
                </div>
            )}
            {approvedTransactionId && !proposalState && (
                <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line px-3 py-1.5">
                    <span className="text-2xs text-ink-3">Applied to the HUD.</span>
                    <Button size="sm" disabled={working} onClick={() => void undoApprovedProposal()}>Undo</Button>
                </div>
            )}
            {proposalError && (
                <div role="alert" className="flex shrink-0 items-start gap-2 border-t border-line bg-bad/10 px-3 py-1.5 text-2xs text-ink">
                    <AlertTriangle size={13} className="mt-px shrink-0 text-bad" />
                    <span className="selectable min-w-0">{proposalError}</span>
                </div>
            )}

            <form
                onSubmit={(event) => { event.preventDefault(); void submit(); }}
                className="flex shrink-0 items-end gap-1.5 border-t border-line p-2"
            >
                <TextArea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); }
                    }}
                    aria-label="Describe the change"
                    placeholder={activeContextId === 'create' ? 'What should be added?' : 'What should change?'}
                    className="h-[52px] flex-1"
                />
                <IconButton type="submit" label="Send" size="md" disabled={!input.trim() || working} className="!text-accent disabled:!text-ink-3"><Send size={14} /></IconButton>
            </form>
        </div>
    );
};
