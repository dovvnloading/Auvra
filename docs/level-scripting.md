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
| Raycast | Casts a ray from **Origin** along **Direction** (default straight down) up to **Max Distance** (default 100). Outputs **Hit**, **Hit Actor**, **Hit Position**, **Hit Normal** and **Distance**. Triggers are ignored, and terrain is not hit |
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

**Input Action** compares the action with its state on the node's previous run, so drive it from **Event Tick** to catch every press. The actions are MoveForward, MoveBack, MoveLeft, MoveRight, Jump, Sprint, Fire, Aim, Interact, Reload, NextWeapon and Pause; see [Controls](building-games.md#controls) for their keys.

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
