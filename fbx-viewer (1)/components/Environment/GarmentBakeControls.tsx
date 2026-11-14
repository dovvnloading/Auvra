import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComponentInspectorProps } from '../../runtime/components/types';
import { readGarmentSettings } from '../../runtime/components/garmentComponent';
import type { GarmentPattern } from '../../runtime/garments/pattern';
import { fittingBakeRecipe, readFittingBake, type FittingBakeReply } from '../../runtime/garments/bake';
import { readFabricOverrides } from '../../runtime/garments/fitting';
import { projectService } from '../../utils/projectService';
import { editorSession } from '../../utils/editorSession';

const button = 'rounded border border-gray-700 px-2 py-1 text-2xs text-gray-200 hover:bg-gray-800 disabled:opacity-40';

export const GarmentBakeControls: React.FC<ComponentInspectorProps & { pattern: GarmentPattern }> =
    ({ pattern, component, onChangeProps }) => {
        const { fabric, animateTorso, selfCollision, followBone, collisionMesh } = readGarmentSettings(component);
        const liveBinding = Boolean(followBone || collisionMesh);
        const material = useMemo(() => readFabricOverrides(fabric, component.props.fabricProperties), [fabric, component.props.fabricProperties]);
        const input = useMemo(() => ({ pattern, fabric, animateTorso, selfCollision, material }), [pattern, fabric, animateTorso, selfCollision, material]);
        const [seconds, setSeconds] = useState(2);
        const [progress, setProgress] = useState<number | null>(null);
        const [error, setError] = useState('');
        const [recipe, setRecipe] = useState('');
        const active = useRef<{ worker: Worker; controller: AbortController } | null>(null);
        const ref = readFittingBake(component.props.fittingBake);
        const compatible = ref && ref.recipe === recipe && !liveBinding;
        const cancel = () => {
            active.current?.worker.terminate(); active.current?.controller.abort(); active.current = null;
        };
        useLayoutEffect(() => {
            cancel(); setProgress(null); setError(''); setRecipe('');
            return cancel;
        }, [component.id, input, liveBinding]);
        useEffect(() => {
            let mounted = true;
            void fittingBakeRecipe(input).then(id => { if (mounted) setRecipe(id); })
                .catch(() => { if (mounted) setError('Fitting bakes require a secure browser context.'); });
            return () => { mounted = false; };
        }, [input, liveBinding, component.id]);
        const start = () => {
            const lease = editorSession.captureReady();
            const project = projectService.getStatus();
            if (liveBinding || active.current || !recipe) return;
            if (!lease || !project.projectId || lease.projectId !== project.projectId || project.readOnly) {
                setError('Open a writable project to store the fitting clip.'); return;
            }
            const controller = new AbortController();
            let worker: Worker;
            try { worker = new Worker(new URL('../../workers/garmentBake.worker.ts', import.meta.url), { type: 'module' }); }
            catch { setError('The fitting worker could not start.'); return; }
            active.current = { worker, controller }; setProgress(0); setError('');
            const current = () => active.current?.controller === controller && !controller.signal.aborted;
            const finish = (message = '') => {
                if (!current()) return;
                cancel(); setProgress(null); setError(message);
            };
            worker.onerror = () => finish('The fitting worker stopped before completing the clip.');
            worker.onmessage = async (event: MessageEvent<FittingBakeReply>) => {
                if (!current()) return;
                if (!editorSession.isCurrent(lease)) { finish('The project changed. Start the fitting bake again.'); return; }
                const reply = event.data;
                if ('progress' in reply) { setProgress(Math.round(95 * reply.progress)); return; }
                if ('error' in reply) { finish(reply.error); return; }
                worker.terminate(); setProgress(95);
                try {
                    const file = new File([reply.bytes], 'garment-fit.agc', { type: 'application/octet-stream' });
                    const assetId = await projectService.uploadAsset(file, { signal: controller.signal });
                    if (!current()) return;
                    if (!editorSession.isCurrent(lease)) { finish('The project changed before the bake could be attached.'); return; }
                    onChangeProps({ fittingBake: { assetId, recipe, duration: reply.duration }, playback: 'cache' });
                    finish();
                } catch (err) { finish(err instanceof Error ? err.message : 'The fitting clip could not be saved.'); }
            };
            try {
                worker.postMessage({ input, seconds });
            } catch {
                finish('The fitting worker could not receive the pattern. Start the bake again.');
            }
        };
        return <details className="space-y-1 text-2xs text-gray-300">
            <summary className="cursor-pointer">Fitting bake</summary>
            <p>Record the upright fitting form in still air at 30 fps. Bone and skinned-mesh bindings use live simulation.</p>
            <div className="flex items-center gap-1"><label>Duration <select value={seconds} disabled={progress !== null}
                className="rounded border border-gray-700 bg-gray-950" onChange={event => setSeconds(Number(event.target.value))}>
                {[1, 2, 5, 10].map(value => <option key={value} value={value}>{value} s</option>)}
            </select></label>
            {progress === null
                ? <button type="button" className={button} disabled={!recipe || liveBinding} onClick={start}>Bake fitting clip</button>
                : <button type="button" className={button} onClick={() => { cancel(); setProgress(null); }}>Cancel bake · {progress}%</button>}
            </div>
            {ref && <div className="space-y-1">
                <p>{compatible ? 'Saved fitting clip · ' + ref.duration + ' s' : 'This clip needs the original pattern, fabric and fitting settings.'}</p>
                <button type="button" className={button} disabled={!compatible && component.props.playback !== 'cache'}
                    onClick={() => onChangeProps({ playback: component.props.playback === 'cache' ? 'live' : 'cache' })}>
                    {component.props.playback === 'cache' ? 'Use live simulation' : 'Play fitting clip'}</button>
                <label className="ml-2"><input type="checkbox" checked={component.props.loopBake === true}
                    onChange={e => onChangeProps({ loopBake: e.target.checked })} /> Loop clip</label>
            </div>}
            {error && <p role="alert" className="text-amber-400">{error}</p>}
        </details>;
    };
