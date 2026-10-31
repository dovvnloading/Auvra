import React, { useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { hostProviderService } from '../../services/HostProviderService';
import { AiRouteBar } from '../Settings/AiRouteBar';
import { composeScriptRequest, extractScriptCode } from './scriptAssistantPrompt';

interface ScriptAssistantProps {
  /** The script as it stands in the editor. */
  draft: string;
  reference: Parameters<typeof composeScriptRequest>[2];
  /** Swaps the whole script for the answer. The editor's own undo takes it back. */
  onReplace: (code: string) => void;
  onInsert: (code: string) => void;
}

/** Asks the chosen coding model to write or change the script. Nothing reaches the script until it is accepted. */
export const ScriptAssistant: React.FC<ScriptAssistantProps> = ({ draft, reference, onReplace, onInsert }) => {
  const [request, setRequest] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async () => {
    const wanted = request.trim();
    if (!wanted) return;
    setWorking(true); setError(null); setAnswer(null);
    try {
      const job = await hostProviderService.submitInference({
        capability: 'code',
        input: composeScriptRequest(wanted, draft, reference),
        consent: 'explicit',
      });
      const done = await hostProviderService.waitForJob(job);
      if (done.status !== 'succeeded') throw new Error(done.error?.message || 'The model did not answer.');
      const code = extractScriptCode(String(done.outputText ?? ''));
      if (!code) throw new Error('The model answered with nothing.');
      setAnswer(code);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The model did not answer.');
    } finally { setWorking(false); }
  };

  return (
    <div className="space-y-3">
      <AiRouteBar capability="code" label="Coding model" />
      <textarea
        value={request}
        onChange={(event) => setRequest(event.target.value)}
        disabled={working}
        placeholder="What should the script do? For example: spin this object, and open the door when the player comes close."
        aria-label="What the script should do"
        className="h-24 w-full resize-none rounded border border-gray-700 bg-gray-950 p-2 text-[11px] text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
      />
      <button
        type="button"
        onClick={() => void ask()}
        disabled={working || !request.trim()}
        className="flex w-full items-center justify-center gap-1.5 rounded bg-blue-600 px-2 py-1.5 text-[11px] font-bold text-white hover:bg-blue-500 disabled:opacity-50"
      >
        {working ? <RefreshCw size={12} className="animate-spin" /> : <Sparkles size={12} />} {working ? 'Writing...' : 'Write it'}
      </button>
      {error && <div role="alert" className="rounded border border-red-900/50 bg-red-900/20 p-2 text-[10px] text-red-300">{error}</div>}
      {answer !== null && (
        <div className="space-y-2">
          <pre aria-label="The model's answer" className="max-h-72 overflow-auto rounded border border-gray-700 bg-gray-950 p-2 font-mono text-[10px] text-gray-200">{answer}</pre>
          <div className="grid grid-cols-3 gap-1.5">
            <button type="button" onClick={() => { onReplace(answer); setAnswer(null); }} className="rounded bg-emerald-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-emerald-500">Replace script</button>
            <button type="button" onClick={() => { onInsert(answer); setAnswer(null); }} className="rounded border border-gray-700 px-2 py-1 text-[10px] text-gray-200 hover:bg-gray-800">Insert</button>
            <button type="button" onClick={() => setAnswer(null)} className="rounded border border-gray-700 px-2 py-1 text-[10px] text-gray-400 hover:bg-gray-800">Discard</button>
          </div>
        </div>
      )}
    </div>
  );
};
