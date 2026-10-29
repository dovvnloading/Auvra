# Level scripting

Each level has a **Level Blueprint**: a node graph that runs while the level is played. Open it from the World Editor toolbar (**Open Level Blueprint Logic**).

Nodes are added from the palette. Select a node to edit it in the inspector: data inputs that are not wired can be filled in there, and wired ones show **Connected**. Nodes marked **PURE** have no execution pins; they are worked out each time a connected node reads them. If an object is selected in the World Editor when you add a node that targets an actor, the node uses that object.

## Events

| Event | Fires |
|---|---|
| Event BeginPlay | Once when the level starts (and again after a restart) |
| Event Tick | Every frame; provides Delta Seconds |
| On Overlap | When the player enters the chosen actor (palette: **Actor Begin Overlap**) |
| Network Event | When another player sends a network event with its name; provides Value (as text) and From (their player id). See [Multiplayer](multiplayer.md) |
| Dialogue Event | When a dialogue line or choice raises an event with its name (empty: any). See [Dialogue](dialogue.md#dialogue-events) |
| Vehicle Entered, Vehicle Exited | When the player gets into or out of the chosen [vehicle](world-editor.md#vehicles) (or any); provides the **Vehicle** |
| Object Broken | When the chosen object with a [Destructible](world-editor.md#destruction) component (or any) breaks; provides the **Actor** that broke |
| Ability Used | When the chosen actor (the player, an object with an [Abilities](world-editor.md#abilities) component, or any) uses the named ability (or any); provides the **Actor**, the **Ability** and its **Target** |
| Actor Died | When the chosen actor with an [Abilities](world-editor.md#abilities) component (or any) loses all its health; provides the **Actor** |

**On Overlap** targets a specific object, picked from a list showing its name, type and a short id. Renaming the object does not break the reference. Older graphs that referenced actors by name are converted automatically when the name is unique; ambiguous ones show a warning until you pick the actor.

How the player is detected depends on the target:

- **Collider with Is Trigger on**: fires when the player's capsule enters the volume. This is the precise option; see [Physics](world-editor.md#triggers).
- **No Collider**: fires when the player comes within roughly the object's horizontal scale (the larger of its X and Z scale, plus 0.5) of its position.
- **Solid Collider**: never fires, because the player cannot enter it. Add a separate trigger around it.

It fires once per entry, and again only after the player has left.

## Actions

| Node | Does |
|---|---|
| Print String | Shows a message on screen |
| Destroy Actor | Removes the overlapping actor for the rest of the play session |
| Restart Level | Restarts the level |
| End Game | Ends the level (returns to the title screen in a built game) |
| Open Level | Loads another level of the game |
| Save Game / Load Game | Saves or loads a checkpoint (optional slot name) |
| Branch (If) | Continues on True or False |
| Get / Set Variable | Reads or writes animation-graph variables on the player (**Entity Variables** section) |

Math (Add, Subtract, Multiply, Divide), comparisons (Greater, Less, Equal) and logic (And, Or) nodes feed values into actions. Literal nodes provide numbers, strings and booleans.

## Cameras

**Set Active Camera** switches the view to an object with a Camera component (picked in the inspector), or back to the gameplay camera, easing over its **Blend** seconds. Timelines can cut between cameras too; see [Camera cuts](timelines.md#camera-cuts).

## Dialogue

**Start Dialogue** opens the conversation of an object with a Dialogue component (picked in the inspector), wherever the player is. It does nothing while another conversation is open. Lines and choices can raise events that the **Dialogue Event** event handles. See [Dialogue](dialogue.md).

## Multiplayer

| Node | Does |
|---|---|
| Send Network Event | Sends its Name and Value to every other player |
| Is Network Host | True for the host, and in single-player games |

Use **Is Network Host** in front of anything that must happen once for everyone, and **Send Network Event** so the other players follow. See [Multiplayer](multiplayer.md).

## Flow control

| Node | Does |
|---|---|
| Sequence | Fires **Then 0**, **Then 1** and so on, in order. Add or remove outputs in the inspector |
| For Loop | Fires **Loop Body** once for each **Index** from **First Index** to **Last Index** (both included), then **Completed**. Stops after 10000 runs |
| Delay | Waits **Duration** seconds of play time (default 1), then fires **Out**. Triggering it again while it waits does nothing |
| Do Once | Passes the first time only. **Reset** opens it again; **Start Closed** keeps it shut until Reset |
| Flip Flop | Alternates between **A** and **B**, starting with A. **Is A** says which one ran |
| Gate | **Enter** passes to **Exit** only while the gate is open. **Open**, **Close** and **Toggle** change it; **Start Closed** sets how it starts |

Pending delays are dropped when the level restarts or play stops.

## World nodes

| Node | Does |
|---|---|
| Spawn Prefab | Places a copy of a prefab at **Position X/Y/Z**. **Spawned Actor** is the new root object. Spawned objects exist only for the play session |
| Get Actor Transform | Outputs an actor's position, rotation (degrees) and scale. **Found** is false when the actor is gone. Pure |
| Set Actor Transform | Moves, rotates (degrees) or scales an actor. Only axes that are wired or filled in change; blank ones keep their value |
| Apply Impulse | Pushes an actor that has a dynamic Rigid Body by **Impulse X/Y/Z** |
| Raycast | Casts a ray from **Origin** along **Direction** (default straight down) up to **Max Distance** (default 100). Outputs **Hit**, **Hit Actor**, **Hit Position**, **Hit Normal** and **Distance**. Triggers are ignored |
| Play Sound | Plays an audio asset once, in 2D, on a mixer bus (default sfx) |
| Make Noise | Makes a noise at **Position X/Y/Z** that enemies within **Radius** (default 20) hear and come to look at: an alarm, a thrown bottle, a slammed door. It plays no sound; add a Play Sound for that |
| Input Action | Reads an input action (default Jump). Fires **Pressed** or **Released** when its state changes, then always **Out**. **Is Down** is the current state |
| Get Level Variable / Set Level Variable | See [Level variables](#level-variables) |
| Random Float / Random Integer | A random value from **Min** to **Max** (defaults 0 to 1 and 0 to 10; Random Integer can return Max). Pure |
| Print (Format) | Shows **Format** with `{0}`, `{1}` and `{2}` replaced by **Arg 0** to **Arg 2**. `{{` and `}}` print braces; decimals are rounded to 3 places |

## Player nodes

| Node | Does |
|---|---|
| Damage Player | Hurts the player by **Amount**, as a hit does: the hit reaction plays, and at 0 health the game is over. **Damaged** is false without a live player |
| Heal Player | Restores up to **Amount** health, never past the maximum. **Healed** is false at full health or when the player is dead |
| Get Player Health | The player's **Health**, **Max**, and **Fraction** (Health / Max, 0 to 1). All 0 without a player. Pure |
| Add Ammo | Adds **Rounds** to the reserve of a weapon the player carries, by name; blank is the held weapon. **Added** is false for a weapon the player does not carry or one that never runs out |
| Give Weapon | Gives the player one of their blueprint's [weapons](characters.md#weapons) by name and puts it in their hands; a weapon they already carry gets a magazine of rounds instead. **Given** is false when nothing changed |

## Spline nodes

| Node | Does |
|---|---|
| Get Spline Length | The **Length** in metres of the **Spline** actor's [spline](world-editor.md#splines) and whether it is **Closed**. **Found** is false for an actor without one. Pure |
| Get Spline Point | Where the spline is **Distance** metres along it: **Position**, the **Direction** it runs there and its **Up**, in world space. Distances wrap round a closed spline and stop at the ends of an open one. Pure |
| Find Closest On Spline | The **Closest** point on the spline to **Position**, and the **Distance** along the spline it is at: how far the player has come along a track, or where to rejoin a path. Pure |

To move something along a spline at a speed, add a [Follow Spline](world-editor.md#follow-spline) component; these nodes are for placing, aiming and measuring.

## Vehicle nodes

| Node | Does |
|---|---|
| Enter Vehicle | Puts the player in the **Vehicle** (an actor with a [Vehicle](world-editor.md#vehicles) component) to drive it. **Entered** is false when it is not one the player can drive |
| Exit Vehicle | Takes the player out of the vehicle they drive at once, whatever its speed, beside it (or on top where there is no room) |
| Get Vehicle State | The vehicle's **Speed** in km/h (negative backwards), its **Gear** (-1 in reverse) and whether the **Player Driving** it. Pure |
| Get Player Vehicle | Whether the player is **Driving**, and the **Vehicle**. Pure |
| Set Vehicle Input | Drives a vehicle from the blueprint: **Throttle** and **Brake** from 0 to 1 (the brake reverses once stopped), **Steer** from -1 (left) to 1 (right) and the **Handbrake**. It holds them until set again or released; its AI path waits, and the player driving it overrides them |
| Release Vehicle Input | Hands the vehicle back to its AI path, or parks it |

## Particle nodes

These act on every [Particles](world-editor.md#particles) component on the **Actor**; **Emitters** is how many it has (0 when none).

| Node | Does |
|---|---|
| Play Particles | Starts its effects from the top of their delay and cycle, so a one-shot effect (an explosion, a burst of confetti) plays again |
| Stop Particles | Stops them emitting. With **Clear** the particles alive vanish at once; without, they live out their lives |
| Emit Particles | A burst of **Count** particles from each one's shape, where it is now, whether it is playing or not: a hit, a splash, a spark |
| Get Particles | Whether any of them is **Playing**, and how many particles are **Alive**. Pure |

**Input Action** compares the action with its state on the node's previous run, so drive it from **Event Tick** to catch every press. The actions are MoveForward, MoveBack, MoveLeft, MoveRight, Jump, Sprint, Fire, Aim, Interact, Reload, NextWeapon, Pause, Throttle, Brake, Handbrake, CameraView and LookBack; see [Controls](building-games.md#controls) for their keys.

## Time and weather nodes

These change and read the level's [time of day and weather](world-editor.md#sky-time-of-day-and-weather).

| Node | Does |
|---|---|
| Set Time of Day | Moves the clock to **Hours** (0 to 24; 13.5 is half past one): the sun, sky and light go there at once |
| Get Time of Day | The **Hours**, how much **Light** there is after the weather (0 dark to 1 full day) and whether it **Is Night**. Pure |
| Set Day Length | How many real **Minutes** a full day takes from now on; 0 stops the clock where it is |
| Set Weather | Changes the weather to a preset over **Seconds** (0: at once): Clear, Cloudy, Overcast, Fog, Rain, Storm (or Thunderstorm), Snow or Blizzard, in any case. **Set** is false for a name that is none of them |
| Get Weather | The preset the weather is heading for (**Weather**, empty for none), how cloudy, rainy, snowy and misty it is, the **Wind** in m/s, and how wet the ground is (**Wetness**) and how much snow lies on it (**Snow Cover**), each 0 to 1. Pure |

A storm that rolls in: **Event Begin Play**, **Delay** 60, **Set Weather** Storm over 45 seconds. Lights that come on at dusk: **Event Tick** into **Get Time of Day**, **Branch** on **Is Night**.

## Destruction nodes

These act on objects with a [Destructible](world-editor.md#destruction) component, and on everything in reach of a blast.

| Node | Does |
|---|---|
| Explode | A blast at **Position**. Characters (the player included) and breakable objects within **Radius** metres take up to **Damage**, less further out, and loose bodies are thrown at up to **Force** m/s. It shows a fireball, smoke and flying debris with a flash, and is heard. **Characters Hit** and **Objects Broken** count what it reached |
| Break Object | Breaks the **Actor** into pieces at once. **Broken** is false for an actor that cannot break or has already broken |
| Damage Object | Takes **Amount** from the **Actor**'s health; at none it breaks. **Broken** is true when this broke it |
| Get Object Health | The **Actor**'s **Health** and **Max Health**, and whether it is **Broken**. **Destructible** is false for an actor that cannot break. Pure |

A charge the player sets off: **On Overlap** of a trigger, **Delay** 3, **Explode** at the charge's position. A gate that opens once its barricade is down: **Object Broken** for the barricade, then the gate's timeline.

## Ability nodes

These act on actors with an [Abilities](world-editor.md#abilities) component. The player is the actor named `player`.

| Node | Does |
|---|---|
| Use Ability | Uses the **Actor**'s **Ability** (by its id). Its costs are paid, its cooldown starts and its effects land on the user and on **Target**. With no Target, an ability that has one takes what the actor aims at within its range. **Used**, and when it could not, the **Reason**: `cooldown`, `blocked`, `missingTags`, `cost`, `noTarget` or `unknown` |
| Apply Effect | Applies an **Effect** (by its id) to **Target**, an actor or any character. The effect is looked up on **Source**'s Abilities first, then the target's own. **Applied** is false when it did not take |
| Remove Effect | Ends a lasting effect on the **Actor**, every stack. **Removed** is false when it was not there |
| Get Attribute | The **Actor**'s **Attribute**: its **Value** now, its **Base** value and its **Max**. **Has** is false when it has none. Pure |
| Change Attribute | Adds **Amount** to the **Actor**'s **Attribute** (negative takes away), or sets it with **Set** on; within its bounds. **Value** is the attribute after |
| Has Tag | Whether the **Actor** carries the **Tag** or one under it. Pure |
| Add Tag, Remove Tag | Gives the **Actor** a tag until it is removed, or takes it away |
| Get Ability Cooldown | Seconds before the **Actor**'s **Ability** can be used again, and whether it is **Ready**. Pure |

A boss that enrages: **Actor Died** for each of its guards adds to a level variable, then **Apply Effect** of its own `enrage` effect on the boss. A trap that stuns: **On Overlap**, then **Apply Effect** `stun` on the player, with the trap as **Source**.

## Level variables

Level variables hold values for the running level, such as a score, keys collected or whether a door is open.

Declare them in the **Variables** panel at the top of the Level Blueprint editor's sidebar: **Add**, then set the name, the type (**Float**, **Boolean** or **String**) and the starting value. Renaming a variable also renames it in the Get and Set nodes that use it. The **GET** and **SET** buttons on a row place a node already set to that variable, and the Name field of those nodes offers the declared variables in a list.

- **Set Level Variable** writes **Value** to the variable called **Name** and outputs **Success**. Values are converted to the variable's type, and **Success** is false when they cannot be. Writing a name that was never declared creates it, typed by that first value.
- **Get Level Variable** outputs **Value**, and **Is Set**, which is false for a name that was never declared or written.

Every level variable goes back to its starting value when the level starts or restarts, before **Event BeginPlay** runs. Loading a saved game restores the saved values. To show one on the HUD, bind an element to `vars.<name>` (see [Live values](hud-and-menus.md#live-values)).

## Safety and undo

Graphs are protected against loops: execution stops at a fixed depth instead of freezing the game. Use **Ctrl+Z / Ctrl+Y** to undo and redo graph edits.

## Play-in-editor versus built games

Inside the editor, play mode runs the current level only: **Open Level**, **Save Game** and **Load Game** print a note instead of acting. In a built game they work fully.
