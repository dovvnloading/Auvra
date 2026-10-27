# Characters and animation

Player and enemy characters are blueprints in the **Blueprints** tab. Their animation graphs are edited in the **Graph** tab.

## Setting up a character

1. Import the character's mesh with **Import > Character**.
2. Select the mesh in the library and import its clips with **Import > Animation**. For Mixamo, download the character "With Skin" and each animation "Without Skin".
3. Open the blueprint and pick the mesh under **Linked Mesh**.

Linking a mesh gives each state the mesh's clip whose name fits it:

- Idle, Walk and Run go to the states of the same names, and Run also goes to Chase.
- Jump goes to Jump, Falling to Falling, and Landing to Land.
- Punch or Attack goes to Attack, and Death or Dying to Death.
- Strafe Left, Strafe Right and Walk Back go to the strafe blend's samples.
- Shooting goes to the player's fire clip, and an aiming clip to its aim clip (see "Upper body while firing and aiming").

Clips named for fights, transitions or other directions ("Fight Idle", "Start Walking") are passed over for plain ones. A missing strafe clip falls back to Walk. A state that already plays one of the mesh's clips is left alone. **Match Clips** next to Linked Mesh does the same again, for clips imported after linking. A notice lists what was matched.

## Stats

Select a blueprint and open the inspector's **Stats** tab. The **Attributes** list holds the character's stats; **+ Add** adds one. Stats are matched by exact name. A speed, range or cooldown stat that is missing, or not a positive number, uses the default below.

Speeds and distances are in centimetres: 100 is one world unit.

### Player

| Stat | Default | Use |
|---|---|---|
| Health | 100 | |
| Stamina | 50 | |
| Walk Speed | 450 | Walking speed, cm/s |
| Run Speed | 900 | Speed while sprinting, cm/s |

### Enemy

| Stat | Default | Use |
|---|---|---|
| Health | 50 | |
| Damage | 10 | |
| Speed | 650 | Top chase speed, cm/s. Walking and strafing scale with it |
| Attack Range | 220 | How close the enemy must be to attack, cm |
| Attack Cooldown | 3 | Seconds between attacks (0 is allowed) |
| Sight Range | 1500 | How far the enemy can see the player, cm |

Enemy blueprints made before these stats were used have Speed 350, so their enemies chase at 3.5 instead of 6.5. Set Speed to 650 to restore the earlier pace.

## Enemy behavior

An enemy blueprint either uses the built-in AI (attack the player in range, chase what it sees, search where it last saw the player, otherwise patrol) or a behavior tree you author on its **Behavior** tab. **Start from the built-in AI** creates a tree that behaves the same, to change from there; **Start empty** begins with one selector.

The tree is evaluated from the top every frame. Each node succeeds, fails or is still running:

| Node | Does |
|---|---|
| Selector | Tries its children in order and stops at the first that does not fail |
| Sequence | Runs its children in order and stops at the first that does not succeed |
| Inverter | Swaps its child's success and failure |
| Succeeder | Succeeds even when its child fails |
| Cooldown | Lets its child succeed at most once every Value seconds |
| Condition | Succeeds when its test holds: can see the player, saw the player recently, player within a distance, health below a percent, a random chance (rolled once a second), or a graph variable is on |
| Action | Chase the player (until in attack range), attack, strafe for some seconds, search where the player was last seen, patrol to a random point, wait, move to an object (by id), flee to a safe distance, return to the spawn point, set a graph variable, or play an animation |

Actions use the enemy's Speed, Attack Range, Attack Cooldown and Sight Range stats like the built-in AI, and attacks deal damage at the same moment of the attack. An action that is interrupted by another branch starts over the next time it runs. Problems such as a decorator without its one child show under the tree. Use **Delete** on the top node to go back to the built-in AI.

## Enemy navigation

During level play, enemies find paths around obstacles when they patrol, chase, search and return. Auvra builds a walkable grid from the level when play starts:

- Solid Colliders (box, sphere and capsule) are obstacles. Props without a Collider, or with a Mesh collider, block a circle about half their larger horizontal scale wide.
- Objects that move are left out: anything with a Mover, Rotator or non-fixed Rigid Body, or a child of one.
- Ground follows the terrain; slopes steeper than 40° are not walkable. Obstacles an enemy can walk under or step over do not block it.

When the player cannot be reached, a chasing enemy goes to the closest point it can reach. Enemies in the **Sandbox** tab still move in straight lines.

## Animation transitions

In the **Graph** tab, select a transition between two states to edit it:

- **Blend Duration (s)** is the crossfade time between the two animations (0.2 by default). 0 cuts instantly.
- **Exit Time (0-1, empty = none)** holds the transition until the source animation has played that fraction of its length, for example 0.9 for near the end. Leave it empty for no exit time.

