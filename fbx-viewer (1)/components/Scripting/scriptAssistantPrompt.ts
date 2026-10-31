/** What the script assistant tells the model, and what it takes back from the answer. */

interface ScriptReferenceSection {
  title: string;
  entries: { signature: string; description: string }[];
}

/** A request to a provider carries at most this many characters. */
export const MAX_REQUEST_CHARACTERS = 65536;
const MAX_ANSWER_REMINDER = 'Reply with the complete new script in one code block and nothing else.';

export const composeScriptRequest = (request: string, source: string, reference: readonly ScriptReferenceSection[]): string => {
  const api = reference
    .map((section) => `${section.title}:\n${section.entries.map((entry) => `- ${entry.signature}: ${entry.description}`).join('\n')}`)
    .join('\n\n');
  const head = [
    'You write gameplay scripts for the Auvra game engine, in JavaScript or TypeScript. They run during play: a script defines the callbacks below as top-level functions and has no imports. Angles are in radians. For example:',
    '```',
    'function onUpdate(ctx, dt) {',
    '    ctx.self.translate(0, 0, dt);',
    '}',
    '```',
    MAX_ANSWER_REMINDER,
    '',
    'The script API:',
    api,
    '',
  ].join('\n');
  const tail = `\n\nWhat to do: ${request.trim()}\n\n${MAX_ANSWER_REMINDER}`;
  const room = Math.max(0, MAX_REQUEST_CHARACTERS - head.length - tail.length - 64);
  return `${head}The script as it stands:\n\`\`\`\n${source.slice(0, room)}\n\`\`\`${tail}`;
};

/** The code in an answer: its first code block, or all of it where the model left the fence out. */
export const extractScriptCode = (answer: string): string => {
  const fenced = /```[^\n`]*\n([\s\S]*?)```/.exec(answer);
  return (fenced ? fenced[1] : answer).replace(/\s+$/, '');
};
