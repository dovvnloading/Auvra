# Gameplay scripting

A **Script** component runs your own JavaScript or TypeScript code on an object while the game plays. Use scripts for behaviour that is awkward to wire in the [Level Blueprint](level-scripting.md): per-object logic, timers, counters, small state machines and maths.

## Adding a script

1. Select an object and choose **Add Component > Script** in the inspector.
2. Click **Edit Script** to open the editor. To start from an example instead, pick one in the template list and click **New from Template**.
3. Write the script, click **Save** (or press **Ctrl+S**), then close the editor.

The inspector shows the first lines of the script, or **No script yet**. Nothing is stored until you save, and opening a template over an existing script replaces it only when you save. Each save is one undo step in the World Editor (**Ctrl+Z**).

An object can carry several Script components; each one runs separately, with its own `ctx.state`. Turn a component off to stop its script from running.

## The script editor

| Key | Does |
|---|---|
| Tab | Indents the selected lines. With nothing selected, inserts spaces up to the next indent stop (4 spaces) |
| Shift+Tab | Removes one indent step from the selected lines, or from the current line |
| Enter | Starts a new line at the same indentation, one step deeper after `{`, `(` or `[` |
| Ctrl+S | Saves |
| Ctrl+Z / Ctrl+Y | Undoes or redoes typing in the editor |
| Ctrl+M | Switches Tab between indenting and moving focus to the editor's buttons |
| Esc | Closes the editor |

- **Save** keeps the editor open; **Save & Close** saves and closes it. Closing with unsaved changes (Esc, **Cancel** or the close button) asks whether to discard them; **Keep Editing** goes back to the script.
- The status bar shows the cursor's line and column, the line count and the script's size against the 128 KiB limit. Over the limit, saving is disabled until the script is shorter.
- **API Reference** opens and closes a panel that lists the callbacks and the `ctx` API. Under **Insert an id** it lists the project's prefabs, sounds and levels: click one to insert its id, in quotes, at the cursor. These ids are what `ctx.spawn`, `ctx.playSound` and `ctx.openLevel` take.
- Keys pressed in the editor never trigger World Editor shortcuts.
- If a save fails (for example because the project is read-only), the editor says why and keeps your changes.

## Templates

| Template | Does |
|---|---|
| Empty | `onStart` and `onUpdate`, ready to fill in |
| Rotate and bob | Spins the object around its Y axis and bobs it up and down |
| Door opened by trigger | Goes on a trigger volume. While anything is inside, the object named `Door` slides up; once everything has left, it slides back down |
| Collectible | Goes on a pickup with a trigger collider. When the player enters, it adds 1 to the level variable `score`, optionally plays a sound and removes itself |
| Spawner | Spawns a prefab above the object every 3 seconds, keeping at most 5 copies at once. Set `PREFAB_ID` first |

