import React, { useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { hostProviderService } from '../../services/HostProviderService';
import { AiRouteBar } from '../Settings/AiRouteBar';
import { Button, Spinner, TextArea } from '../UI/kit';
import { composeScriptRequest, extractScriptCode } from './scriptAssistantPrompt';

interface ScriptAssistantProps {
  /** The script as it stands in the editor. */
  draft: string;
  reference: Parameters<typeof composeScriptRequest>[2];
  /** Hands over the script the model proposes, for review. Nothing reaches the script from here. */
  onProposal: (code: string) => void;
}

/** Asks the chosen coding model to write or change the script, along the foot of the code. */
export const ScriptAssistant: React.FC<ScriptAssistantProps> = ({ draft, reference, onProposal }) => {
  const [request, setRequest] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef<string | null>(null);
  const stopped = useRef(false);

  const ask = async () => {
    const wanted = request.trim();
    if (!wanted || working) return;
    setWorking(true); setError(null);
    stopped.current = false;
    try {
      const job = await hostProviderService.submitInference({
        capability: 'code',
        input: composeScriptRequest(wanted, draft, reference),
        consent: 'explicit',
      });
      running.current = job.jobId;
      const done = await hostProviderService.waitForJob(job);
      if (stopped.current) return;
      if (done.status !== 'succeeded') throw new Error(done.error?.message || 'The model did not answer.');
      const code = extractScriptCode(String(done.outputText ?? ''));
      if (!code) throw new Error('The model answered with nothing.');
      onProposal(code);
    } catch (cause) {
      if (!stopped.current) setError(cause instanceof Error ? cause.message : 'The model did not answer.');
    } finally { running.current = null; setWorking(false); }
  };

  const stop = () => {
    stopped.current = true;
    if (running.current) void hostProviderService.cancelInference(running.current).catch(() => undefined);
    setWorking(false);
  };

  return (
    <section aria-label="Script assistant" className="shrink-0 border-t border-line bg-panel">
      {error && (
        <div role="alert" className="flex items-start gap-2 border-b border-line bg-bad/10 px-3 py-1.5 text-2xs text-ink">
          <AlertTriangle size={13} className="mt-px shrink-0 text-bad" />
          <span className="selectable min-w-0 flex-1">{error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setError(null)} className="text-ink-3 hover:text-ink"><X size={13} /></button>
        </div>
      )}
      <div className="flex gap-2 p-2">
        <TextArea
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void ask(); }
          }}
          disabled={working}
          placeholder="What should the script do? For example: spin this object, and open the door when the player comes close."
          aria-label="What the script should do"
          className="h-[62px] flex-1"
        />
        <div className="flex w-56 shrink-0 flex-col justify-end gap-1.5">
          <AiRouteBar capability="code" label="Coding model" placement="top-end" />
          {working ? (
            <Button size="lg" className="w-full" onClick={stop} icon={<Spinner className="text-accent" />}>Writing. Stop</Button>
          ) : (
            <Button variant="primary" size="lg" className="w-full" disabled={!request.trim()} onClick={() => void ask()}>
              Write it <span className="text-2xs font-normal opacity-60">Ctrl Enter</span>
            </Button>
          )}
        </div>
      </div>
    </section>
  );
};
