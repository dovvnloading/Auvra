import type { TimelineData } from './types';

/**
 * TIMELINE PREVIEW
 *
 * While the Timeline editor is open, the timeline it edits (unsaved changes and all) at its playhead,
 * for the editor viewport to show: the owner's timeline component moves, hides and poses the level's
 * objects there as play would, and puts them back when the preview ends.
 */
export interface TimelinePreviewState {
    /** The object holding the timeline component being edited. */
    ownerId: string;
    data: TimelineData;
    time: number;
}

export const createTimelinePreview = () => {
    let state: TimelinePreviewState | null = null;
    const listeners = new Set<() => void>();
    return {
        get(): TimelinePreviewState | null {
            return state;
        },
        set(next: TimelinePreviewState | null): void {
            state = next;
            [...listeners].forEach(listener => listener());
        },
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
};

export type TimelinePreview = ReturnType<typeof createTimelinePreview>;

/** The editor's preview. */
export const timelinePreview = createTimelinePreview();