Settings such as speeds, names and ids are constants at the top of each template. For trigger volumes, see [Triggers](world-editor.md#triggers).

## How scripts run

A script defines **callbacks**: top-level functions with fixed names. Define only the ones you need; the game calls each one with `ctx`, the script's view of the world.

```js
function onStart(ctx) {
    ctx.log('Hello from ' + ctx.self.name);
}

function onUpdate(ctx, dt) {
    ctx.self.translate(0, 0, 2 * dt);
}
```

- **Writing callbacks.** A callback can also be a top-level `const` holding a function, and `export` in front of one is allowed. Scripts cannot import other files or modules, and a script that defines none of the callbacks is reported as an error.
- **TypeScript.** Type annotations, interfaces and enums are accepted. Types are not checked.
- **When scripts load.** Scripts load once, when play starts: every enabled Script component with a non-empty script, on the objects in the level. Scripts on objects spawned later do not run. Top-level code runs once, as the script loads; use it for constants, and keep values that change in `ctx.state`.
- **Order in a frame.** Each frame, `onStart` runs for scripts that have not started yet, then the frame's events in the order they happened (`onTriggerEnter`, `onTriggerExit`, `onAnimNotify`, `onTimelineEvent`, `onDialogueEvent`, `onNetEvent`, `onVehicleEntered`, `onVehicleExited`, `onSpawned`), then every script's `onUpdate`. Scripts run in the order of their objects in the level. Callbacks stop running once their object is destroyed.
- **One frame behind.** Each frame the game hands scripts a snapshot of the world. Changes a script makes show at once to every script in the same frame: positions, visibility, destroyed objects and level variables read back as just set. The game itself applies them on the next frame, so things the game moves (the player, physics bodies) are seen as they were a frame ago, and the answers to `ctx.spawn` and `ctx.raycast` arrive on the next frame.
- **Sandboxed.** Scripts run in a separate sandboxed page. They cannot reach the editor, the game page, the project or its files; they see and change the world only through `ctx`. Everything a script changes lasts for the play session only.

## Callbacks

| Callback | Runs |
|---|---|
| `onStart(ctx)` | Once, before the script's first update |
| `onUpdate(ctx, dt)` | Every frame. `dt` is the time since the previous frame, in seconds |
| `onTriggerEnter(ctx, other)` | When something enters a trigger collider on this script's object. `other` is a handle for the object that entered, or `null` when it is the player |
| `onTriggerExit(ctx, other)` | When it leaves the trigger again |
| `onTimelineEvent(ctx, name, timelineObjectId)` | When a playing [timeline](timelines.md) crosses a key on one of its event tracks; `name` is the key's text. Reaches every script |
| `onAnimNotify(ctx, name, source)` | When an animation [notify](characters.md#notifies) named `name` is raised. `source` is `'player'` for the player character. A notify raised by a level object's own animation (`source` is its id) reaches only that object's scripts; every other notify reaches every script |
| `onDialogueEvent(ctx, name, objectId)` | When a [dialogue](dialogue.md) line or choice raises an event; `objectId` is the object whose Dialogue component holds the conversation. Reaches every script |
| `onVehicleEntered(ctx, vehicleId)`, `onVehicleExited(ctx, vehicleId)` | When the player gets into or out of a [vehicle](world-editor.md#vehicles). Reaches every script |
| `onNetEvent(ctx, name, value, fromPeerId)` | When another player's `ctx.net.send` (or **Send Network Event**) arrives in a [multiplayer](multiplayer.md) game. Reaches every script |
| `onSpawned(ctx, requestId, objectIds)` | On the script that called `ctx.spawn`, once the copy has been placed. `requestId` is the value `ctx.spawn` returned; `objectIds` are the new objects, root first, and empty when the prefab does not exist |

Triggers need a Collider with **Is Trigger** on, on the same object as the script (see [Physics](world-editor.md#physics)). The trigger callbacks also receive the entering object's id as a third argument, `'player'` for the player: `function onTriggerEnter(ctx, other, otherId)`.

## The ctx API

### Objects

| API | Returns |
|---|---|
| `ctx.self` | A handle for the object this script is on |
| `ctx.find(name)` | A handle for the first object with that name, or `null`. Names can repeat; keep the `id` if you need the same object later |
| `ctx.get(id)` | A handle for the object with that id, or `null` once it has been destroyed |
| `ctx.all()` | Handles for every object in the level |

A **handle** reads and changes one object:

| Member | Does |
|---|---|
| `id`, `name` | The object's id and name |
| `position`, `rotation`, `scale` | `[x, y, z]` arrays, including changes made this frame. They are copies: changing the array does nothing |
| `exists`, `visible` | Whether the object is still in the level, and whether it is shown |
| `setPosition(x, y, z)` | Moves the object. Every setter also takes one `[x, y, z]` array |
| `setRotation(x, y, z)` | Rotates the object. Angles are in **radians** (the inspector shows degrees; multiply degrees by `Math.PI / 180`) |
| `setScale(x, y, z)` | Scales the object |
| `translate(dx, dy, dz)` | Moves the object by an offset |
| `setVisible(visible)` | Shows (`true`) or hides (`false`) the object |
| `applyImpulse(x, y, z)` | Pushes an object that has a dynamic [Rigid Body](world-editor.md#rigid-body). Impulses given in one frame add up |
| `destroy()` | Removes the object, and its children, for the rest of the play session |

Transforms are relative to the object's parent, like the inspector's; for an object without a parent they are world positions. A handle of a destroyed object keeps working, but its setters do nothing.

### World

| API | Does |
|---|---|
| `ctx.player` | The player character, or `null` when there is no player: `position` and `rotation` as `[x, y, z]` arrays, `health`, `maxHealth`, the held `weapon`'s name (`''` for none), its `ammo` and the `reserve` carried (-1 for unlimited) |
| `ctx.time` | Seconds since play started |
| `ctx.delta` | Seconds since the previous frame (the same as `dt`) |
| `ctx.frame` | The frame number |
| `ctx.spawn(prefabId, [x, y, z])` | Places a copy of a [prefab](world-editor.md#prefabs) at a world position. Returns a request id; `onSpawned` reports the new objects on the next frame |
| `ctx.raycast(origin, direction, maxDistance)` | Casts a ray from `origin` along `direction` (both `[x, y, z]`), like the **Raycast** blueprint node. It ignores the script's own object. Returns a request id |
| `ctx.raycastResult(requestId)` | The answer, during the next frame only: `{ objectId, object, point, normal, distance }` (`object` is a handle, or `null`), or `null` when the ray hit nothing. In any other frame it is `undefined`, so keep what you need in `ctx.state` |
| `ctx.playSound(audioId, bus)` | Plays a sound once, in 2D. `bus` is optional: `'sfx'` (the default), `'music'`, `'ui'` or `'master'` |
| `ctx.playPlayerAnimation(clipName, maskBone)` | Plays a clip once on the player character, like the **Play Player Animation** node. `maskBone` is optional; see [One-shot animations](characters.md#one-shot-animations-on-part-of-the-body) |
| `ctx.damagePlayer(amount)` / `ctx.healPlayer(amount)` | Hurts or heals the player, like the **Damage Player** and **Heal Player** nodes |
| `ctx.addAmmo(rounds, weapon)` | Adds rounds to a weapon the player carries, by name; without `weapon`, the held one. Like the **Add Ammo** node |
| `ctx.giveWeapon(weapon)` | Gives the player a weapon by name and puts it in their hands, like the **Give Weapon** node |
| `ctx.setCamera(objectId, blendSeconds)` |Shows the view of the object's Camera component, blending over `blendSeconds` (default 0); `null` gives the view back to the gameplay camera. See [Camera cuts](timelines.md#camera-cuts) |
| `ctx.startDialogue(objectId)` | Opens the conversation of the object's Dialogue component, like the **Start Dialogue** node; without an id, the one on the script's own object. Does nothing while another conversation is open. See [Dialogue](dialogue.md) |
| `ctx.vehicle(objectId)` | The object's [Vehicle](world-editor.md#vehicles), or `null` when it has none: `speed` (km/h, negative backwards), `gear` (-1 in reverse), `playerDriving`, `enter()` (puts the player in), `setInput({ throttle, brake, steer, handbrake })` (drives it until released; throttle and brake 0-1, steer -1 to 1) and `release()` |
| `ctx.playerVehicle()` | The id of the vehicle the player drives, or `null` on foot |
| `ctx.exitVehicle()` | Takes the player out of their vehicle at once, beside it |
| `ctx.spline(objectId)` | The spline of the object's [Spline](world-editor.md#splines) component, in world space and metres, or `null` when it has none: `length`, `closed`, `pointAt(distance)` (its `position`, the `direction` it runs and its `up` there; distances wrap round a closed spline and stop at the ends of an open one) and `closest([x, y, z])` (the nearest `position` on it and the `distance` along it) |
| `ctx.openLevel(levelId)` | Loads another level, like the **Open Level** node. Inside the editor it prints a note instead. Commands issued after it in the same frame are dropped |

### Input, variables and state

| API | Does |
|---|---|
| `ctx.input.isDown(action)` | Whether an input action is held |
| `ctx.input.wasPressed(action)`, `ctx.input.wasReleased(action)` | Whether it went down, or up, since the previous frame |
| `ctx.input.value(action)` | An axis value from -1 to 1; 1 or 0 for buttons |
| `ctx.vars.get(name)` | The value of a [level variable](level-scripting.md#level-variables), or `undefined` when it is not set |
| `ctx.vars.set(name, value)` | Writes a level variable: a number, a boolean or a string of up to 4096 characters. Every script reads the new value at once; the Level Blueprint and the HUD see it from the next frame |
| `ctx.state` | An object that keeps its contents between callbacks for the rest of the play session, for this script only |
| `ctx.log(...)`, `ctx.warn(...)`, `ctx.error(...)` | Prints the values, separated by spaces, in the play output, labelled with the object's name: `[Script: Name] message`. Objects and arrays are printed as JSON |

### Multiplayer

| API | Does |
|---|---|
| `ctx.net.connected()` | True while connected to the relay |
| `ctx.net.isHost()` | True for the host, and always in single-player games |
| `ctx.net.selfId()`, `ctx.net.peers()` | This player's id (null offline), and the other players as `{ id, name }` |
| `ctx.net.send(name, value, toPeerId)` | Sends an event to every other player, or only to `toPeerId`. `value` is a number, true/false, text, a list of those or a flat object of those; names are at most 64 characters |

See [Multiplayer](multiplayer.md).

Unknown actions read as released. The actions are MoveForward, MoveBack, MoveLeft, MoveRight, Jump, Sprint, Fire, Aim, Interact, Reload, NextWeapon, Pause, Throttle, Brake, Handbrake, CameraView and LookBack; see [Controls](building-games.md#controls) for their keys. Near an object with a [Dialogue](dialogue.md) component, **Interact** opens its conversation; anywhere else it has no built-in use, so it is free for scripts.

## Examples

Toggle an object with **Interact** when the player is close:

```js
const RANGE = 2; // units

function onUpdate(ctx) {
    if (!ctx.player || !ctx.input.wasPressed('Interact')) return;
    const [px, , pz] = ctx.player.position;
    const [x, , z] = ctx.self.position;
    if (Math.hypot(px - x, pz - z) > RANGE) return;
    ctx.self.setVisible(!ctx.self.visible);
}
```

Drop an object onto whatever is below it when play starts:

```js
function onStart(ctx) {
    ctx.state.ray = ctx.raycast(ctx.self.position, [0, -1, 0], 100);
}

function onUpdate(ctx) {
    if (!ctx.state.ray) return;
    const hit = ctx.raycastResult(ctx.state.ray);
    if (hit === undefined) return; // the answer arrives on the next frame
    ctx.state.ray = null;
    if (hit) ctx.self.setPosition(hit.point);
}
```

A countdown shown on the HUD (bind a Text Block to `vars.timeLeft`, see [Live values](hud-and-menus.md#live-values)) that opens another level when it runs out:

```js
const SECONDS = 60;
const GAME_OVER_LEVEL = ''; // a level id, from Insert an id

function onStart(ctx) {
    ctx.state.endsAt = ctx.time + SECONDS;
}

function onUpdate(ctx) {
    const left = Math.max(0, Math.ceil(ctx.state.endsAt - ctx.time));
    if (left !== ctx.vars.get('timeLeft')) ctx.vars.set('timeLeft', left);
    if (left === 0 && !ctx.state.done) {
        ctx.state.done = true;
        if (GAME_OVER_LEVEL) ctx.openLevel(GAME_OVER_LEVEL);
        else ctx.warn('Time is up');
    }
}
```

Play a sound on the player's footstep notifies (insert the sound's id from the editor's **Insert an id** list):

```js
const FOOTSTEP_SOUND = '';

function onAnimNotify(ctx, name, source) {
    if (name === 'Footstep' && source === 'player' && FOOTSTEP_SOUND) ctx.playSound(FOOTSTEP_SOUND);
}
```

## Limits

| Limit | Value |
|---|---|
| Script size | 128 KiB each (the editor will not save a larger one) |
| Scripts in a level | 256, and 1 MiB of script text together |
| Commands per frame | 4096 for all scripts together (moves, spawns, sounds, variables, log lines, ...); the rest of that frame's commands are dropped, with one error |
| Time per callback | 8 ms or 200,000 steps, whichever comes first |
| Log lines | 1024 characters each; 32 lines shown per frame, the rest counted in one line |

Scripts over a size or count limit when play starts are not loaded; the play output says which ones and why.

## Errors

Script errors are printed in the play output as `[Script: Name] message`, with the line number where there is one. Each distinct error is shown once, and at most 50 per play session.

- **Compile errors** (a syntax error, an import) are reported when play starts, and that script does not run.
- **A callback that fails** is turned off for the rest of the play session: `onUpdate failed and is disabled: ...`. The script's other callbacks keep running. A callback fails when it throws, when it runs past its time budget (an endless loop, for example), or when it passes an API a wrong argument, such as `setPosition` without three numbers, `vars.set` with an object, or `ctx.raycast` with a zero direction.
- **Commands that cannot apply**, such as moving an object that has been destroyed, are ignored.
- If the script sandbox stops answering for 10 seconds, scripts are stopped for the rest of the play session and the play output says so.
