/**
 * The drawings behind Auvra's icons, made by hand on a pixel grid.
 *
 * Coordinates are pixels, with whole numbers at pixel centres: the canvas runs 0 to 12 and its middle pixel is 6.
 * Lines are one pixel wide, so a line along x = 6 covers exactly column 6 instead of smearing across two columns.
 * Line ends and corners therefore sit on whole numbers as well; fills that show an edge stop on half numbers.
 *
 * A drawing is a list of layers, painted in order:
 * - a plain path is a line;
 * - `~` starts a tone: the body of a thing, filled faintly in the icon's colour (solid when the icon is given a fill);
 * - `#` starts a solid fill.
 *
 * `m` is the main drawing, at most 11 pixels across (columns and rows 1 to 11). `s`, where there is one, is a simpler
 * drawing at most 9 pixels across (2 to 10), used when an icon is shown at 9 to 11 px.
 *
 * House style: things (files, tools, places) have a body in tone; marks and arrows are bare lines; containers have
 * one-pixel rounded corners; slopes are 45 degrees or one-in-two wherever the shape allows, as those stay crisp.
 */

export type Drawing = readonly string[];

export interface Glyph {
  readonly m: Drawing;
  readonly s?: Drawing;
}

const n = (value: number): string => String(Math.round(value * 1000) / 1000);

/** A circle through the given centre and radius. */
const circle = (cx: number, cy: number, r: number): string =>
  `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0Z`;

/** An ellipse through the given centre and radii. */
const ellipse = (cx: number, cy: number, rx: number, ry: number): string =>
  `M${n(cx - rx)} ${n(cy)}a${n(rx)} ${n(ry)} 0 1 0 ${n(2 * rx)} 0a${n(rx)} ${n(ry)} 0 1 0 ${n(-2 * rx)} 0Z`;

/** A rectangle from its top-left corner along the line, its width and height along the line, and its corner radius. */
const rect = (x: number, y: number, w: number, h: number, r = 0): string => (r
  ? `M${n(x + r)} ${n(y)}h${n(w - 2 * r)}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(r)}v${n(h - 2 * r)}a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(r)}h${n(2 * r - w)}a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(-r)}v${n(2 * r - h)}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(-r)}Z`
  : `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z`);

/** A filled block covering whole pixels, from column `x` and row `y`, `w` by `h` pixels. */
const block = (x: number, y: number, w: number, h: number): string => `#M${n(x - 0.5)} ${n(y - 0.5)}h${n(w)}v${n(h)}h${n(-w)}Z`;

/** A one-pixel dot, round when drawn large. */
const dot = (x: number, y: number, r = 0.62): string => `#${circle(x, y, r)}`;

const tone = (path: string): string => `~${path}`;
const solid = (path: string): string => `#${path}`;

/** A path both toned and outlined. */
const body = (path: string): string[] => [tone(path), path];

/** `count` dashes round a circle, each `share` of its slot, the first centred straight up. */
const dashedCircle = (cx: number, cy: number, r: number, count: number, share: number): string => {
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const middle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
    const half = (Math.PI / count) * share;
    const from = [cx + r * Math.cos(middle - half), cy + r * Math.sin(middle - half)];
    const to = [cx + r * Math.cos(middle + half), cy + r * Math.sin(middle + half)];
    parts.push(`M${n(from[0])} ${n(from[1])}A${n(r)} ${n(r)} 0 0 1 ${n(to[0])} ${n(to[1])}`);
  }
  return parts.join('');
};

/**
 * A gear: `teeth` teeth with flat tips at radius `outer`, roots on radius `inner`, the first tooth straight up.
 * `tip` and `root` are half the width of a tooth at its tip and at its root, in pixels.
 */
const gear = (cx: number, cy: number, teeth: number, outer: number, inner: number, tip: number, root: number): string => {
  const points: string[] = [];
  const rootY = -Math.sqrt(inner * inner - root * root);
  for (let index = 0; index < teeth; index += 1) {
    const angle = (index * 2 * Math.PI) / teeth;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const place = (x: number, y: number): string => `${n(cx + x * cos - y * sin)} ${n(cy + x * sin + y * cos)}`;
    points.push(`${index === 0 ? 'M' : 'L'}${place(-root, rootY)}L${place(-tip, -outer)}L${place(tip, -outer)}L${place(root, rootY)}`);
    const next = ((index + 1) * 2 * Math.PI) / teeth;
    points.push(`A${n(inner)} ${n(inner)} 0 0 1 ${n(cx - root * Math.cos(next) - rootY * Math.sin(next))} ${n(cy - root * Math.sin(next) + rootY * Math.cos(next))}`);
  }
  return `${points.join('')}Z`;
};

/** A four-pointed glint centred on (cx, cy), reaching `r` along each axis. */
const glint = (cx: number, cy: number, r: number): string => {
  const k = r * 0.28;
  return `M${n(cx)} ${n(cy - r)}C${n(cx + k * 0.4)} ${n(cy - k)} ${n(cx + k)} ${n(cy - k * 0.4)} ${n(cx + r)} ${n(cy)}C${n(cx + k)} ${n(cy + k * 0.4)} ${n(cx + k * 0.4)} ${n(cy + k)} ${n(cx)} ${n(cy + r)}C${n(cx - k * 0.4)} ${n(cy + k)} ${n(cx - k)} ${n(cy + k * 0.4)} ${n(cx - r)} ${n(cy)}C${n(cx - k)} ${n(cy - k * 0.4)} ${n(cx - k * 0.4)} ${n(cy - k)} ${n(cx)} ${n(cy - r)}Z`;
};

/** A five-pointed star centred on (cx, cy). */
const star = (cx: number, cy: number, outer: number, inner: number): string => {
  const points: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const radius = index % 2 ? inner : outer;
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    points.push(`${index ? 'L' : 'M'}${n(cx + radius * Math.cos(angle))} ${n(cy + radius * Math.sin(angle))}`);
  }
  return `${points.join('')}Z`;
};

