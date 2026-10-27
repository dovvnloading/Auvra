import { DIALOGUE_LIMITS, type DialogueChoice, type DialogueData, type DialogueLine } from '../../runtime/dialogue';

/** Edits the dialogue editor makes. Each returns a new DialogueData and leaves its input untouched. */

const nextId = (prefix: string, taken: Iterable<string>): string => {
    const used = new Set(taken);
    let index = 1;
    while (used.has(`${prefix}${index}`)) index += 1;
    return `${prefix}${index}`;
};

/** Appends a line spoken by the same speaker as the last one; the first line becomes the start. */
export const addLine = (data: DialogueData): { data: DialogueData; id: string } => {
    if (data.lines.length >= DIALOGUE_LIMITS.maxLines) return { data, id: '' };
    const id = nextId('line', data.lines.map(line => line.id));
    const speaker = data.lines[data.lines.length - 1]?.speaker ?? '';
    const line: DialogueLine = { id, speaker, text: '', next: null };
    return { data: { startId: data.startId || id, lines: [...data.lines, line] }, id };
};

/** Removes a line; whatever led to it now ends the conversation, and the start moves to the first line left. */
export const removeLine = (data: DialogueData, id: string): DialogueData => {
    const lines = data.lines.filter(line => line.id !== id).map(line => ({
        ...line,
        next: line.next === id ? null : line.next,
        ...(line.choices ? { choices: line.choices.map(choice => (choice.next === id ? { ...choice, next: null } : choice)) } : {}),
    }));
    return { startId: data.startId === id ? lines[0]?.id ?? '' : data.startId, lines };
};

/** Moves a line up (-1) or down (+1) in the list; order is only how the editor lists them. */
export const moveLine = (data: DialogueData, id: string, offset: -1 | 1): DialogueData => {
    const index = data.lines.findIndex(line => line.id === id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= data.lines.length) return data;
    const lines = [...data.lines];
    [lines[index], lines[target]] = [lines[target], lines[index]];
    return { ...data, lines };
};

const withoutEmpty = <T extends object>(value: T, keys: readonly (keyof T)[]): T => {
    const copy = { ...value };
    for (const key of keys) if (copy[key] === '' || copy[key] === undefined) delete copy[key];
    return copy;
};

export const updateLine = (data: DialogueData, id: string, changes: Partial<Omit<DialogueLine, 'id' | 'choices'>>): DialogueData => ({
    ...data,
    lines: data.lines.map(line => (line.id === id ? withoutEmpty({ ...line, ...changes }, ['setVariable', 'event']) : line)),
});

export const addChoice = (data: DialogueData, lineId: string): DialogueData => ({
    ...data,
    lines: data.lines.map(line => {
        if (line.id !== lineId || (line.choices?.length ?? 0) >= DIALOGUE_LIMITS.maxChoices) return line;
        const choices = line.choices ?? [];
        const choice: DialogueChoice = { id: nextId('choice', choices.map(item => item.id)), text: '', next: null };
        return { ...line, choices: [...choices, choice] };
    }),
});

export const updateChoice = (data: DialogueData, lineId: string, choiceId: string, changes: Partial<Omit<DialogueChoice, 'id'>>): DialogueData => ({
    ...data,
    lines: data.lines.map(line => (line.id !== lineId ? line : {
        ...line,
        choices: (line.choices ?? []).map(choice => (choice.id === choiceId
            ? withoutEmpty({ ...choice, ...changes }, ['requires', 'setVariable', 'event'])
            : choice)),
    })),
});

export const removeChoice = (data: DialogueData, lineId: string, choiceId: string): DialogueData => ({
    ...data,
    lines: data.lines.map(line => {
        if (line.id !== lineId) return line;
        const choices = (line.choices ?? []).filter(choice => choice.id !== choiceId);
        if (choices.length) return { ...line, choices };
        const copy = { ...line };
        delete copy.choices;
        return copy;
    }),
});

/** How the editor names a line in lists: its number, speaker and the start of its text. */
export const lineLabel = (data: DialogueData, id: string): string => {
    const index = data.lines.findIndex(line => line.id === id);
    if (index < 0) return 'Missing line';
    const line = data.lines[index];
    const words = line.text.trim().replace(/\s+/g, ' ');
    const preview = words.length > 32 ? `${words.slice(0, 32)}…` : words;
    return `${index + 1}. ${line.speaker ? `${line.speaker}: ` : ''}${preview || '(empty)'}`;
};
