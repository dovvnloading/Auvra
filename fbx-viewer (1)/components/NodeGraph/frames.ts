import type { EditableFrame, Rect } from './model';

/**
 * Frames: titled boxes that hold the nodes whose middle lies inside them. Dragging a frame takes its
 * nodes along; dragging nodes in or out of a frame adds or takes them away, and the frame then fits
 * round the nodes it holds.
 */

/** Room kept round a frame's nodes, and the height of its title bar above them. */
export const FRAME_PAD = 20;
export const FRAME_TITLE = 26;
/** A frame's smallest size, so an empty one stays easy to grab. */
export const FRAME_MIN = { width: 120, height: 72 };

export const FRAME_COLOURS = ['#3b4252', '#1e3a5f', '#14532d', '#713f12', '#7f1d1d', '#4c1d95', '#134e4a', '#57534e'];
export const FRAME_COLOUR_NAMES: Record<string, string> = {
    '#3b4252': 'Slate', '#1e3a5f': 'Blue', '#14532d': 'Green', '#713f12': 'Amber', '#7f1d1d': 'Red', '#4c1d95': 'Violet', '#134e4a': 'Teal', '#57534e': 'Stone',
};

const centreInside = (rect: Rect, frame: Rect): boolean => {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    return cx >= frame.x && cx <= frame.x + frame.width && cy >= frame.y && cy <= frame.y + frame.height;
};

/** The smallest frame round a rect's middle, if any: a node belongs to the innermost frame round it. */
export const frameOf = (rect: Rect, frames: readonly EditableFrame[]): EditableFrame | null => {
    let found: EditableFrame | null = null;
    for (const frame of frames) {
        if (!centreInside(rect, frame)) continue;
        if (!found || frame.width * frame.height < found.width * found.height) found = frame;
    }
    return found;
};

/** The nodes a frame holds: those whose middle lies inside it and inside no smaller frame. */
export const frameMembers = (frame: EditableFrame, rects: ReadonlyMap<string, Rect>, frames: readonly EditableFrame[]): string[] => {
    const members: string[] = [];
    for (const [id, rect] of rects) if (frameOf(rect, frames)?.id === frame.id) members.push(id);
    return members;
};

/**
 * What a frame carries when it is dragged: every node whose middle lies in it (in frames inside it
 * too), and the frames wholly inside it.
 */
export const frameContents = (frame: EditableFrame, rects: ReadonlyMap<string, Rect>, frames: readonly EditableFrame[]): { nodes: string[]; frames: string[] } => {
    const nodes: string[] = [];
    for (const [id, rect] of rects) if (centreInside(rect, frame)) nodes.push(id);
    const inner = frames
        .filter((other) => other.id !== frame.id && other.x >= frame.x && other.y >= frame.y && other.x + other.width <= frame.x + frame.width && other.y + other.height <= frame.y + frame.height)
        .map((other) => other.id);
    return { nodes, frames: inner };
};

/** `frame` fitted round `members` (keeping its title and colour); unchanged when it holds none. */
export const fitFrame = (frame: EditableFrame, members: readonly Rect[]): EditableFrame => {
    if (!members.length) return frame;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const rect of members) {
        minX = Math.min(minX, rect.x);
        minY = Math.min(minY, rect.y);
        maxX = Math.max(maxX, rect.x + rect.width);
        maxY = Math.max(maxY, rect.y + rect.height);
    }
    const x = Math.round(minX - FRAME_PAD);
    const y = Math.round(minY - FRAME_PAD - FRAME_TITLE);
    const width = Math.round(Math.max(FRAME_MIN.width, maxX - minX + FRAME_PAD * 2));
    const height = Math.round(Math.max(FRAME_MIN.height, maxY - minY + FRAME_PAD * 2 + FRAME_TITLE));
    if (x === frame.x && y === frame.y && width === frame.width && height === frame.height) return frame;
    return { ...frame, x, y, width, height };
};

/**
 * Frames after nodes moved from `before` to `after` (rects by node id; `moved` the nodes dragged).
 * A dragged node leaves the frame it was in when its middle ends outside it, and joins the innermost
 * frame its middle ends in; every frame that held a dragged node, before or after, then fits round
 * the nodes it now holds. Frames no dragged node touched stay as they were.
 */
export const refitFrames = (
    frames: readonly EditableFrame[],
    before: ReadonlyMap<string, Rect>,
    after: ReadonlyMap<string, Rect>,
    moved: ReadonlySet<string>,
): EditableFrame[] => {
    if (!frames.length || !moved.size) return [...frames];
    const owner = new Map<string, string>();
    for (const [id, rect] of before) {
        const frame = frameOf(rect, frames);
        if (frame) owner.set(id, frame.id);
    }
    const touched = new Set<string>();
    for (const id of moved) {
        const was = owner.get(id);
        const rect = after.get(id);
        if (!rect) continue;
        const stillIn = was ? frames.find((frame) => frame.id === was) : undefined;
        if (stillIn && centreInside(rect, stillIn)) {
            // Still inside its frame: the frame grows or shrinks round it.
            touched.add(stillIn.id);
            continue;
        }
        if (was) { owner.delete(id); touched.add(was); }
        const joined = frameOf(rect, frames);
        if (joined) { owner.set(id, joined.id); touched.add(joined.id); }
    }
    if (!touched.size) return [...frames];
    return frames.map((frame) => {
        if (!touched.has(frame.id)) return frame;
        const members: Rect[] = [];
        for (const [id, frameId] of owner) if (frameId === frame.id) { const rect = after.get(id) ?? before.get(id); if (rect) members.push(rect); }
        return fitFrame(frame, members);
    });
};
