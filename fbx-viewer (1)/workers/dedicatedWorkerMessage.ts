/// <reference lib="webworker" />

/** The owner's implicit message port has no source window and normally reports an empty origin. */
export const isDedicatedWorkerMessage = (event: MessageEvent): boolean =>
    typeof DedicatedWorkerGlobalScope !== 'undefined' &&
    event.currentTarget instanceof DedicatedWorkerGlobalScope &&
    event.isTrusted &&
    event.source === null &&
    (event.origin === '' || event.origin === self.location.origin);
