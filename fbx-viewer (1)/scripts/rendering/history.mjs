// What each rendering scene costs, kept commit by commit on the rendering-history branch (one JSON line per commit to main).
//
//   node scripts/rendering/history.mjs compare <numbers.json> <history.jsonl>   how these numbers compare with the last kept
//   node scripts/rendering/history.mjs record <numbers.json> <history.jsonl> <commit>   adds these numbers to the history
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const [command, numbersFile, historyFile, commit] = process.argv.slice(2);

/** What to show, and how far it may move before it is worth a warning: the counts are exact, the times are not. */
const MEASURES = [
  { key: 'loadMs', label: 'Load ms', warnAt: 0.3, digits: 0 },
  { key: 'frameMs', label: 'Frame ms', warnAt: 0.3, digits: 1 },
  { key: 'calls', label: 'Draws', warnAt: 0.1, digits: 0 },
  { key: 'triangles', label: 'Triangles', warnAt: 0.1, digits: 0 },
  { key: 'programs', label: 'Programs', warnAt: 0.1, digits: 0 },
  { key: 'gpuBytes', label: 'GPU MB', warnAt: 0.1, digits: 1, scale: 1 / 1048576 },
];

const numbers = JSON.parse(readFileSync(numbersFile, 'utf8'));

const lastKept = () => {
  if (!existsSync(historyFile)) return null;
  const lines = readFileSync(historyFile, 'utf8').split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
};

const compare = () => {
  const kept = lastKept();
  const rows = [`| Scene | ${MEASURES.map((measure) => measure.label).join(' | ')} |`, `|---|${MEASURES.map(() => '---').join('|')}|`];
  const warnings = [];
  for (const [scene, values] of Object.entries(numbers)) {
    const before = kept?.scenes?.[scene];
    const cells = MEASURES.map(({ key, label, warnAt, digits, scale = 1 }) => {
      const value = (values[key] * scale).toFixed(digits);
      if (!before || !(before[key] > 0)) return value;
      const change = values[key] / before[key] - 1;
      if (change > warnAt) warnings.push(`${scene}: ${label} rose ${Math.round(change * 100)}% on main's ${(before[key] * scale).toFixed(digits)}`);
      return Math.abs(change) < 0.005 ? value : `${value} (${change > 0 ? '+' : ''}${Math.round(change * 100)}%)`;
    });
    rows.push(`| ${scene} | ${cells.join(' | ')} |`);
  }
  const summary = [`### Rendering cost${kept ? ` against ${kept.commit.slice(0, 7)}` : ''}`, '', ...rows, '', ...warnings.map((warning) => `- ${warning}`), ''].join('\n');
  console.log(summary);
  for (const warning of warnings) console.log(`::warning title=Rendering cost::${warning}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
};

const record = () => {
  appendFileSync(historyFile, `${JSON.stringify({ commit, date: new Date().toISOString(), scenes: numbers })}\n`);
};

if (command === 'compare') compare();
else if (command === 'record') record();
else throw new Error('Use compare or record');
