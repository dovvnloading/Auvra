import * as THREE from 'three';
import type { BuiltinSprite } from './particleEffect';

/**
 * The engine's particle sprites, drawn once on a canvas: white shapes whose brightness and alpha
 * the particles tint (soft puffs, smoke, sparks, glows, rings, stars, an animated flame, raindrops,
 * snowflakes, leaves, confetti and rock debris). Some are flipbooks: variants picked at random, or
 * the flame's frames played over a particle's life.
 */

/** Each sprite's flipbook grid. */
export const SPRITE_GRIDS: Record<BuiltinSprite, [columns: number, rows: number]> = {
    soft: [1, 1], smoke: [2, 2], spark: [1, 1], glow: [1, 1], ring: [1, 1], star: [1, 1], flame: [4, 4],
    droplet: [1, 1], snowflake: [2, 2], leaf: [2, 2], square: [1, 1], debris: [2, 2],
};

const FRAME = 128;

/** A small seeded random, so the sprites come out the same every time. */
const seeded = (seed: number) => {
    let state = seed >>> 0 || 1;
    return () => {
        state ^= state << 13; state >>>= 0;
        state ^= state >> 17;
        state ^= state << 5; state >>>= 0;
        return state / 4294967296;
    };
};

type Draw = (context: CanvasRenderingContext2D, frame: number, frames: number, random: () => number) => void;

const radial = (context: CanvasRenderingContext2D, x: number, y: number, radius: number, stops: [number, string][]) => {
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    for (const [at, color] of stops) gradient.addColorStop(at, color);
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
};

