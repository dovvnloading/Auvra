import type { CaptureSet, CapturePictures, CaptureReply, CaptureRequest } from './captureProtocol';

/** A capture owns one worker, including its decoded photos, until the dialog closes. */
export class PhotoCapture {
    private readonly worker = new Worker(new URL('../../workers/photoCapture.worker.ts', import.meta.url), { type: 'module' });
    private reject?: (error: Error) => void;
    private closed = false;

    async read(files: File[]): Promise<CaptureSet> {
        const reply = await this.request({ kind: 'read', files });
        if (reply.kind !== 'read') throw new Error('The worker returned an unexpected capture preview.');
        return reply.set;
    }

    async render(azimuths: number[], elevation: number): Promise<CapturePictures> {
        const reply = await this.request({ kind: 'render', azimuths, elevation });
        if (reply.kind !== 'render') throw new Error('The worker returned unexpected capture maps.');
        return reply.pictures;
    }

    private async request(message: CaptureRequest): Promise<CaptureReply> {
        if (this.closed || this.reject) throw new Error('The photo capture is closed or busy.');
        try {
            return await new Promise<CaptureReply>((resolve, reject) => {
                this.reject = reject;
                this.worker.onmessage = (event: MessageEvent<CaptureReply>) => {
                    if (event.data.kind === 'error') reject(new Error(event.data.message));
                    else resolve(event.data);
                };
                this.worker.onerror = event => reject(new Error(event.message || 'The photo capture worker failed.'));
                this.worker.onmessageerror = () => reject(new Error('The photo capture result could not be read.'));
                this.worker.postMessage(message);
            });
        } finally {
            this.reject = undefined;
            this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
        }
    }

    close(): void {
        this.closed = true;
        this.worker.terminate();
        this.reject?.(new DOMException('Photo capture cancelled.', 'AbortError'));
    }
}
