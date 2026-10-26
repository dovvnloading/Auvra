# World Editor

The **Environment** tab is where levels are built.

## Tools

| Tool | Key | Use |
|---|---|---|
| Select | Q | Select objects and move them with the gizmo |
| Place | — | Click to place the chosen model on terrain or other surfaces |
| Paint | B | Paint or erase foliage and props with a brush |
| Terrain | — | Create, sculpt (raise, lower, flatten, smooth) and texture-paint terrain |
| Mask | M | Create texture masks on objects |

Gizmo modes: **W** move, **E** rotate, **R** scale, **Z** toggles world/local space, **X** toggles grid snapping. Every object type can be transformed, including props, foliage and terrain. The inspector also has exact position, rotation (degrees) and scale fields.

## Camera

- Orbit with the mouse (default).
- Fly: hold the **right mouse button** and use **W A S D** to move, **Q / E** to go down / up, **Shift** to move faster. The toolbar sets the base camera speed.
- **F** frames the selected object.

## Selection and editing shortcuts

| Shortcut | Action |
|---|---|
| Click / Ctrl+click | Select / add or remove from the selection (Shift+click selects a range in the outliner) |
| Ctrl+A | Select everything in the level |
| Ctrl+D | Duplicate the selection (with children) |
| Ctrl+C / Ctrl+V | Copy / paste into the current level |
| Delete / Backspace | Delete the selection and its children |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+S | Save the project |
| Esc | Clear the selection |

Shortcuts are ignored while you type in a field.

## Hierarchy

The **Outliner** tab shows the level as a tree. Drag an object onto another to make it a child; drag it to the empty area to unparent it. Children move with their parent; their transforms are stored relative to it. The inspector's **Parent** field does the same. Deleting an object deletes its children.

## Components

Objects can carry components that add behaviour. Select an object and use **Add Component** in the inspector:

| Component | Does |
|---|---|
| Rotator | Spins the object around an axis |
| Mover | Moves the object back and forth by an offset |
| Point Light / Spot Light | Light sources, visible in the editor and in play (see [Lights](#lights)) |
| Collider | A physics shape: solid scenery or a trigger volume (see [Physics](#physics)) |
| Rigid Body | Simulates the object during play (see [Physics](#physics)) |
| Particles | Emits smoke, sparks, fire, dust or custom particles (see [Particles](#particles)) |
| Audio Source | Plays a sound from the object during play (see [Audio](#audio)) |

Each component's settings appear in the inspector and can be toggled on and off.

## Physics

Physics runs only during play. In the editor, collider shapes are drawn as wireframes: green for solid shapes, amber for triggers, and blue for mesh and automatic shapes (shown on the selected object).

### Collider

A Collider on its own makes the object solid, fixed scenery. Sizes and the offset are in the object's local space.

| Setting | Default | Notes |
|---|---|---|
| Shape | Box | Box, Sphere, Capsule or Mesh (model surface) |
| Box Size | 1, 1, 1 | Box only |
| Radius | 0.5 | Sphere and capsule |
| Capsule Height | 2 | Full height of the capsule |
| Offset | 0, 0, 0 | Moves the shape relative to the object |
| Is Trigger | Off | Lets things pass through and reports the player entering (see [Triggers](#triggers)) |

**Mesh** uses the model's own surface. Use it for complex fixed scenery such as buildings; simple shapes are cheaper and better for moving bodies.

### Rigid Body

| Setting | Default | Notes |
|---|---|---|
| Body Type | Dynamic | **Dynamic** falls and collides. **Kinematic** follows the object's own motion (for example a Mover) and pushes dynamic bodies. **Fixed** stays put |
| Mass (kg) | 1 | Shared among the object's solid colliders |
| Gravity Scale | 1 | -10 to 10; 0 makes the body float |
| Lock Rotation | Off | Stops the body from tipping over |

A Rigid Body uses the object's Collider components. Without one, it gets a convex hull wrapped around the model. The model and the object's children move with the body. Each object has one body. A child with only Collider components under a dynamic or kinematic Rigid Body adds its colliders to that body; a child with its own Rigid Body (or under a fixed one) gets its own.

### The player and terrain

During play the player is a capsule sized from the character model's height. It climbs slopes up to 50°, slides on anything steeper than 35°, steps up small ledges and pushes dynamic bodies. A jump rises about 0.3 of the character's height.

Props only block the player when they have a Collider or Rigid Body.

Terrain is solid during play: it gets a matching physics shape, so dynamic bodies land on it, the player walks on it and raycasts hit it. A level without terrain gets a flat ground at height 0. Props with no collider still block the player with a round footprint (about half their width), as they did before physics; add a collider for an exact shape.

### Triggers

Turn on **Is Trigger** to make a volume the player can walk through, such as a checkpoint, pickup or door sensor. An **On Overlap** event in the level blueprint that targets the object fires once each time the player enters it. See [Level scripting](level-scripting.md#events).

## Lights

The **Lights** panel in the **Outliner** tab (under the prefab list) lists every point and spot light in the level.

- **+ Point** and **+ Spot** add a light above the origin (a spot light points down). The new light is selected so you can move it.
- Each row selects its light and has an on/off toggle, a colour swatch and an intensity field (**Int**).

The light's other settings are on its component in the inspector.

## Particles

Add a **Particles** component to an object. Particles leave the object's origin in a cone around its local up (+Y) axis and stay behind in the world as the object moves.

- **Preset**: Smoke, Sparks, Fire, Dust or Custom. A preset sets lifetime, speed, spread, size, colours, gravity and its look. Choose **Custom** to use the values in those fields instead.
- **Rate (per s)**, **Burst** (particles emitted at once at the start of each cycle) and **Loop** always apply. A cycle lasts one lifetime; with Loop off the emitter runs once.

Emitters preview live in the editor with a lower particle limit, and one-shot emitters keep replaying there so you can see them.

## Audio

Add an **Audio Source** component to play a sound from an object during play. In the editor it shows as a small marker.

| Setting | Default | Notes |
|---|---|---|
| Audio (id or name) | — | The audio asset to play |
| Volume | 1 | 0 to 2 |
| Loop | On | |
| 3D (Spatial) | On | Fades with distance; off plays in 2D |
| Play on Start | On | |
| Full-Volume Distance | 1 | 3D only: the sound starts fading beyond this distance |
| Mixer Bus | SFX | SFX, Music, UI or Master |

All game sound plays through four mixer buses (Master, Music, Effects and Interface), and players set each one's volume in the game's Options screen. Weapon sounds use Effects. **Audio Emitter** objects use Music when they are 2D and looping, and Effects otherwise. The **Play Sound** blueprint node chooses its bus.

## Terrain painting

A terrain can blend up to four textures. Import the textures in the Content Browser first.

1. Select the terrain and open the **Sculpt** tab of the terrain inspector.
2. Under **Texture Layers**, click **+ Add Layer** and choose a **Texture**. **Tiling** sets how many times the texture repeats across the terrain's width (default 16). Layer 1 is the base layer that covers the whole terrain.
3. Click **Paint** (under Raise, Lower, Flatten and Smooth), or a layer's brush icon to paint that layer. **Radius (m)** and **Strength (%)** set the brush.

To erase paint, paint layer 1 over it. Only the last layer can be removed; its paint goes back to layer 1. Removing layer 1 returns the terrain to its plain material.

## Prefabs

A prefab is a reusable object tree. Select an object (its children come with it) and choose **Create from selection** in the prefab panel under the outliner. **Place** adds a copy to the current level. Placed copies are independent of the prefab. The **Spawn Prefab** blueprint node places copies during play.

## Placement

Placement, dropping models from the Content Browser and foliage painting all land on the surface under the cursor: terrain, other meshes, or the ground plane.
