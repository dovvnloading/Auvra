/**
 * The node finder's choices: matching what is typed loosely against each node's name, the words it
 * is known by, its category and what it does; and the favourites and recent nodes it keeps.
 */

export interface FinderEntry {
    id: string;
    label: string;
    category: string;
    description?: string;
    keywords?: readonly string[];
    /** What its pins carry, for offering only nodes that fit a dragged wire. */
    inputs?: readonly string[];
    outputs?: readonly string[];
}

export interface FinderMemory {
    favourites: string[];
    recent: string[];
}

/** Recent nodes kept. */
export const RECENT_LIMIT = 8;

/** True when the letters of `word` come in `text` in order (not necessarily together): "nrml" in "normal". */
const inOrder = (word: string, text: string): boolean => {
    let at = 0;
    for (const char of word) {
        at = text.indexOf(char, at);
        if (at < 0) return false;
        at++;
    }
    return true;
};

const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * How well `entry` matches the typed words: 0 when any word matches nothing, else higher for better
 * matches. The name counts most (the whole name, its start, the start of one of its words, anywhere in
 * it, its letters in order), then the words it is known by, its category, then what it does.
 */
export const scoreEntry = (entry: FinderEntry, query: readonly string[]): number => {
    const label = entry.label.toLowerCase();
    const labelWords = words(entry.label);
    const keywords = (entry.keywords ?? []).map((keyword) => keyword.toLowerCase());
    const category = entry.category.toLowerCase();
    const description = (entry.description ?? '').toLowerCase();
    let total = 0;
    for (const word of query) {
        let score = 0;
        if (label === word) score = 100;
        else if (label.startsWith(word)) score = 70;
        else if (labelWords.some((part) => part.startsWith(word))) score = 55;
        else if (label.includes(word)) score = 40;
        else if (keywords.some((keyword) => keyword === word)) score = 35;
        else if (keywords.some((keyword) => keyword.startsWith(word) || keyword.split(/\s+/).some((part) => part.startsWith(word)))) score = 28;
        else if (keywords.some((keyword) => keyword.includes(word))) score = 18;
        else if (category.startsWith(word)) score = 14;
        else if (word.length >= 3 && inOrder(word, label)) score = 10;
        else if (word.length >= 3 && description.includes(word)) score = 5;
        if (!score) return 0;
        total += score;
    }
    return total;
};

/**
 * The entries to show for `query`, best first. With nothing typed: favourites, then recent nodes
 * (newest first), then the rest in the order given (by category). With something typed: the
 * matches, a favourite or recent node a little ahead of an equal match.
 */
export const rankEntries = (entries: readonly FinderEntry[], query: string, memory: FinderMemory): FinderEntry[] => {
    const typed = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const favourite = new Set(memory.favourites);
    const recentRank = new Map(memory.recent.map((id, index) => [id, index]));
    if (!typed.length) {
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        const shown = new Set<string>();
        const result: FinderEntry[] = [];
        for (const id of memory.favourites) { const entry = byId.get(id); if (entry && !shown.has(id)) { shown.add(id); result.push(entry); } }
        for (const id of memory.recent) { const entry = byId.get(id); if (entry && !shown.has(id)) { shown.add(id); result.push(entry); } }
        for (const entry of entries) if (!shown.has(entry.id)) result.push(entry);
        return result;
    }
    return entries
        .map((entry, index) => {
            const score = scoreEntry(entry, typed);
            if (!score) return null;
            const bonus = (favourite.has(entry.id) ? 6 : 0) + (recentRank.has(entry.id) ? 4 - recentRank.get(entry.id)! * 0.25 : 0);
            return { entry, score: score + bonus, index };
        })
        .filter((item): item is { entry: FinderEntry; score: number; index: number } => item !== null)
        .sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label) || a.index - b.index)
        .map((item) => item.entry);
};

/** Which part of the list (with nothing typed) an entry falls in, for its heading. */
export const entrySection = (entry: FinderEntry, memory: FinderMemory): string => {
    if (memory.favourites.includes(entry.id)) return 'Favourites';
    if (memory.recent.includes(entry.id)) return 'Recent';
    return entry.category;
};

/** Recent nodes with `id` used just now: first, once, at most RECENT_LIMIT. */
export const pushRecent = (recent: readonly string[], id: string, limit = RECENT_LIMIT): string[] => [id, ...recent.filter((other) => other !== id)].slice(0, limit);

/** Favourites with `id` added, or taken away when it was one. */
export const toggleFavourite = (favourites: readonly string[], id: string): string[] =>
    (favourites.includes(id) ? favourites.filter((other) => other !== id) : [...favourites, id]);

/** True when an entry has a pin that suits a dragged wire (`side` is where the wire came from). */
export const fitsWire = (entry: FinderEntry, wire: { side: 'in' | 'out'; kind: string } | null, match: (from: string, to: string) => number): boolean => {
    if (!wire) return true;
    // A wire from an output wants an input, and the other way round.
    const pins = wire.side === 'out' ? entry.inputs : entry.outputs;
    if (!pins) return true;
    return pins.some((kind) => (wire.side === 'out' ? match(wire.kind, kind) : match(kind, wire.kind)) > 0);
};

const STORAGE_PREFIX = 'auvra.nodeFinder.';

/** The favourites and recent nodes kept for one kind of graph (they last between sessions). */
export const loadFinderMemory = (kind: string): FinderMemory => {
    try {
        const raw = JSON.parse(window.localStorage.getItem(`${STORAGE_PREFIX}${kind}`) ?? '{}') as Partial<FinderMemory>;
        const list = (value: unknown, limit: number) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, limit) : []);
        return { favourites: list(raw.favourites, 64), recent: list(raw.recent, RECENT_LIMIT) };
    } catch {
        return { favourites: [], recent: [] };
    }
};

export const saveFinderMemory = (kind: string, memory: FinderMemory): void => {
    try {
        window.localStorage.setItem(`${STORAGE_PREFIX}${kind}`, JSON.stringify(memory));
    } catch {
        // Favourites and recent nodes are a nicety: a full or blocked store just does not keep them.
    }
};