// Shapes shared by several icons.
const FILE = 'M3 1h4l3 3v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1Z';
const FILE_FOLD = 'M7 1v3h3';
const FOLDER = 'M1 9V3a1 1 0 0 1 1-1h2l1 1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1Z';
const FOLDER_SMALL = 'M2 8V4a1 1 0 0 1 1-1h1l1 1h4a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z';
const CUBE = 'M6 2l4 2v4l-4 2-4-2V4Z';
const CUBE_TOP = 'M6 2l4 2-4 2-4-2Z';
const CUBE_EDGES = 'M2 4l4 2 4-2M6 6v4';
const CLOUD = 'M3.5 7.5a2 2 0 0 1-.2-4 3 3 0 0 1 5.6-.6A2.3 2.3 0 0 1 8.5 7.5Z';
const CLOUD_LOW = 'M3.5 9a2.5 2.5 0 0 1-.3-5 3.5 3.5 0 0 1 6.6-.4A2.7 2.7 0 0 1 9 9Z';
const SPEAKER = 'M1 4h2l2-2v8L3 8H1Z';
const SPEAKER_SMALL = 'M2 5h1l2-2v6L3 7H2Z';
const HEART = 'M6 10 2 6a2.5 2.5 0 0 1 4-3 2.5 2.5 0 0 1 4 3Z';
const HEART_SMALL = 'M6 9 3 6a2 2 0 0 1 3-2.5A2 2 0 0 1 9 6Z';
const USER_HEAD = rect(4, 1, 4, 4, 1.5);
const USER_BODY = 'M2 11a4 4 0 0 1 8 0';
const PANE = rect(1, 2, 10, 8, 1);
const SKULL = 'M3 10V8L1 6V4C1 2 3.5 1 6 1s5 1 5 3v2L9 8v2Z';
const SKULL_SMALL = 'M4 10V8.5L2 7V5c0-2 2-3 4-3s4 1 4 3v2L8 8.5V10Z';
const PLAY = 'M4 2l6 4-6 4Z';
const PLAY_SMALL = 'M4 3l5 3-5 3Z';
const SEARCH_LENS = circle(5, 5, 3);
const LINK = 'M5 4H3a2 2 0 0 0 0 4h2M7 4h2a2 2 0 0 1 0 4H7';
const LINK_SMALL = 'M5 4H4a2 2 0 0 0 0 4h1M7 4h1a2 2 0 0 1 0 4H7';
const CHECK = 'M2 6l3 3 5-5';
const CHECK_SMALL = 'M3 6l2 2 4-4';

