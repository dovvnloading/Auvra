/**
 * Starting points for a new gameplay script, offered by the Script component's inspector. Every
 * template is plain JavaScript (also valid TypeScript) and uses only the documented script API
 * (docs/scripting.md): top-level callback functions and the `ctx` they receive.
 */

/** One template the Script inspector can open in the editor. */
export interface ScriptTemplate {
    id: string;
    label: string;
    /** One line shown under the template picker. */
    description: string;
    source: string;
}

const EMPTY = `// Runs once, before the first update.
function onStart(ctx) {
}

// Runs every frame. dt is the time since the previous frame, in seconds.
function onUpdate(ctx, dt) {
}
`;

const ROTATE_AND_BOB = `// Spins this object around its Y axis and bobs it up and down.
const SPIN_SPEED = 1.5; // radians per second
const BOB_HEIGHT = 0.25; // units above and below the start position
const BOB_SPEED = 2; // radians per second through the bob cycle

function onStart(ctx) {
    ctx.state.startPosition = ctx.self.position;
    ctx.state.startRotation = ctx.self.rotation;
    ctx.state.startTime = ctx.time;
}

function onUpdate(ctx) {
    // Work from the start transform and the elapsed time rather than adding a little every frame,
    // so the motion never drifts.
    const elapsed = ctx.time - ctx.state.startTime;
    const [x, y, z] = ctx.state.startPosition;
    const [rx, ry, rz] = ctx.state.startRotation;
    ctx.self.setPosition(x, y + Math.sin(elapsed * BOB_SPEED) * BOB_HEIGHT, z);
    ctx.self.setRotation(rx, ry + elapsed * SPIN_SPEED, rz);
}
`;

const DOOR_TRIGGER = `// Put this on a trigger volume (a Collider with Is Trigger on) next to a door.
// While anything is inside the trigger, the object named DOOR_NAME slides up by OPEN_HEIGHT;
// once everything has left, it slides back down.
const DOOR_NAME = 'Door';
const OPEN_HEIGHT = 3; // units
const SPEED = 2; // units per second

function onStart(ctx) {
    ctx.state.inside = 0;
    ctx.state.lift = 0;
    const door = ctx.find(DOOR_NAME);
    if (!door) {
        ctx.warn('No object named "' + DOOR_NAME + '" for this door trigger.');
        return;
    }
    ctx.state.doorId = door.id;
    ctx.state.closedPosition = door.position;
}

function onTriggerEnter(ctx) {
    ctx.state.inside += 1;
}

function onTriggerExit(ctx) {
    ctx.state.inside = Math.max(0, ctx.state.inside - 1);
}

function onUpdate(ctx, dt) {
    const door = ctx.state.doorId ? ctx.get(ctx.state.doorId) : null;
    if (!door) return;
    const target = ctx.state.inside > 0 ? OPEN_HEIGHT : 0;
    if (ctx.state.lift === target) return;
    const step = SPEED * dt;
    ctx.state.lift = ctx.state.lift < target
        ? Math.min(target, ctx.state.lift + step)
        : Math.max(target, ctx.state.lift - step);
    const [x, y, z] = ctx.state.closedPosition;
    door.setPosition(x, y + ctx.state.lift, z);
}
`;

const COLLECTIBLE = `// Put this on a pickup that has a Collider with Is Trigger on.
// When the player enters it, it adds POINTS to the level variable SCORE_VARIABLE, plays
// PICKUP_SOUND (an audio id; leave it empty for no sound) and removes itself.
// Show the score on the HUD by binding a Text Block to vars.score.
const SCORE_VARIABLE = 'score';
const POINTS = 1;
const PICKUP_SOUND = '';
const SPIN_SPEED = 2; // radians per second

function onStart(ctx) {
    ctx.state.startRotation = ctx.self.rotation;
    ctx.state.startTime = ctx.time;
}

function onUpdate(ctx) {
    const [rx, ry, rz] = ctx.state.startRotation;
    ctx.self.setRotation(rx, ry + (ctx.time - ctx.state.startTime) * SPIN_SPEED, rz);
}

function onTriggerEnter(ctx, other) {
    // other is the object that entered, or null for the player: only the player collects it.
    if (other) return;
    const score = Number(ctx.vars.get(SCORE_VARIABLE)) || 0;
    ctx.vars.set(SCORE_VARIABLE, score + POINTS);
    if (PICKUP_SOUND) ctx.playSound(PICKUP_SOUND, 'sfx');
    ctx.self.destroy();
}
`;

const SPAWNER = `// Spawns a copy of a prefab above this object every INTERVAL seconds, keeping at most
// MAX_ALIVE copies in the level at once. Set PREFAB_ID to the prefab's id: the editor's
// API reference panel lists the project's prefabs and inserts an id with one click.
const PREFAB_ID = '';
const INTERVAL = 3; // seconds
const MAX_ALIVE = 5;
const HEIGHT = 1; // units above this object

function onStart(ctx) {
    ctx.state.nextSpawn = ctx.time + INTERVAL;
    ctx.state.pending = [];
    ctx.state.alive = [];
    if (!PREFAB_ID) ctx.warn('Set PREFAB_ID to the id of the prefab to spawn.');
}

function onUpdate(ctx) {
    if (!PREFAB_ID || ctx.time < ctx.state.nextSpawn) return;
    ctx.state.nextSpawn = ctx.time + INTERVAL;
    // Forget copies that have been destroyed since.
    ctx.state.alive = ctx.state.alive.filter((id) => ctx.get(id));
    if (ctx.state.alive.length + ctx.state.pending.length >= MAX_ALIVE) return;
    // A root object's position is in world space, which is what ctx.spawn takes.
    const [x, y, z] = ctx.self.position;
    ctx.state.pending.push(ctx.spawn(PREFAB_ID, [x, y + HEIGHT, z]));
}

function onSpawned(ctx, requestId, objectIds) {
    const index = ctx.state.pending.indexOf(requestId);
    if (index === -1) return;
    ctx.state.pending.splice(index, 1);
    // The first id is the copy's root object; there are none when the prefab is missing.
    if (objectIds.length > 0) ctx.state.alive.push(objectIds[0]);
}
`;

/** The templates the Script inspector offers, Empty first. */
export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
    { id: 'empty', label: 'Empty', description: 'onStart and onUpdate, ready to fill in.', source: EMPTY },
    { id: 'rotate-bob', label: 'Rotate and bob', description: 'Spins the object and bobs it up and down.', source: ROTATE_AND_BOB },
    { id: 'door-trigger', label: 'Door opened by trigger', description: 'On a trigger volume: slides a named door open while something is inside.', source: DOOR_TRIGGER },
    { id: 'collectible', label: 'Collectible', description: 'On a trigger pickup: adds to a score variable and removes itself.', source: COLLECTIBLE },
    { id: 'spawner', label: 'Spawner', description: 'Spawns a prefab every few seconds, up to a limit.', source: SPAWNER },
];
