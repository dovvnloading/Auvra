import type { LightEstimate } from './photometricStereo';

export const CAPTURE_FEWEST = 3;
export const CAPTURE_MOST = 8;
export interface CaptureSet {
    names: string[];
    size: number;
    thumbnails: string[];
    estimate: LightEstimate;
    sameSize: boolean;
}
export interface CapturePictures { colour: Blob; normal: Blob; height: Blob }
export type CaptureRequest = { kind: 'read'; files: File[] } | { kind: 'render'; azimuths: number[]; elevation: number };
export type CaptureReply = { kind: 'read'; set: CaptureSet } | { kind: 'render'; pictures: CapturePictures } | { kind: 'error'; message: string };
