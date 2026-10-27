# Characters and animation

Player and enemy characters are blueprints in the **Blueprints** tab. Their animation graphs are edited in the **Graph** tab.

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

A state plays one of three things:

- **Single**: one clip.
- **Blend 1D**: several clips placed along one variable, such as Idle at 0, Walk at 0.5 and Run at 1 on a Speed variable. The two clips either side of the value blend linearly; past the ends the end clip plays alone.
- **Blend 2D**: clips placed on two variables, such as strafe directions on InputX and InputY. The samples are triangulated, so inside a triangle only its three corners contribute, exactly one clip plays at a sample's position, and outside the samples the nearest edge is used. The plot above the sample list shows where the samples sit.

### Playback rate

**Play rate** scales a state's speed (1 is normal, 0.5 half speed, -1 backwards). **Play rate variable** multiplies it by a variable's value every frame, for example a forward speed so feet keep pace with movement, or a value of -1 to play a walk backwards when backing up.

### Notifies

A Single state can have **Notifies**: named points in its clip, in seconds. Each time playback crosses one, the character raises that notify. In level scripting, the **Animation Notify** event runs when a notify with its name is raised (leave the name empty to catch every notify), from the player, from enemies, or from anyone. Use notifies for footstep sounds, attack hit frames and effects.

### Root motion

Turn on **Root motion** for a Single state whose clip moves the character itself, such as a dodge roll, a vault or a scripted step. The hips' forward and sideways travel is taken out of the pose and moves the player's character controller instead, so the character collides as it moves and its feet do not slide. Vertical hip motion stays in the pose. In the Graph tab preview the model moves by the same travel. Root motion moves the player; enemies keep their AI movement.

## One-shot animations on part of the body

The **Play Player Animation** node in level scripting plays a clip once over whatever the graph is doing, then blends back. Give it a **Mask Bone** such as `Spine` to play it on that bone and everything below it only: an upper-body reload or wave while the legs keep running. Leave it empty for a full-body animation. A new one interrupts the one playing with a crossfade.

## IK

Two components adjust a character's pose after its animation:

- **Look At IK** turns a bone (the head by default) toward the camera or the player, up to a maximum angle, with a weight to soften it.
- **Foot IK** casts down from each foot and bends the leg so the foot sits on the ground under it, on slopes and steps up to **Max Step**. It needs colliders or terrain under the character.

## Ragdolls

During level play, an enemy whose health reaches 0 goes limp: its skeleton becomes a ragdoll of capsules (pelvis, chest, head, arms and legs) joined at the bones' pivots, and falls and tumbles against the level's colliders and terrain. It fades out and despawns after 3 seconds, as before. This needs a humanoid skeleton (Mixamo bone names, with or without the `mixamorig` prefix, or the same names without it) and the physics world; otherwise the enemy plays its death animation. The player does not ragdoll, since the player's death ends the game.

## Previewing a graph

The Graph tab preview runs the graph on the linked model. Use its controls to pause, change speed or restart, and turn on **Follow model** to keep the camera on it. While it runs, the active state and the last transition are highlighted on the canvas, and the variables panel shows each variable's live value; change a value there to drive the preview. The status badge says when no model is linked or the model has no clips.