const DRAW: Record<BuiltinSprite, Draw> = {
    soft: context => radial(context, 64, 64, 62, [[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]),
    smoke: (context, _frame, _frames, random) => {
        // A billow of overlapping puffs inside a soft round edge.
        for (let i = 0; i < 26; i++) {
            const angle = random() * Math.PI * 2;
            const distance = Math.sqrt(random()) * 30;
            const radius = 14 + random() * 22;
            radial(context, 64 + Math.cos(angle) * distance, 64 + Math.sin(angle) * distance, radius,
                [[0, `rgba(255,255,255,${0.16 + random() * 0.12})`], [1, 'rgba(255,255,255,0)']]);
        }
        context.globalCompositeOperation = 'destination-in';
        radial(context, 64, 64, 63, [[0, 'rgba(255,255,255,1)'], [0.6, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)']]);
        context.globalCompositeOperation = 'source-over';
    },
    spark: context => {
        // A streak along the quad's up axis, which stretched particles point along their motion.
        const gradient = context.createLinearGradient(64, 4, 64, 124);
        gradient.addColorStop(0, 'rgba(255,255,255,0)');
        gradient.addColorStop(0.5, 'rgba(255,255,255,1)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        context.fillStyle = gradient;
        context.beginPath();
        context.ellipse(64, 64, 9, 60, 0, 0, Math.PI * 2);
        context.fill();
    },
    glow: context => radial(context, 64, 64, 62, [[0, 'rgba(255,255,255,1)'], [0.12, 'rgba(255,255,255,0.9)'], [0.35, 'rgba(255,255,255,0.3)'], [1, 'rgba(255,255,255,0)']]),
    ring: context => radial(context, 64, 64, 62, [[0, 'rgba(255,255,255,0)'], [0.72, 'rgba(255,255,255,0)'], [0.86, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]),
    star: context => {
        context.fillStyle = 'rgba(255,255,255,0.9)';
        for (const angle of [0, Math.PI / 2]) {
            context.save();
            context.translate(64, 64);
            context.rotate(angle);
            context.beginPath();
            context.ellipse(0, 0, 5, 60, 0, 0, Math.PI * 2);
            context.fill();
            context.restore();
        }
        radial(context, 64, 64, 34, [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
    },
    flame: (context, frame, frames, random) => {
        // A licking tongue of flame: puffs rising and narrowing, swaying from frame to frame.
        const phase = (frame / frames) * Math.PI * 2;
        for (let i = 0; i < 14; i++) {
            const rise = i / 13;
            const sway = Math.sin(phase + rise * 4 + random() * 0.5) * 10 * rise;
            const radius = 30 * (1 - rise * 0.8) + random() * 6;
            radial(context, 64 + sway, 100 - rise * 78, radius, [[0, `rgba(255,255,255,${0.5 - rise * 0.25})`], [1, 'rgba(255,255,255,0)']]);
        }
    },
    droplet: context => {
        const gradient = context.createLinearGradient(64, 0, 64, 128);
        gradient.addColorStop(0, 'rgba(255,255,255,0)');
        gradient.addColorStop(0.7, 'rgba(255,255,255,0.9)');
        gradient.addColorStop(1, 'rgba(255,255,255,0.3)');
        context.fillStyle = gradient;
        context.fillRect(58, 0, 12, 128);
    },
    snowflake: (context, frame) => {
        context.strokeStyle = 'rgba(255,255,255,0.95)';
        context.lineWidth = 7;
        context.lineCap = 'round';
        context.translate(64, 64);
        context.rotate(frame * 0.4);
        for (let arm = 0; arm < 6; arm++) {
            context.rotate(Math.PI / 3);
            context.beginPath();
            context.moveTo(0, 0);
            context.lineTo(0, 46);
            context.moveTo(0, 26);
            context.lineTo(12, 36);
            context.moveTo(0, 26);
            context.lineTo(-12, 36);
            context.stroke();
        }
        context.setTransform(1, 0, 0, 1, 0, 0);
        radial(context, 64, 64, 20, [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
    },
    leaf: (context, frame, _frames, random) => {
        context.translate(64, 64);
        context.rotate(frame * 1.3 + random());
        const width = 22 + random() * 10;
        context.fillStyle = 'rgba(255,255,255,1)';
        context.beginPath();
        context.moveTo(0, -56);
        context.quadraticCurveTo(width * 1.6, -10, 0, 56);
        context.quadraticCurveTo(-width * 1.6, -10, 0, -56);
        context.fill();
        // A darker midrib and veins.
        context.strokeStyle = 'rgba(150,150,150,1)';
        context.lineWidth = 3;
        context.beginPath();
        context.moveTo(0, -50);
        context.lineTo(0, 54);
        for (let vein = -30; vein <= 30; vein += 15) {
            context.moveTo(0, vein);
            context.lineTo(width * 0.7, vein - 12);
            context.moveTo(0, vein);
            context.lineTo(-width * 0.7, vein - 12);
        }
        context.stroke();
        context.setTransform(1, 0, 0, 1, 0, 0);
    },
    square: context => {
        context.fillStyle = 'rgba(255,255,255,1)';
        context.fillRect(20, 30, 88, 68);
    },
    debris: (context, _frame, _frames, random) => {
        // An irregular chip of rock, lit from the top left.
        const corners = 7 + Math.floor(random() * 3);
        const points: [number, number][] = [];
        for (let i = 0; i < corners; i++) {
            const angle = (i / corners) * Math.PI * 2;
            const radius = 34 + random() * 22;
            points.push([64 + Math.cos(angle) * radius, 64 + Math.sin(angle) * radius]);
        }
        const gradient = context.createLinearGradient(20, 20, 108, 108);
        gradient.addColorStop(0, 'rgba(255,255,255,1)');
        gradient.addColorStop(1, 'rgba(120,120,120,1)');
        context.fillStyle = gradient;
        context.beginPath();
        points.forEach(([x, y], i) => (i === 0 ? context.moveTo(x, y) : context.lineTo(x, y)));
        context.closePath();
        context.fill();
    },
};

const cache = new Map<BuiltinSprite, THREE.Texture>();

const fallback = (): THREE.Texture => {
    const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    texture.needsUpdate = true;
    return texture;
};

/** A built-in sprite's texture (its flipbook frames laid out in its grid), made once and shared. */
export const builtinSpriteTexture = (sprite: BuiltinSprite): THREE.Texture => {
    const cached = cache.get(sprite);
    if (cached) return cached;
    const [columns, rows] = SPRITE_GRIDS[sprite];
    let texture: THREE.Texture;
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    const context = canvas?.getContext('2d') ?? null;
    if (!canvas || !context) texture = fallback();
    else {
        canvas.width = FRAME * columns;
        canvas.height = FRAME * rows;
        const frames = columns * rows;
        // Each frame is drawn on its own canvas, so a drawing's transforms stay inside its cell.
        const cell = document.createElement('canvas');
        cell.width = FRAME;
        cell.height = FRAME;
        const cellContext = cell.getContext('2d')!;
        for (let frame = 0; frame < frames; frame++) {
            cellContext.setTransform(1, 0, 0, 1, 0, 0);
            cellContext.clearRect(0, 0, FRAME, FRAME);
            DRAW[sprite](cellContext, frame, frames, seeded(frame * 7919 + sprite.length * 104729));
            // Frame 0 at the top left, reading across then down.
            context.drawImage(cell, (frame % columns) * FRAME, Math.floor(frame / columns) * FRAME);
        }
        texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = true;
    }
    texture.name = `particle-sprite-${sprite}`;
    cache.set(sprite, texture);
    return texture;
};