A transition fires when its conditions are true and, if it has an exit time, that point has been reached. With an exit time and no conditions it fires on its own, which suits one-shot animations such as an attack returning to idle. A transition with no conditions and no exit time never fires; the inspector warns about this. Exit time works only on states that play a single clip, not on blend states.

- **Match** chooses whether **All** conditions must be true (the default) or **Any** one is enough.
- **From any state** makes the transition fire from every state except its own target, so a death, hit or jump transition is written once instead of once per state.
- **Priority** decides which transition wins when several are ready at once: the highest fires, and ties go to the one listed first. Give death a high priority so nothing overrides it.

Number conditions compare with a small tolerance, so `Speed == 0` still matches after a blend leaves 0.00001.

## States and blend spaces

A state plays one of these:

- **Single**: one clip.
- **Blend 1D**: several clips placed along one variable, such as Idle at 0, Walk at 0.5 and Run at 1 on a Speed variable. The two clips either side of the value blend linearly; past the ends the end clip plays alone.
- **Blend 2D**: clips placed on two variables, such as strafe directions on InputX and InputY. The samples are triangulated, so inside a triangle only its three corners contribute, exactly one clip plays at a sample's position, and outside the samples the nearest edge is used. The plot above the sample list shows where the samples sit.
- **Machine**: a state machine of its own, with its own states and transitions, such as a Locomotion machine holding Idle, Walk and Run. Double-click it on the canvas (or click **Open State Machine**) to edit what is inside; the bar above the canvas leads back out. Entering it starts its entry state; its own transitions run while any state inside plays; transitions from the machine leave from whichever state inside is playing. The preview highlights the machine and, inside it, the state that is playing.
- **Conduit**: a junction with no animation. A transition into it is taken only when one of the conduit's own transitions is ready too, and the character goes straight on to that state with that transition's crossfade. Use it to share exit rules: Walk and Run both go to an Airborne conduit that sends on to Jump or Fall.

Blend samples run in step: they share one cycle length, weighted by how much each plays, and follow the heaviest sample's phase, so a walk and a run of different lengths keep their feet together. Give states the same **Sync Group** to carry that phase across transitions as well: a Run entered from a Walk in the same group starts mid-stride where the walk was, instead of from its first frame.

States name their clips, and the clip list offers every model's clips, the character's own first. A clip keeps the name it was given at import, even when its model is renamed in the library. A second clip of a name the model already has is numbered ("Walk 2"). Where another model has a clip of the same name (two characters that both have `Idle`), the character plays its own.

### Playback rate

**Play rate** scales a state's speed (1 is normal, 0.5 half speed, -1 backwards). **Play rate variable** multiplies it by a variable's value every frame, for example a forward speed so feet keep pace with movement, or a value of -1 to play a walk backwards when backing up.

### Notifies

A Single state can have **Notifies**: named points in its clip, in seconds. Each time playback crosses one, the character raises that notify. In level scripting, the **Animation Notify** event runs when a notify with its name is raised (leave the name empty to catch every notify), from the player, from enemies, or from anyone. Use notifies for footstep sounds, attack hit frames and effects.

### Curves

A Single state can have **Curves**: values keyed over its clip, in seconds, each driving a graph variable while the state plays. The value runs in straight lines between keys and holds before the first and after the last; a Boolean variable is on above 0.5. Transitions and other systems then follow the clip's timing: a curve that holds a LandLock variable on for the first 0.3 s of a landing keeps the landing from being cut short, a combo window opens a variable during the frames an attack can chain. The graph under each curve shows it over the clip.

### Root motion

Turn on **Root motion** for a Single state whose clip moves the character itself, such as a dodge roll, a vault or a scripted step. The hips' forward and sideways travel is taken out of the pose and moves the player's character controller instead, so the character collides as it moves and its feet do not slide. Vertical hip motion stays in the pose. In the Graph tab preview the model moves by the same travel. Root motion moves the player; enemies keep their AI movement.

## Jumping, falling and landing

During play the character controller sets three graph variables:

| Variable | Value |
|---|---|
| **IsGrounded** | true while standing on something |
| **IsFalling** | true in the air after a jump, or after more than 0.15 s off the ground. Running over a bump or down a step does not count. |
| **VerticalSpeed** | upward speed in world units per second, negative while dropping |

New player blueprints use them for three states:

- **Jump** plays while rising after a jump.
- **Falling** plays past the top of the jump, or after walking off a ledge.
- **Land** plays on touching down. Moving cuts it short into Walk; standing still lets it finish into Idle.

A state with no clip counts as finished at once, so a Land state without a landing clip goes straight to Idle.

## Upper body while firing and aiming

