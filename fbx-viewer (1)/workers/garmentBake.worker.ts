/// <reference lib="webworker" />
import { bakeFitting, type FittingBakeInput, type FittingBakeReply } from '../runtime/garments/bake';
import { isDedicatedWorkerMessage } from './dedicatedWorkerMessage';

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<{ input: FittingBakeInput; seconds: number }>) => {
    if (!isDedicatedWorkerMessage(event)) return;
    try {
        const { input, seconds } = event.data;
        const bytes = bakeFitting(input, seconds, progress => scope.postMessage({ progress } satisfies FittingBakeReply));
        scope.postMessage({ bytes, duration: seconds } satisfies FittingBakeReply, { transfer: [bytes] });
    } catch (error) {
        scope.postMessage({ error: error instanceof Error ? error.message : 'Fitting bake failed.' } satisfies FittingBakeReply);
    }
};
