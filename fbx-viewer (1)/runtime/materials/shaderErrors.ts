/**
 * SHADER ERRORS ON THEIR NODES
 *
 * A compiled graph marks each node's code with a comment naming the node, and one where it ends
 * (compileMaterialGraph). The marks reach the shader as written, so the lines a GLSL compiler's log names
 * can be traced back to the node whose code they are, and its message put in plain words on that node.
 */

const NODE_MARK = '// mg-node:';
const END_MARK = '// mg-end';

/** The comment that opens a node's code. Ids are encoded so none can end the comment early. */
export const nodeCodeMark = (nodeId: string): string => `${NODE_MARK}${encodeURIComponent(nodeId)}`;

/** The comment that closes it. */
export const NODE_CODE_END = END_MARK;

/** The node whose code line `index` (from 0) of a shader is; null where it is no node's (three's own code). */
export const nodeAtLine = (lines: readonly string[], index: number): string | null => {
    for (let at = Math.min(index, lines.length - 1); at >= 0; at--) {
        const line = lines[at].trim();
        if (line === END_MARK) return null;
        if (!line.startsWith(NODE_MARK)) continue;
        try {
            return decodeURIComponent(line.slice(NODE_MARK.length));
        } catch {
            return null;
        }
    }
    return null;
};

/** A GLSL type name without its precision. */
const typeName = (value: string): string => value.replace(/\b(?:highp|mediump|lowp|const)\s+/g, '').trim();

/** What a GLSL compiler says, in plain words. */
export const plainShaderMessage = (message: string): string => {
    const text = message.trim();
    let match = /^'([^']*)'\s*:\s*undeclared identifier/i.exec(text);
    if (match) return `Uses “${match[1]}”, which is not defined here.`;
    match = /^'([^']*)'\s*:\s*syntax error/i.exec(text);
    if (match) return match[1] ? `Its code has a mistake near “${match[1]}”.` : 'Its code has a mistake.';
    match = /cannot convert from '([^']*)' to '([^']*)'/i.exec(text);
    if (match) return `A ${typeName(match[1])} is used where a ${typeName(match[2])} is needed.`;
    match = /^'([^']*)'\s*:\s*no matching overloaded function found/i.exec(text);
    if (match) return `“${match[1]}” is given values of the wrong kinds.`;
    match = /^'([^']*)'\s*:\s*wrong operand types/i.exec(text);
    if (match) return `“${match[1]}” combines values of kinds that do not go together.`;
    return `Its code does not compile: ${text}`;
};

/** The nodes a shader's compile log blames, each with its first message in plain words. */
export const nodeShaderErrors = (source: string, log: string): Map<string, string> => {
    const lines = source.split('\n');
    const errors = new Map<string, string>();
    for (const entry of log.split('\n')) {
        const match = /ERROR:\s*\d+:(\d+):\s*(.*)$/.exec(entry);
        if (!match) continue;
        const node = nodeAtLine(lines, Number(match[1]) - 1);
        if (node && !errors.has(node)) errors.set(node, plainShaderMessage(match[2]));
    }
    return errors;
};