export const GLYPHS = {
  // --- Marks -------------------------------------------------------------------------------------------------------
  plus: { m: ['M6 3v6M3 6h6'], s: ['M6 4v4M4 6h4'] },
  minus: { m: ['M3 6h6'], s: ['M4 6h4'] },
  cross: { m: ['M3 3l6 6M9 3 3 9'], s: ['M4 4l4 4M8 4 4 8'] },
  check: { m: [CHECK], s: [CHECK_SMALL] },
  divide: { m: ['M3 6h6', dot(6, 3), dot(6, 9)] },
  equal: { m: ['M3 5h6M3 7h6'] },
  hash: { m: ['M4 2v8M8 2v8M2 4h8M2 8h8'], s: ['M4 3v6M8 3v6M3 4h6M3 8h6'] },
  sigma: { m: ['M9 3V2H3l3 4-3 4h6V9'] },
  variable: { m: ['M3 2C1.7 3.3 1 4.7 1 6s.7 2.7 2 4M9 2c1.3 1.3 2 2.7 2 4s-.7 2.7-2 4M4 4l4 4M8 4 4 8'] },
  code: { m: ['M4 3 1 6l3 3M8 3l3 3-3 3'] },
  text: { m: ['M2 3V2h8v1M6 2v8M4 10h4'], s: ['M3 4V3h6v1M6 3v6M5 9h2'] },

  // --- Chevrons and arrows -----------------------------------------------------------------------------------------
  chevronDown: { m: ['M3 5l3 3 3-3'], s: ['M4 5l2 2 2-2'] },
  chevronUp: { m: ['M3 7l3-3 3 3'] },
  chevronLeft: { m: ['M7 3 4 6l3 3'] },
  chevronRight: { m: ['M5 3l3 3-3 3'], s: ['M5 4l2 2-2 2'] },
  chevronsLeftRight: { m: ['M4 3 1 6l3 3M8 3l3 3-3 3'] },
  arrowUp: { m: ['M6 2v8M3 5l3-3 3 3'], s: ['M6 3v6M4 5l2-2 2 2'] },
  arrowDown: { m: ['M6 2v8M3 7l3 3 3-3'], s: ['M6 3v6M4 7l2 2 2-2'] },
  arrowLeft: { m: ['M2 6h8M5 3 2 6l3 3'] },
  arrowRight: { m: ['M2 6h8M7 3l3 3-3 3'], s: ['M3 6h6M7 4l2 2-2 2'] },
  arrowsLeftRight: { m: ['M2 4h8M8 2l2 2-2 2M10 8H2M4 6 2 8l2 2'], s: ['M3 4h6L7 2M9 8H3l2 2'] },
  cornerDownRight: { m: ['M2 2v3a3 3 0 0 0 3 3h5M8 6l2 2-2 2'], s: ['M3 3v2a3 3 0 0 0 3 3h3M7 6l2 2-2 2'] },
  cornerLeftUp: { m: ['M10 9H7a3 3 0 0 1-3-3V2M2 4l2-2 2 2'], s: ['M9 9H7a2 2 0 0 1-2-2V3M3 5l2-2 2 2'] },
  rangeStart: { m: ['M4 2H2v8h2M10 6H5M7 4 5 6l2 2'] },
  rangeEnd: { m: ['M8 2h2v8H8M2 6h5M5 4l2 2-2 2'] },
  undo: { m: ['M4 2 2 4l2 2M2 4h5a3 3 0 0 1 0 6H5'], s: ['M5 3 3 5l2 2M3 5h4a2 2 0 0 1 0 4H5'] },
  redo: { m: ['M8 2l2 2-2 2M10 4H5a3 3 0 0 0 0 6h2'] },
  reset: { m: ['M2 7a4 4 0 1 0 4-4H4M6 1 4 3l2 2'], s: ['M3 7a3 3 0 1 0 3-3H5M6 2 4 4l2 2'] },
  rotate: { m: ['M10 7a4 4 0 1 1-4-4h2M6 1l2 2-2 2'], s: ['M9 7a3 3 0 1 1-3-3h1M6 2l2 2-2 2'] },
  refresh: { m: ['M2 6a4 4 0 0 1 4-4h2M7 1l1 1-1 1M10 6a4 4 0 0 1-4 4H4M5 9l-1 1 1 1'] },
  loop: {
    m: ['M2 6V4a1 1 0 0 1 1-1h8M9 1l2 2-2 2M10 6v2a1 1 0 0 1-1 1H1M3 7 1 9l2 2'],
    s: ['M3 6V5a1 1 0 0 1 1-1h6M8 2l2 2-2 2M9 6v1a1 1 0 0 1-1 1H2M4 6 2 8l2 2'],
  },
  loopOnce: { m: ['M2 6V4a1 1 0 0 1 1-1h8M9 1l2 2-2 2M10 6v2a1 1 0 0 1-1 1H1M3 7 1 9l2 2M5 6l1-1v3'] },
  move: {
    m: ['M6 1v10M1 6h10M4 3l2-2 2 2M4 9l2 2 2-2M3 4 1 6l2 2M9 4l2 2-2 2'],
    s: ['M6 2v8M2 6h8M5 3l1-1 1 1M5 9l1 1 1-1M3 5 2 6l1 1M9 5l1 1-1 1'],
  },
  expand: { m: ['M7 1h4v4M5 11H1V7M11 1 7 5M1 11l4-4'] },
  frame: { m: ['M1 4V2a1 1 0 0 1 1-1h2M8 1h2a1 1 0 0 1 1 1v2M11 8v2a1 1 0 0 1-1 1H8M4 11H2a1 1 0 0 1-1-1V8', dot(6, 6)] },
  externalLink: { m: ['M9 7v3a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3M7 1h4v4M11 1 5 7'] },
  upload: {
    m: ['M1 8v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8M6 8V1M3 4l3-3 3 3'],
    s: ['M2 8v1a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V8M6 7V2M4 4l2-2 2 2'],
  },
  download: { m: ['M1 8v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8M6 1v7M3 5l3 3 3-3'] },
  send: { m: [...body('M1 2l10 4-10 4 2-4Z'), 'M3 6h3'] },
  mirror: { m: [...body('M4 3v6H1Z'), 'M8 3v6h3ZM6 1v2M6 5v2M6 9v2'] },
  merge: { m: ['M2 1v2l4 4v4M10 1v2L6 7M4 9l2 2 2-2'], s: ['M3 2v1l3 3v4M9 2v1L6 6M4 8l2 2 2-2'] },
  scale: {
    m: ['M6 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M8 1h3v3M11 1 6 6M6 4v2H4'],
    s: ['M6 2H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6M8 2h2v2M10 2 6 6'],
  },
  sequence: { m: ['M2 2v8M1 8l1 2 1-2M5 3h6M5 6h6M5 9h6'] },

  // --- Playback ----------------------------------------------------------------------------------------------------
  play: { m: body(PLAY), s: body(PLAY_SMALL) },
  pause: { m: [...body(rect(3, 2, 2, 8)), ...body(rect(7, 2, 2, 8))], s: [rect(4, 3, 1, 6), rect(7, 3, 1, 6)] },
  stop: { m: body(rect(2, 2, 8, 8, 1)), s: body(rect(3, 3, 6, 6, 1)) },
  stepForward: { m: [...body('M2 2l6 4-6 4Z'), 'M10 2v8'] },
  stepBack: { m: [...body('M10 2 4 6l6 4Z'), 'M2 2v8'] },
  skipBack: { m: [...body('M7 2 3 6l4 4Z'), ...body('M11 2 7 6l4 4Z'), 'M1 2v8'] },
  spinner: { m: ['M11 6a5 5 0 1 1-5-5'], s: ['M10 6a4 4 0 1 1-4-4'] },

  // --- Status -------------------------------------------------------------------------------------------------------
  info: { m: [...body(circle(6, 6, 5)), 'M6 5v3', dot(6, 3)] },
  warning: { m: [...body('M6 1l5 10H1Z'), 'M6 5v2', dot(6, 9)], s: [...body('M6 2l4 8H2Z'), 'M6 5v1', dot(6, 8)] },
  error: { m: [...body(circle(6, 6, 5)), 'M6 3v4', dot(6, 9)] },
  checkCircle: { m: [...body(circle(6, 6, 5)), 'M3 6l2 2 4-4'], s: [...body(circle(6, 6, 4)), 'M4 6l1 1 3-3'] },
  exit: { m: ['M7 1H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h4M5 6h6M9 4l2 2-2 2'] },

  // --- Edit ---------------------------------------------------------------------------------------------------------
  trash: {
    m: [tone('M2 3h8v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z'), 'M1 3h10M5 3V2h2v1M2 3v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V3M5 5v3M7 5v3'],
    s: [tone('M3 4h6v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z'), 'M2 4h8M5 4V3h2v1M3 4v5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4M6 6v2'],
  },
  copy: {
    m: ['M2 8a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1', ...body(rect(4, 4, 7, 7, 1))],
    s: ['M3 7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1', ...body(rect(5, 5, 5, 5, 1))],
  },
  pencil: { m: [...body('M8 2l2 2-6 6-3 1 1-3Z'), 'M7 3l2 2'] },
  save: {
    m: [...body('M1 2a1 1 0 0 1 1-1h7l2 2v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1Z'), 'M3 1v3h5V1M3 11V7h6v4'],
  },
  search: { m: [tone(SEARCH_LENS), SEARCH_LENS, 'M7 7l3 3'], s: [...body(rect(3, 3, 4, 4, 1.5)), 'M7 7l2 2'] },
  filter: { m: body('M1 2h10L7 6v4l-2 1V6Z') },
  sliders: { m: ['M1 2h2M6 2h5M1 6h6M10 6h1M1 10h3M7 10h4', ...body(rect(3, 1, 2, 2)), ...body(rect(7, 5, 2, 2)), ...body(rect(4, 9, 2, 2))] },
  gear: {
    m: [...body(gear(6, 6, 8, 5, 3.5, 1, 1.5)), circle(6, 6, 1)],
    s: [...body(gear(6, 6, 8, 4, 2.9, 0.6, 1)), dot(6, 6, 0.7)],
  },
  toggle: {
    m: [tone(rect(1, 3, 10, 6, 3)), rect(1, 3, 10, 6, 3), solid(circle(4, 6, 1.5))],
    s: [tone(rect(2, 4, 8, 4, 2)), rect(2, 4, 8, 4, 2), solid(circle(4, 6, 1))],
  },
  power: { m: ['M6 1v5M8.83 3.17a4 4 0 1 1-5.66 0'], s: ['M6 2v4M8.12 3.88a3 3 0 1 1-4.24 0'] },
  eye: {
    m: [tone('M1 6c1.25-2 3-3 5-3s3.75 1 5 3c-1.25 2-3 3-5 3S2.25 8 1 6Z'), 'M1 6c1.25-2 3-3 5-3s3.75 1 5 3c-1.25 2-3 3-5 3S2.25 8 1 6Z', solid(circle(6, 6, 1.5))],
    s: [tone('M2 6c1-1.33 2.5-2 4-2s3 .67 4 2c-1 1.33-2.5 2-4 2s-3-.67-4-2Z'), 'M2 6c1-1.33 2.5-2 4-2s3 .67 4 2c-1 1.33-2.5 2-4 2s-3-.67-4-2Z', solid(circle(6, 6, 1))],
  },
  eyeOff: {
    m: ['M1 6A5.667 5.667 0 0 1 2.457 4.244M4.774 3.134A5.667 5.667 0 0 1 11 6 5.667 5.667 0 0 1 9.543 7.756M7.226 8.866A5.667 5.667 0 0 1 1 6M2 2l8 8'],
    s: ['M2 6A5 5 0 0 1 3.233 4.835M5.469 4.028A5 5 0 0 1 10 6 5 5 0 0 1 8.767 7.165M6.535 7.971A5 5 0 0 1 2 6M3 3l6 6'],
  },
  lock: { m: [...body(rect(2, 5, 8, 6, 1)), 'M4 5V3a2 2 0 0 1 4 0v2', dot(6, 8)] },
  unlock: { m: [...body(rect(2, 5, 8, 6, 1)), 'M4 5V3a2 2 0 0 1 4 0', dot(6, 8)] },
  link: { m: [LINK, 'M4 6h4'], s: [LINK_SMALL, 'M5 6h2'] },
  unlink: { m: [LINK, 'M6 1v1M6 10v1'], s: [LINK_SMALL, 'M6 2v1M6 9v1'] },

  // --- Files and places ----------------------------------------------------------------------------------------------
  file: { m: [...body(FILE), FILE_FOLD] },
  document: { m: [...body(FILE), FILE_FOLD, 'M4 6h4M4 8h3'] },
  filePlus: { m: [tone('M3 1h4l3 3v2H7v5H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1Z'), 'M5 11H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h4l3 3v1', FILE_FOLD, 'M9 7v4M7 9h4'] },
  script: { m: [...body(FILE), FILE_FOLD, 'M5 6 4 7l1 1M7 6l1 1-1 1'] },
  blueprint: { m: [...body(FILE), FILE_FOLD, block(4, 4, 2, 2), block(7, 8, 2, 2), 'M5 6v3h2'] },
  modelFile: { m: [...body(FILE), FILE_FOLD, 'M6 5l2 1v2l-2 1-2-1V6ZM4 6l2 1 2-1M6 7v2'] },
  folder: { m: body(FOLDER), s: body(FOLDER_SMALL) },
  folderOpen: { m: ['M1 10V3a1 1 0 0 1 1-1h2l1 1h4a1 1 0 0 1 1 1v2', ...body('M1 10l2-4h8l-2 4Z')] },
  folderPlus: {
    m: [tone('M1 3a1 1 0 0 1 1-1h2l1 1h5a1 1 0 0 1 1 1v2H6v4H2a1 1 0 0 1-1-1Z'), 'M5 10H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h2l1 1h5a1 1 0 0 1 1 1v1M9 7v4M7 9h4'],
  },
  folderMove: { m: [tone('M3 3a1 1 0 0 1 1-1h2l1 1h3a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z'), 'M3 5V3a1 1 0 0 1 1-1h2l1 1h3a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1M1 7h6M5 5l2 2-2 2'] },
  drive: { m: [...body(rect(1, 2, 10, 8, 1)), 'M1 6h10', dot(3, 8), dot(5, 8)], s: [...body(rect(2, 3, 8, 6, 1)), 'M2 6h8', dot(4, 8)] },
  database: { m: [tone(ellipse(6, 3, 5, 2)), ellipse(6, 3, 5, 2), 'M1 3v6a5 2 0 0 0 10 0V3M1 6a5 2 0 0 0 10 0'] },
  package: { m: [tone(CUBE_TOP), CUBE, CUBE_EDGES, 'M4 3l4 2v2'], s: [tone(CUBE_TOP), CUBE, CUBE_EDGES, 'M4 3l4 2v2'] },
  packagePlus: { m: [tone('M5 1l4 2-4 2-4-2Z'), 'M9 5V3L5 1 1 3v4l4 2M1 3l4 2 4-2M5 5v4M3 2l4 2v1M9 7v4M7 9h4'] },
  cube: { m: [tone(CUBE_TOP), CUBE, CUBE_EDGES], s: [tone(CUBE_TOP), CUBE, CUBE_EDGES] },
  cubes: {
    m: [
      tone('M6 1l2 1-2 1-2-1Z'), 'M6 1l2 1v3L6 6 4 5V2ZM4 2l2 1 2-1M6 3v3',
      tone('M3 6l2 1-2 1-2-1Z'), 'M3 6l2 1v3l-2 1-2-1V7ZM1 7l2 1 2-1M3 8v3',
      tone('M9 6l2 1-2 1-2-1Z'), 'M9 6l2 1v3l-2 1-2-1V7ZM7 7l2 1 2-1M9 8v3',
    ],
  },
  components: {
    m: [...body(rect(1, 1, 4, 4, 1)), ...body('M9 1l2 2-2 2-2-2Z'), ...body(rect(1, 7, 4, 4, 1)), ...body(rect(7, 7, 4, 4, 1))],
    s: [...body(rect(2, 2, 3, 3, 1)), ...body('M8.5 2 10 3.5 8.5 5 7 3.5Z'), ...body(rect(2, 7, 3, 3, 1)), ...body(rect(7, 7, 3, 3, 1))],
  },
  puzzle: { m: body('M1 3h3V2a1 1 0 0 1 2 0v1h3v3h1a1 1 0 0 1 0 2H9v3H1Z') },
  layers: {
    m: [...body('M6 1l4 2-4 2-4-2Z'), 'M2 6l4 2 4-2M2 9l4 2 4-2'],
    s: [...body('M6 2l4 2-4 2-4-2Z'), 'M2 7l4 2 4-2'],
  },
  graph: {
    m: [...body(rect(4, 1, 4, 3, 1)), ...body(rect(1, 8, 4, 3, 1)), ...body(rect(7, 8, 4, 3, 1)), 'M6 4v2M3 8V6h6v2'],
    s: [...body(rect(5, 2, 2, 2)), ...body(rect(2, 8, 2, 2)), ...body(rect(8, 8, 2, 2)), 'M6 4v2M3 8V6h6v2'],
  },
  flow: {
    m: [...body(rect(1, 1, 4, 4, 1)), ...body(rect(7, 7, 4, 4, 1)), 'M3 5v2a2 2 0 0 0 2 2h2'],
    s: [...body(rect(2, 2, 3, 3, 1)), ...body(rect(7, 7, 3, 3, 1)), 'M3 5v2a1 1 0 0 0 1 1h3'],
  },
  branch: { m: ['M3 1v7', circle(3, 10, 1), circle(9, 3, 1), 'M9 4c0 3-3 5-6 5'] },
  fork: {
    m: [circle(3, 2, 1), circle(9, 2, 1), circle(6, 10, 1), 'M3 3v2a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V3M6 6v3'],
    s: [circle(4, 3, 1), circle(8, 3, 1), circle(6, 9, 1), 'M4 4v1a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V4M6 6v2'],
  },
  transition: { m: ['M1 6h3M8 6h3', ...body(circle(6, 6, 2))] },

  // --- Pictures, sound and motion ------------------------------------------------------------------------------------
  image: {
    m: [...body(PANE), circle(4, 5, 1), 'M3 10l5-5 3 3'],
    s: [...body(rect(2, 3, 8, 6, 1)), dot(5, 5), 'M4 9l3-3 3 3'],
  },
  imageOff: { m: [...body(PANE), 'M1 1l10 10'] },
  film: {
    m: [...body(rect(1, 1, 10, 10, 1)), 'M4 1v10M8 1v10M1 4h3M1 8h3M8 4h3M8 8h3'],
    s: [...body(rect(2, 2, 8, 8, 1)), 'M4 2v8M8 2v8M2 6h2M8 6h2'],
  },
  video: { m: [...body(rect(1, 3, 7, 6, 1)), 'M8 6l3-2v4Z'], s: [...body(rect(2, 4, 5, 4, 1)), 'M7 6l3-2v4Z'] },
  camera: { m: [...body(rect(1, 4, 10, 6, 1)), 'M4 4l1-2h2l1 2', circle(6, 7, 1), dot(9, 6, 0.5)] },
  aperture: { m: [...body(circle(6, 6, 5)), 'M6 1l2 4M11 6l-4 2M6 11 4 7M1 6l4-2'] },
  captions: { m: [...body(PANE), 'M3 6h3M8 6h1M3 8h1M6 8h3'], s: [...body(rect(2, 3, 8, 6, 1)), 'M4 5h2M7 5h1M4 7h1M6 7h2'] },
  music: {
    m: [solid(circle(3, 9, 1.5)), solid(circle(9, 8, 1.5)), 'M4 9V3l6-1v6'],
    s: [solid(circle(4, 9, 1.1)), solid(circle(8, 8, 1.1)), 'M5 9V4l4-1v5'],
  },
  volume: { m: [...body(SPEAKER), 'M7 5a1 1 0 0 1 0 2M8 2a5 5 0 0 1 0 8'] },
  mute: { m: [...body(SPEAKER), 'M7 4l4 4M11 4 7 8'], s: [...body(SPEAKER_SMALL), 'M7 5l2 2M9 5 7 7'] },
  radio: {
    m: [solid(circle(6, 6, 1.2)), 'M3.88 3.88a3 3 0 0 0 0 4.24M8.12 3.88a3 3 0 0 1 0 4.24M2.46 2.46a5 5 0 0 0 0 7.08M9.54 2.46a5 5 0 0 1 0 7.08'],
    s: [solid(circle(6, 6, 1)), 'M3.88 3.88a3 3 0 0 0 0 4.24M8.12 3.88a3 3 0 0 1 0 4.24'],
  },
  megaphone: { m: [...body('M2 4h2l6-3v10L4 8H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z'), 'M4 8l1 3'] },
  pulse: { m: ['M1 6h2l2-4 2 8 2-4h2'], s: ['M2 6h2l1-3 2 6 1-3h2'] },
  sparkles: {
    m: [...body(glint(5, 5, 4)), solid(glint(9.5, 9.5, 1.8)), dot(10, 2, 0.55)],
    s: [...body(glint(5.5, 5.5, 3.5)), solid(glint(9, 9, 1.3))],
  },
  wand: { m: ['M1 11l6-6M9 1v4M7 3h4', dot(4, 2), dot(10, 8)], s: ['M2 10l4-4M8 2v4M6 4h4'] },
  spline: { m: [circle(2, 10, 1), circle(10, 2, 1), 'M2 9C2 5 5 2 9 2'], s: [circle(3, 9, 1), circle(9, 3, 1), 'M3 8c0-3 2-5 5-5'] },
  route: {
    m: [circle(2, 10, 1), circle(10, 2, 1), 'M3 10h4a2 2 0 0 0 0-4H5a2 2 0 0 1 0-4h4'],
    s: [circle(3, 9, 1), circle(9, 3, 1), 'M4 9h3V6H5V3h3'],
  },
  waypoints: {
    m: [circle(2, 8, 1), circle(6, 4, 1), circle(10, 8, 1), 'M3 7l2-2M7 5l2 2'],
    s: [circle(3, 8, 1), circle(6, 5, 1), circle(9, 8, 1), 'M4 7l1-1M7 6l1 1'],
  },
  axes: { m: ['M4 1v7h7M4 8l-3 3M3 2l1-1 1 1M10 7l1 1-1 1'], s: ['M4 2v6h6M4 8l-2 2M3 3l1-1 1 1M9 7l1 1-1 1'] },
  orbit: { m: [ellipse(6, 6, 5, 2), 'M6 1v3M6 8v3', solid(circle(6, 6, 1.3))] },
  crosshair: {
    m: [circle(6, 6, 5), 'M6 1v3M6 8v3M1 6h3M8 6h3', dot(6, 6)],
    s: [circle(6, 6, 4), 'M6 2v2M6 8v2M2 6h2M8 6h2', dot(6, 6)],
  },
  target: { m: [tone(circle(6, 6, 5)), circle(6, 6, 5), circle(6, 6, 3), dot(6, 6)] },
  pointer: { m: body('M2 2l8 3-4 1-1 4Z') },
  click: { m: [...body('M5 5l6 2-3 1-1 3Z'), 'M5 1v2M1 5h2M2 2l1 1'], s: [...body('M5 5l5 2-2 1-1 2Z'), 'M5 2v1M2 5h1'] },
  lasso: { m: ['M3.5 8.7C2 8.1 1 7 1 5.5 1 3 3.2 1 6 1s5 2 5 4.5S8.8 10 6 10c-.8 0-1.6-.1-2.3-.4', circle(3, 9, 1), 'M3 10c0 .6.2 1 .6 1'] },
  selectBox: { m: ['M1 3V1h2M9 1h2v2M11 9v2H9M3 11H1V9M5 1h2M5 11h2M1 5v2M11 5v2'] },

  // --- Paint and build ----------------------------------------------------------------------------------------------
  palette: {
    m: [...body('M6 1C3.2 1 1 3.2 1 6s2.2 5 5 5c.8 0 1.3-.5 1.3-1.2 0-.5-.4-.8-.4-1.3 0-.6.5-1 1.1-1H9.5C10.4 7.5 11 6.8 11 6c0-2.8-2.2-5-5-5Z'), dot(3.5, 6), dot(4.5, 3.5), dot(7.5, 3.5)],
    s: [...body('M6 2C3.8 2 2 3.8 2 6s1.8 4 4 4c.6 0 1-.3 1-.8 0-.4-.3-.6-.3-1 0-.4.4-.7.8-.7H9c.6 0 1-.4 1-1C10 3.6 8.2 2 6 2Z'), dot(4, 5), dot(6, 4), dot(8, 5)],
  },
  material: { m: [...body(circle(6, 6, 5)), 'M1.4 7.5C3 9 9 9 10.6 7.5', solid(circle(4, 4, 1))] },
  brush: {
    m: ['M11 1 6 6', ...body('M5.5 6.2a2 2 0 0 0-2.8 0C1.5 7.4 2.3 9.2 1 10.6c1.6.6 3.6.4 4.8-.8a2 2 0 0 0 0-2.8Z')],
    s: ['M10 2 6 6', ...body('M5.5 6.4a1.6 1.6 0 0 0-2.2 0c-.9.9-.3 2.3-1.3 3.4 1.3.4 2.8.2 3.7-.7a1.6 1.6 0 0 0 0-2.2Z')],
  },
  bucket: { m: [tone('M1 6h8l-3.3 3.3a1 1 0 0 1-1.4 0Z'), 'M5 2l4 4-3.3 3.3a1 1 0 0 1-1.4 0L1 6ZM1 6h8M2 1l3 3', solid('M10 7.5c.6.9 1 1.6 1 2.2a1 1 0 0 1-2 0c0-.6.4-1.3 1-2.2Z')] },
  eraser: { m: [tone('M2 7l2-2 3 3-2 2Z'), 'M2 7l5-5 3 3-5 5ZM4 5l3 3M7 11h4'] },
  eyedropper: { m: ['M1 11l1-1M2 10l5-5M5 3l4 4', ...body('M7 3l1.6-1.6a1.4 1.4 0 0 1 2 2L9 5Z')] },
  scissors: {
    m: [circle(3, 3, 2), circle(3, 9, 2), 'M5 4l6 6M5 8l6-6'],
    s: [circle(4, 4, 1), circle(4, 8, 1), 'M5 5l4 4M5 7l4-4'],
  },
  hammer: { m: [...body('M5 5l4-4 2 2-4 4Z'), 'M1 11l5-5'] },
  retexture: { m: ['M6 4H2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V8', block(3, 6, 2, 2), block(5, 8, 2, 2), solid(glint(9, 3, 2))] },

  // --- World --------------------------------------------------------------------------------------------------------
  grid: {
    m: [...body(rect(1, 1, 10, 10, 1)), 'M4 1v10M8 1v10M1 4h10M1 8h10'],
    s: [...body(rect(2, 2, 8, 8, 1)), 'M6 2v8M2 6h8'],
  },
  tiles: { m: [...body(rect(1, 1, 4, 4, 1)), rect(7, 1, 4, 4, 1), rect(1, 7, 4, 4, 1), ...body(rect(7, 7, 4, 4, 1))] },
  layout: {
    m: [...body(rect(1, 1, 10, 3, 1)), rect(1, 6, 4, 5, 1), rect(7, 6, 4, 5, 1)],
    s: [...body(rect(2, 2, 8, 2, 1)), rect(2, 6, 3, 4, 1), rect(7, 6, 3, 4, 1)],
  },
  panel: { m: [...body(PANE), 'M1 5h10'] },
  viewSingle: { m: [...body(PANE), 'M6 4l2 1v2l-2 1-2-1V5ZM4 5l2 1 2-1M6 6v2'] },
  viewQuad: { m: [...body(PANE), 'M6 2v8M1 6h10'] },
  compare: { m: [tone('M2 2h4v8H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z'), PANE, 'M6 1v10'] },
  terrace: { m: body('M1 11V9h3V6h3V3h4v8Z') },
  mountain: { m: body('M1 10 5 2l3 6 1-2 2 4Z'), s: body('M2 9l3-6 2 4 1-2 2 4Z') },
  trees: { m: [...body('M4 1 1 7h6Z'), 'M4 7v4', ...body('M9 4l2 4H7Z'), 'M9 8v3'] },
  tree: { m: [...body('M6 1l3 3H8l3 3H1l3-3H3Z'), 'M6 7v4'] },
  smooth: { m: ['M1 5q2.5-4 5 0t5 0M1 10h10'] },
  ramp: { m: body('M1 9h10V4Z') },
  droplets: { m: [...body('M4 3C2.7 4.6 2 5.8 2 7a2 2 0 0 0 4 0c0-1.2-.7-2.4-2-4Z'), ...body('M9 1C8.2 2 7.8 2.8 7.8 3.6a1.2 1.2 0 0 0 2.4 0C10.2 2.8 9.8 2 9 1Z')] },
  wind: { m: ['M1 4h6a2 2 0 1 0-2-2M1 7h8a2 2 0 1 1-2 2M1 10h3'] },
  circleDashed: { m: [dashedCircle(6, 6, 5, 8, 0.5)] },
  sun: { m: [...body(rect(4, 4, 4, 4, 1.5)), 'M6 1v1M6 10v1M1 6h1M10 6h1M2.5 2.5l.7.7M9.5 2.5l-.7.7M2.5 9.5l.7-.7M9.5 9.5l-.7-.7'] },
  sunDim: {
    m: [...body(rect(4, 4, 4, 4, 1.5)), dot(6, 2), dot(6, 10), dot(2, 6), dot(10, 6), dot(3, 3), dot(9, 3), dot(3, 9), dot(9, 9)],
    s: [solid(circle(6, 6, 1.5)), dot(6, 3), dot(9, 6), dot(6, 9), dot(3, 6), dot(3, 3), dot(9, 3), dot(3, 9), dot(9, 9)],
  },
  moon: { m: body('M10 7.5A5 5 0 1 1 4.5 2 4 4 0 0 0 10 7.5Z') },
  cloud: { m: body(CLOUD_LOW) },
  rain: { m: [...body(CLOUD), 'M3 9l-1 2M6 9l-1 2M9 9l-1 2'] },
  fog: { m: [...body(CLOUD), 'M2 9h8M4 11h5'], s: [...body('M4 7a1.6 1.6 0 0 1-.2-3.2 2.4 2.4 0 0 1 4.5-.5A1.9 1.9 0 0 1 8 7Z'), 'M3 9h6'] },
  bulb: { m: [...body('M4 9V8C2.6 7.1 2 6 2 5a4 4 0 0 1 8 0c0 1-.6 2.1-2 3v1Z'), 'M4 11h4'] },
  spotlight: { m: [...body(rect(4, 1, 4, 3, 1)), tone('M4 4h4l3 6c-1 .7-2.5 1-5 1s-4-.3-5-1Z'), 'M4 4 1 10M8 4l3 6M1 10c1 .7 2.5 1 5 1s4-.3 5-1'] },
  globe: { m: [...body(circle(6, 6, 5)), 'M1 6h10M6 1C4.3 2.4 3.5 4.1 3.5 6s.8 3.6 2.5 5c1.7-1.4 2.5-3.1 2.5-5S7.7 2.4 6 1Z'] },
  magnet: { m: [tone('M1 1h3v5a2 2 0 0 0 4 0V1h3v5a5 5 0 0 1-10 0Z'), 'M1 1h3v5a2 2 0 0 0 4 0V1h3v5a5 5 0 0 1-10 0ZM1 3h3M8 3h3'] },
  pin: { m: [...body('M6 11C4 9 2 7 2 5a4 4 0 0 1 8 0c0 2-2 4-4 6Z'), circle(6, 5, 1)], s: [...body('M6 10C4.5 8.5 3 7 3 5a3 3 0 0 1 6 0c0 2-1.5 3.5-3 5Z'), dot(6, 5)] },

  // --- People and play ----------------------------------------------------------------------------------------------
  user: { m: [...body(USER_HEAD), ...body(USER_BODY)], s: [...body(circle(6, 4, 1)), ...body('M3 10a3 3 0 0 1 6 0')] },
  users: {
    m: [...body(rect(2, 2, 4, 4, 1.5)), ...body('M1 11a3 3 0 0 1 6 0'), 'M8 2a2 2 0 0 1 0 4M9 8a3 3 0 0 1 2 3'],
    s: [solid(circle(4, 4, 1.2)), solid(circle(8, 4, 1.2)), 'M2 9a2 2 0 0 1 4 0M6 9a2 2 0 0 1 4 0'],
  },
  userPlus: {
    m: [...body(rect(2, 2, 4, 4, 1.5)), ...body('M1 11a3 3 0 0 1 6 0'), 'M9 3v4M7 5h4'],
    s: [...body(circle(4, 4, 1)), ...body('M2 10a2 2 0 0 1 4 0'), 'M8 3v4M6 5h4'],
  },
  person: { m: [solid(circle(6, 2, 1.3)), 'M2 5h8M6 5v3M3 11l3-3 3 3'], s: [solid(circle(6, 3, 1.1)), 'M3 5h6M6 5v2M4 9l2-2 2 2'] },
  footprints: {
    m: [solid(rect(1.5, 6.5, 3, 4, 1.3)), dot(2, 5), dot(4, 5), solid(rect(7.5, 2.5, 3, 4, 1.3)), dot(8, 1), dot(10, 1)],
    s: [solid(rect(2.5, 6.5, 2, 3, 1)), dot(3, 5, 0.5), dot(5, 5, 0.5), solid(rect(7.5, 3.5, 2, 3, 1)), dot(7, 2, 0.5), dot(9, 2, 0.5)],
  },
  bone: { m: ['M4 8l4-4', solid(circle(2.5, 8.2, 1.3)), solid(circle(3.8, 9.5, 1.3)), solid(circle(8.2, 2.5, 1.3)), solid(circle(9.5, 3.8, 1.3))] },
  face: { m: [...body(circle(6, 6, 5)), dot(4, 5), dot(8, 5), 'M4 8c1 1 3 1 4 0'] },
  skull: {
    m: [...body(SKULL), 'M5 10V9M7 10V9', block(3, 4, 2, 2), block(8, 4, 2, 2)],
    s: [...body(SKULL_SMALL), 'M5 10V9M7 10V9', block(4, 5, 2, 2), block(7, 5, 2, 2)],
  },
  shield: { m: body('M2 2l4-1 4 1v4c0 2.5-1.8 4.3-4 5-2.2-.7-4-2.5-4-5Z'), s: body('M3 3l3-1 3 1v3c0 2-1.4 3.4-3 4-1.6-.6-3-2-3-4Z') },
  crown: { m: [...body('M1 3l2 3 3-4 3 4 2-3-1 6H2Z'), 'M2 11h8'] },
  swords: {
    m: ['M1 1h2l5 5M11 1H9L4 6M6 8l2-2M4 6l2 2M8 8l2 2M4 8l-2 2'],
    s: ['M2 2h1l4 4M10 2H9L5 6M5 8l2-2M5 6l2 2M8 8l1 1M4 8 3 9'],
  },
  bomb: { m: [...body(circle(5, 7, 4)), 'M8 4l2-2', dot(11, 1, 0.55), solid(circle(3.5, 5.5, 0.7))] },
  flame: {
    m: body('M6 1c1 2 4 3.5 4 6.5a4 4 0 0 1-8 0c0-1.5.5-2.5 1.5-3.5.2 1 .8 1.8 1.5 2C5 4.5 5 3 6 1Z'),
    s: body('M6 2c.8 1.6 3 2.8 3 5.2a3 3 0 0 1-6 0c0-1.2.4-2 1.1-2.8.2.8.6 1.4 1.2 1.6C5 4.6 5.2 3.4 6 2Z'),
  },
  heart: { m: body(HEART) },
  health: { m: [...body(HEART), 'M2 6h2l1-1.5 1 3L7 6h3'], s: [...body(HEART_SMALL), 'M6 5v2M5 6h2'] },
  damage: { m: [...body(HEART), 'M6 3 5 5l2 1-1 2'] },
  gamepad: { m: [...body(rect(1, 3, 10, 6, 3)), 'M3 6h2M4 5v2', dot(8, 5), dot(9, 7)] },
  keyboard: {
    m: [...body(rect(1, 3, 10, 6, 1)), dot(3, 5), dot(5, 5), dot(7, 5), dot(9, 5), 'M4 7h4'],
    s: [...body(rect(2, 3, 8, 6, 1)), dot(4, 5), dot(6, 5), dot(8, 5), 'M5 7h2'],
  },
  dice: {
    m: [...body(rect(2, 2, 8, 8, 1.5)), dot(4, 4), dot(8, 4), dot(6, 6), dot(4, 8), dot(8, 8)],
    s: [...body(rect(2, 2, 8, 8, 1.5)), dot(4, 4), dot(6, 6), dot(8, 8)],
  },
  car: { m: [tone('M1 6h10v3H1Z'), 'M2 9H1V6h10v3h-1M4 9h4M3 6l1-3h4l1 3', circle(3, 9, 1), circle(9, 9, 1)] },
  door: { m: [...body('M2 11V2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v9'), 'M1 11h10', dot(7, 6)] },
  doorOpen: { m: ['M7 2h2a1 1 0 0 1 1 1v8M1 11h2M7 11h4', ...body('M3 3l4-1v9l-4-1Z'), dot(5, 7, 0.5)] },
  chat: { m: body('M1 2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H6l-3 3V8H2a1 1 0 0 1-1-1Z') },
  commentAdd: { m: [...body('M1 2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 2V9H2a1 1 0 0 1-1-1Z'), 'M6 3v4M4 5h4'] },
  languages: { m: ['M1 3h5M3 1v2M2 3c0 2 1.5 3.5 3.5 4.5M5 3c-.5 2-2 3.5-4 4.5M6 11l2.5-6 2.5 6M7 9h3'] },
  book: { m: [...body('M1 2c2 0 3.5.5 5 1.5 1.5-1 3-1.5 5-1.5v8c-2 0-3.5.5-5 1.5-1.5-1-3-1.5-5-1.5Z'), 'M6 3.5v8'] },
  key: { m: [...body(circle(8, 4, 2)), 'M6 6l-5 5M3 9l1 1M2 10l1 1'], s: [...body(circle(8, 4, 1.5)), 'M6.5 5.5 2 10M4 8l1 1'] },
  paperclip: { m: ['M9 4v4a3 3 0 0 1-6 0V3a2 2 0 0 1 4 0v5a1 1 0 0 1-2 0V4'], s: ['M8 4v4a2 2 0 0 1-4 0V3a1 1 0 0 1 2 0v5'] },
  chip: { m: [...body(rect(3, 3, 6, 6, 1)), rect(5, 5, 2, 2), 'M5 1v2M7 1v2M5 9v2M7 9v2M1 5h2M1 7h2M9 5h2M9 7h2'] },
  offline: {
    m: [dot(6, 10), 'M3.88 7.88a3 3 0 0 1 4.24 0M1.76 5.76a6 6 0 0 1 8.48 0M2 2l8 8'],
    s: [dot(6, 9), 'M4.59 7.59a2 2 0 0 1 2.82 0M3 3l6 6'],
  },
  calculator: {
    m: [...body(rect(2, 1, 8, 10, 1)), 'M4 3h4', dot(4, 6), dot(6, 6), dot(8, 6), dot(4, 8), dot(6, 8), dot(8, 8)],
    s: [...body(rect(3, 2, 6, 8, 1)), 'M5 4h2', dot(5, 6), dot(7, 6), dot(5, 8), dot(7, 8)],
  },
  checkbox: { m: ['M8 2H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6M4 6l2 2 5-5'] },
  brain: {
    m: [
      ...body('M2 7.5C1 7 1 5 2.2 4.6 2 3 3.5 1.8 5 2.4 6 1.4 8 1.5 8.8 2.7c1.4-.1 2.5 1.1 2.2 2.5.6.9.3 2.3-.8 2.8-.2 1.2-1.5 1.8-2.6 1.3-.9.8-2.4.7-3.1-.2-1 .4-2.2 0-2.5-1.1Z'),
      'M8 9.5V11M4 5.5c.8-.6 1.8-.4 2.2.4M6.5 7.5c.5-.7 1.5-.8 2.2-.2',
    ],
  },
  bell: { m: [...body('M3 8V5a3 3 0 0 1 6 0v3l1 1H2Z'), 'M5 11h2M6 1v1'], s: [...body('M4 8V5a2 2 0 0 1 4 0v3l1 1H3Z'), 'M5 10h2'] },
  tag: { m: [...body('M1 2a1 1 0 0 1 1-1h4l5 5-5 5-5-5Z'), circle(4, 4, 1)] },
  flag: { m: ['M2 1v10', ...body('M2 2h8L8 4l2 2H2')], s: ['M3 2v8', ...body('M3 3h6L7 5l2 2H3')] },
  star: { m: body(star(6, 6.4, 5.2, 2.2)), s: body(star(6, 6.3, 4.2, 1.8)) },
  history: { m: ['M2 6a4 4 0 1 0 1.17-2.83M1 1.5v2.5h2.5M6 4v2l2 2'] },
  clock: { m: [...body(circle(6, 6, 5)), 'M6 3v3h3'] },
  timer: { m: [...body(circle(6, 7, 4)), 'M4 1h4M6 1v2M6 7l2-2'] },
  bolt: { m: body('M7 1 2 7h4l-1 4 5-6H6Z'), s: body('M7 2 3 7h3l-1 3 4-5H6Z') },
  boltOff: { m: ['M7 1 2 7h4l-1 4 5-6H6Z', 'M1 1l10 10'] },
} satisfies Record<string, Glyph>;

export type GlyphName = keyof typeof GLYPHS;

export const GLYPH_NAMES = Object.keys(GLYPHS) as GlyphName[];