A player blueprint's **Upper Body (Fire & Aim)** section, under Details, picks a clip to loop while the fire button is held and one to loop while aiming. Firing wins over aiming. The clip plays on **From bone** and everything below it in the skeleton: Spine by default, which is the chest, arms and head. The legs keep walking, running or jumping underneath. With "Graph only" the graph's pose is left as it is.

**Aim view**, under Camera Settings, sets how the player aims. **Scope** looks out of the character's eyes, hides it and shows the scope reticle. **Over the shoulder** moves the camera close behind the character's shoulder and keeps the character, its aim clip and its weapon in view, with a small crosshair. **Aim Camera Offset** fine-tunes where the camera sits; changing the view resets it to that view's default. Under Pose Adjustment, **Lean the spine with the aim** bends the spine up and down with the camera while aiming, so the arms follow where you look.

## Weapons

A player blueprint's **Weapons** section, under Details, lists the weapons the player carries. The player starts holding the first; **Next weapon** (Q) switches to the next and **Reload** (R) reloads. Each weapon has:

- **Model**: one of the character model's attachments, shown while the weapon is held. The other weapons' attachments are put away.
- **Muzzle**: the socket its shots leave from and flash at during hip fire (and while aiming over the shoulder). Without one, the first socket named Muzzle is used.
- **Fire mode**: **Automatic** fires while the button is held, **Semi-automatic** once per press. **Rate** sets how many shots a second it can fire.
- **Damage** per projectile, **Pellets** per shot (more than one for a shotgun), projectile **Speed**, and **Spread**: the largest angle, in degrees, a shot strays from the aim. Aiming cuts the spread to a quarter.
- **Mag**, **Reserve** and **Reload**: the rounds a magazine holds, the rounds carried besides (-1 is unlimited) and how long a reload takes. Firing with an empty magazine starts a reload; a magazine of 0 never runs out. Each weapon keeps its own rounds when you switch away, and switching cancels a reload.
- **Fire clip**, **Aim clip** and **Reload clip**: upper-body clips for this weapon, in place of the blueprint's Upper Body clips. The reload clip plays once, from the same bone, when a reload starts.

The graph's **IsReloading** variable is on during a reload, and **IsFiring** is off then. A blueprint without weapons fires an automatic with unlimited rounds from its Muzzle socket, as before. The HUD can show the held weapon and its rounds through the `player.weapon`, `player.ammo` and `player.reserve` bindings (see [HUD and menus](hud-and-menus.md)); the built-in HUD shows them at the bottom left.

## Hit reactions

A character blueprint's **Hit Reaction** clip is added on top of whatever the character is doing each time it is hurt and survives, so it flinches without stopping. The clip's first frame counts as its neutral pose: only its movement away from that frame is added.

## One-shot animations on part of the body

The **Play Player Animation** node in level scripting plays a clip once over whatever the graph is doing, then blends back. Give it a **Mask Bone** such as `Spine` to play it on that bone and everything below it only: an upper-body reload or wave while the legs keep running. Leave it empty for a full-body animation. A new one interrupts the one playing with a crossfade. Turn on **Additive** to add the clip's movement to the pose instead of replacing it, such as a flinch or a shrug over a run; additive and replacing animations play alongside each other.

## IK

These components adjust a placed character's pose after its animation:

- **Look At IK** turns a bone (the head by default) toward the camera or the player, up to a maximum angle, with a weight to soften it.
- **Foot IK** casts down from each foot and bends the leg so the foot sits on the ground under it, on slopes and steps up to **Max Step**. It needs colliders or terrain under the character.
- **Reach IK** bends a limb so a bone (the right hand by default, with the forearm and upper arm above it) reaches another object in the level or the player, with an offset and a weight: a hand on a lever, a foot on a pedal, a greeting.

A placed character stands in its rest pose unless something animates it: give it an **Animation** component to play one of its clips during play, looping or once, at a speed and from a point in the clip, such as an NPC idling, waving or working.

## Ragdolls

During level play, an enemy whose health reaches 0 goes limp: its skeleton becomes a ragdoll of capsules (pelvis, chest, head, arms and legs) joined at the bones' pivots, and falls and tumbles against the level's colliders and terrain. It fades out and despawns after 3 seconds, as before. This needs a humanoid skeleton (Mixamo bone names, with or without the `mixamorig` prefix, or the same names without it) and the physics world; otherwise the enemy plays its death animation. The player does not ragdoll, since the player's death ends the game. The Arena Sample's red guards are rigged this way, so shooting one shows it; their Idle, Walk and Attack clips drive the guard's animation graph.

## Previewing a graph

The Graph tab preview runs the graph on the linked model. Use its controls to pause, change speed or restart, and turn on **Follow model** to keep the camera on it. While it runs, the active state and the last transition are highlighted on the canvas, and the variables panel shows each variable's live value; change a value there to drive the preview. The status badge says when no model is linked or the model has no clips.
