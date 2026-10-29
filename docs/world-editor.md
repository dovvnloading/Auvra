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

The left panel's **Logic Actors** add a Player Start, an Enemy Spawner, an Audio Emitter, a Sky Sphere, an **Empty Object** (an object with no model, drawn in the editor as a small marker, for components such as trigger colliders, timelines, cameras and level streaming, or as a parent to group other objects under) and a **Spline** (an empty object with a [Spline](#splines) component).

Select an Enemy Spawner to set what it spawns: the **Enemy** blueprint, a new one **Every** so many seconds, and **Max** in all (0 for no limit). Enemies appear around the spawner. A spawner with no enemy chosen spawns nothing. With a **Patrol Path** (an object with a Spline component) its enemies patrol along the spline instead of wandering around where they spawned (see [Patrol paths](characters.md#patrol-paths)).

The sun casts shadows around the point the camera looks at, in the editor and in play. They are sharpest up close and reach further as the camera pulls back, up to 400 units around that point; objects beyond that cast none.

Terrain without texture layers is shaded as grass on gentle ground, earth on slopes and rock on steep faces. Paint layers to replace it.

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
| Camera | A level camera looking along the object's -Z axis. Timelines, the **Set Active Camera** node and scripts switch the view to it; **Active at start** shows it as play begins (see [Camera cuts](timelines.md#camera-cuts)) |
| Point Light / Spot Light | Light sources, visible in the editor and in play (see [Lights](#lights)) |
| Collider | A physics shape: solid scenery or a trigger volume (see [Physics](#physics)) |
| Rigid Body | Simulates the object during play (see [Physics](#physics)) |
| Particles | Emits smoke, sparks, fire, dust or custom particles (see [Particles](#particles)) |
| Audio Source | Plays a sound from the object during play (see [Audio](#audio)) |
| Reverb Zone | Adds room, hall, cave or outdoor reverb to sound effects while the camera is inside it |
| Music | Plays a playlist of audio assets on the music bus, with shuffle, loop and crossfades |
| Physics Joint | Connects the object's rigid body to another object or to the world: fixed, ball, hinge or slider, with limits and a break force |
| Decal | Projects a texture onto the object or onto any surface under it |
| Water | An animated water surface with waves, reflections and foam; dynamic rigid bodies float in it and are slowed by it |
| Reflection Probe | Captures its surroundings into a reflection map for shiny materials within its radius; the nearest probe wins where probes overlap. Updates once at start, at an interval, or every frame |
| Light Bake Volume | A box (centred on the object, drawn in the editor) where [baked lighting](#baked-lighting) puts its light probes |
| Post Process | The level's screen effects: global illumination, screen reflections, bloom, ambient occlusion, tone mapping, exposure and auto exposure, light shafts, sunlit haze, motion blur, vignette, depth of field, white balance, colour grading looks, film grain and antialiasing (see [Screen effects](#screen-effects)) |
| LOD Group | Shows one of the object's children by camera distance (LOD 0, 1, 2) and hides all of them past the last distance |
| Level Streaming | Loads another level's objects while the player is inside its box and unloads them after the player leaves (see [Level streaming](#level-streaming)) |
| Distance Cull | Hides the object and its children beyond a distance |
| Animation | Plays one of a placed character's clips during play, looping or once, at a speed and from a point in the clip: an NPC idling, waving or working. Clip names match with or without an FBX take prefix such as `Armature|` |
| Look At IK / Foot IK / Reach IK | Turn a bone toward the camera or the player, plant the feet of the object's model on the ground, or bend a limb so a hand or foot reaches another object or the player (see [IK](characters.md#ik)) |
| Procedural Rig | Constraints on the object's bones after its animation, in order: aim a bone at the camera, the player, an object or a point; copy or offset rotations; limit them; make a bone lag; spread twist along a limb (see [Procedural rig](characters.md#procedural-rig)) |
| Script | Runs your own JavaScript or TypeScript during play (see [Gameplay scripting](scripting.md)) |
| Network Sync | In multiplayer games the host sends the object's position and rotation and the other players follow it (see [Multiplayer](multiplayer.md)) |
| Timeline | Plays keyed tracks that move, show and hide objects, write level variables and raise events (see [Timelines](timelines.md)) |
| Dialogue | A conversation the player opens with Interact when within reach: lines, choices, level variables and dialogue events (see [Dialogue](dialogue.md)) |
| Spline | A smooth curve through points, edited in the viewport (see [Splines](#splines)) |
| Spline Mesh | Bends a model along the object's spline: roads, rails, pipes, walls, river beds |
| Spline Scatter | Places copies of a model along the object's spline: fence posts, lamps, trees along a road |
| Procedural Scatter | Fills an area with layers of models by rule (forests, rocks, grass, ruins), drawn as impostors far away (see [Procedural scatter](#procedural-scatter)) |
| Follow Spline | Moves the object along another object's spline during play: platforms, carts, trains, cameras on rails |
| Vehicle | A wheeled vehicle the player gets into and drives, or that drives itself along a spline (see [Vehicles](#vehicles)) |
| Nav Link | Lets enemies cross from the object to **End** (relative to the object) where the navmesh does not join up: a drop, a gap, a ladder. One-way links only go from the object to the end. Drawn in the editor as an arc (see [Enemy navigation](characters.md#enemy-navigation)) |
| Nav Obstacle | Cuts a cylinder of **Radius** and **Height** around the object out of the navmesh and follows it as it moves, so enemies path around it: for crates that get pushed, vehicles and other moving objects |
| Abilities | Attributes (health, mana, stamina, armor...), effects and abilities with costs and cooldowns for the object, or for the player (see [Abilities](#abilities)) |
| Pickup | Health, rounds or a weapon the player collects by walking within **Reach** of the object. **Amount** is the health restored or the rounds added; **Weapon** names the weapon that gets the rounds (blank: the held one) or the weapon given. A pickup that would give nothing, such as health at full health, stays. Taken, it disappears and comes back after **Respawn** seconds; at 0 it is gone for the session, and a save remembers it. **Sound** plays when it is taken. Add a Rotator for a pickup that spins (see [Weapons](characters.md#weapons)) |

Each component's settings appear in the inspector and can be toggled on and off.

## Splines

A spline is a smooth curve through points, in its object's space: moving, turning or scaling the object moves the whole curve. **Spline** under Logic Actors adds an empty object with a Spline component; the component can also be added to any object.

### Editing points

Select the object to edit its spline in the viewport. The curve is drawn with a handle on every point (the first one green) and an arrow at the end showing which way it runs.

- **Click a handle** to select that point. The gizmo then edits the point instead of the object: **Move** moves it, **Rotate** turns the curve's direction through it (giving it a custom tangent) and rolls it, **Scale** sets its width and height (see Spline Mesh). Snapping (**X**) applies as it does to objects.
- The selected point shows its two **tangent handles**. Drag one to shape the curve through the point; the other mirrors it.
- **Alt-drag** a point to leave a copy of it behind and drag the new one: the quickest way to extend a spline.
- **Ctrl-click** the curve to add a point there.
- **Delete** removes the selected point (a spline keeps at least two), and **Escape** deselects it. With no point selected they act on objects as usual.

The inspector lists the points (click one to select it), the spline's length and point count, and edits the selected point exactly: its position, its **Type**, its roll in degrees and its width and height scale. **Add at end** continues the curve past its last point, **Insert after** adds a point halfway to the next, **Delete point** removes the selected one and **Reverse** runs the spline the other way.

Point types:

| Type | The curve at the point |
|---|---|
| Smooth | Passes through smoothly, curving as its neighbours lead it (centripetal Catmull-Rom: no loops or overshoots however unevenly the points are spaced) |
| Corner | Turns a corner and heads straight for each neighbour; a run of corner points gives straight lines |
| Custom tangent | Leaves along the point's own **Tangent**: its direction and how far the curve holds it |

**Closed loop** joins the last point back to the first. **Up** decides which way is up along the curve: **Level** keeps it upright (roads and fences do not bank, except where a point's roll banks them), **Least twist** turns it as little as the curve does, for loops, corkscrews and coasters.

Everything along a spline goes by distance in metres, so spacing and speed stay even however the points are spread.

### Spline Mesh

Bends a model along the object's spline. Pick the **Model**, and which of its axes is its length (**Z**, its front, or **X**). **Tile end to end** repeats it along the spline, each copy stretched a little so a whole number fit; **Stretch once** draws it out over the whole length. **Scale** multiplies the model's width, height and length (the length sets how long one tile is), and each point's width and height scale apply on top, so a road can widen at a junction. **Offset right** and **Offset up** move it off the curve, **Gap between tiles** spaces the copies, and **Start trim** and **End trim** leave the ends bare.

The model is cut across its length every **Bend detail** metres before it is bent, so even a road made of one long quad follows every curve; smaller is smoother. Normals and normal maps follow the bend. With **Collision** on, the bent mesh is solid in play: the player walks on a road or bridge and up a ramp, physics objects land on it, the enemies' navmesh includes it, and baked lighting sees it.

### Spline Scatter

Places copies of a model along the object's spline, a **Spacing** apart (from end to end of an open spline, evenly round a closed one), trimmed at either end like Spline Mesh. **Offset right** and **Offset up** move the row off the curve, and **Both sides** mirrors it across. **Turn copies** sets how they face: upright and facing along the curve, with the curve (tilting on slopes and rolling with the points), or not at all. **Random turn**, **Random size** and **Random shift** vary each copy so a row does not look stamped; the **Seed** picks the variation, and the same seed always gives the same row. Copies draw as one instanced mesh per material. **Collision (boxes)** makes each copy a solid box the size of the model.

### Follow Spline

Moves its object along another object's spline during play. Pick the **Spline to follow**. **Speed** is in metres per second (negative runs it backwards), **Start at** is where on the spline it begins (0 the start, 1 the end), and **At the end** loops back to the start, goes back the way it came (**ping-pong**), or stops (**once**); round a closed spline it keeps going. **Turn with it** faces it along the way it travels (upright, or fully following the curve) or keeps its own rotation. **Offset** moves it right of, above and ahead of the curve. With a **Play Variable** it moves only while that level variable is true or non-zero; otherwise **Autoplay** starts it. In the editor a dashed line runs from the object to where it starts.

An object with a kinematic Rigid Body carries the player and physics objects standing on it, so Follow Spline makes moving platforms. Followers count as moving objects: the navmesh and baked lighting leave them out.

### Terrain along a spline

The Spline inspector's **Terrain** tools shape every terrain the spline crosses:

- **Flatten under** brings the ground within half of **Width** of the curve to the curve's height, less **Depth** (to sink a river bed or a sunken road), and blends back to the terrain over **Falloff** metres on each side. The width follows each point's width scale.
- **Paint under** paints the chosen texture **Layer** over the same strip (the terrain needs texture layers, see [Terrain painting](#terrain-painting)).
- **Snap points** sets each point's height to the terrain under it, so the spline lies on the ground.

Each is one undo step.

## Vehicles

A **Vehicle** component turns an object into a wheeled vehicle: a car, truck, buggy or kart. During play the player walks up to it and presses **Interact** (F) to get in, drives it, and presses Interact again to get out once it has slowed to walking pace. A vehicle can also drive itself along a spline, and level scripts and gameplay scripts can drive it too.

On its own the component makes the object a dynamic physics body of the vehicle's **Mass**, shaped by a convex hull around the model's body (without its wheels). Collider components on the object shape it instead; a Rigid Body component on it sets its mass and body type.

### Wheels

The vehicle uses the model's own wheels: nodes named like `Wheel_FL`, `wheel_br`, `FrontLeftTire` or `Rim_RL` (a tyre and the rim, hub or brake disc sharing its centre turn as one wheel). Steering wheels, spares and wheel arches are left out. Each wheel is measured from its mesh, so its pivot does not have to be at its centre. A model that names fewer than three wheels gets four drawn at the corners of its body, so any model can be driven while you make a proper one.

Which way the model faces comes from its wheel names: front and rear (`fl`, `rr`, `front`, `back`) tell it which end is the front, and left and right which side is which, whatever axis the model was built along. Set **Model faces** when the names say nothing (the front is then +Z) or to override them.

Nodes named with the word `door` (`door_l`, `Door_FR`, a door's window or handle) are the doors: a door's parts swing together about its front edge, and the driver's door (the front one on the left) opens as the driver gets in and out and shuts behind them.

In the editor each vehicle shows a ring where each of its wheels is and an arrow along the way it drives.

### How it drives

Each wheel is simulated on its own, the way driving games do:

- **Suspension**: a spring and damper per wheel, with a bump stop at the end of its travel. The wheel finds the ground under it exactly, and the tyre's own shape catches a kerb or an edge under the tread. The car leans in corners, squats when it pulls away and dives when it brakes, and the load on each tyre moves with it.
- **Tyres**: grip comes from how much each tyre slips, lengthways and sideways (a Pacejka "magic formula" curve), shared between the two (a tyre braking hard can corner less), and grows with the load on it a little less than in step. Past its peak a tyre lets go: a locked wheel slides and a spinning one loses its pull.
- **Engine and gearbox**: an engine torque curve from its power, through a gearbox geared for the top speed, a clutch that slips to pull away, and a differential to the driven wheels. It changes up near the redline, down as it slows, and kicks down when you floor it.
- **Assists**: **ABS** lets a locking wheel's brake off so it still steers; **traction control** trims the throttle to hold the driven wheels at the slip that pulls hardest; **stability control** brakes a single wheel to catch a slide or tighten a turn that runs wide, and eases off the power while it does.

### Driving and handling

| Control | Keyboard | Gamepad |
|---|---|---|
| Throttle | Move forward (W) | Right trigger (analog) or left stick up |
| Brake; from a stop, reverse | Move back (S) | Left trigger (analog) or left stick down |
| Steer | Move left / right (A, D) | Left stick (analog) |
| Handbrake: locks the rear wheels and lets the back slide | Space | A or right bumper |
| Change view: chase, far chase, bonnet, bumper | V | Back |
| Look back, while held | B | Right stick press |
| Get in, or get out when slow enough and there is room beside it | Interact (F) | X |

While driving, a speedometer shows the speed, gear and revs; the mouse looks round the chase views for a moment before they settle back behind. The view shakes a little at speed, more over loose ground and hard with impacts and landings, and widens with speed. The driver is out of reach of shots and blows. Getting out puts them beside the driver's door (the left), or the other side or behind when that is blocked.

### Surfaces, marks and lights

Tyres feel what they are on. A collider's **Surface** (see [Collider](#collider)) says what it is made of; on Auto a Mesh collider reads it triangle by triangle from its materials' names (`Asphalt`, `Road`, `Concrete`, `Gravel`, `Dirt`, `Grass`, `Sand`, `Mud`, `Snow`, `Ice`, `Water`, `Metal`, `Wood`...), and a terrain from its painted layers' texture names. Each grips and drags differently: a road grips fully, dirt about two thirds as well, grass and sand about half, snow a third and ice a tenth, and sand and mud drag hard.

A tyre that slides or spins on a road lays black marks and smokes; on loose ground every tyre leaves a rut and throws up dust (spray on snow and mud) in the ground's colour, more the faster it goes. Marks stay for the rest of the play session, the oldest going first once there are many.

The vehicle's lamps are the model's own nodes named for them: `HeadLight`, `TailLight`, `BrakeLight`, `ReverseLight` (or `headlamp`, `rear light`, `stop light`...). Tail lamps glow with the headlights and brighter when braking, brake lamps when braking, reversing lamps in reverse. Headlights also throw beams down the road, from the headlight lamps or the front corners of a model without any. **Headlights** sets when: **Auto** while it is driven once the sky darkens towards night, **On** whenever it is driven, **Off** never.

The engine (synthesized or a recording) runs with the revs and load and cuts out for a moment through each gear change. The tyres squeal sliding on hard ground, rumble on loose ground, the wind rises with speed, and impacts and hard landings knock.

| Setting | What it does |
|---|---|
| Mass | Total mass in kilograms |
| Model faces | Which way the model's front points: Auto reads it from the wheel names |
| Drive | Which wheels the engine drives: rear, front or all (all splits it 40/60 front to rear) |
| Power | Peak engine power in kW. The default 120 kW car does 0-100 km/h in about 9 s |
| Top speed, Reverse speed | In km/h; the gearbox is geared so the top gear reaches top speed at the redline |
| Gears | Forward gears, 1-10 |
| Differential | Open (the easier wheel gets the power), Limited slip (default; most of it reaches the wheel with grip) or Locked (both turn together: drifts and off-road) |
| Braking | Deceleration the brakes ask for at full pedal, m/s² (9 is a road car); the tyres' grip limits what you get |
| ABS, Traction control, Stability control | The driving assists, all on by default. Turn stability control off for a car that drifts |
| Steering lock, Steering at top speed | The front wheels' angle at full lock, and the share of it left at top speed. The inner wheel turns more than the outer one, so both roll round the same centre |
| Tyre grip, Handbrake grip | The tyres' friction coefficient (1.2 is a good road tyre; 0.5 is like a wet road, 0.2 like snow), and the share of the rear grip left with the handbrake on |
| Suspension travel, stiffness, damping | Spring length, how firm it is (the car sags 9.81 / (4 x stiffness) metres at rest) and how quickly bouncing dies away |
| Anti-roll | Keeps the body flat in corners |
| Downforce | Pushes it onto the road harder the faster it goes |
| Centre of mass height | Above (or below) the wheel centres; lower is harder to roll over |
| Wheel radius | Overrides the measured wheel size (0 measures) |
| Player can drive | Off for vehicles only scripts or the AI drive |
| AI path, AI cruise speed | A Spline object the vehicle drives along whenever the player is not driving it, and its speed there |
| Engine sound, Engine volume | An audio asset of an engine loop, pitched with the revs; without one the engine is synthesized |
| Headlights | Auto (driven in the dark), On (whenever driven) or Off |

### AI driving

With an **AI path**, the vehicle drives itself along the spline, round and round a closed one or to the end of an open one, where it stops. It steers for a point ahead on the path and slows for bends it could not take at its cruise speed, so a sharp corner is taken slowly and a gentle one flat out. Knocked well off the path, it heads back to the nearest stretch. When the player gets in, they drive; when they get out, the AI carries on.

It looks ahead along where it is steering, as far as it needs to stop, and brakes to stop a few metres short of anything in its way: another vehicle, the player, a wall (ground it can drive up, a ramp or a hill, is not in its way). Pinned against something, or held up for several seconds by something that does not move off, it backs out with its wheels turned the other way and tries again.

Any vehicle left on its side or its roof, nearly still, for two seconds is set back on its wheels facing the way it was heading.

Vehicles count as moving objects: the navmesh and baked lighting leave them out.

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
| Surface | Auto | What it is made of, for tyres (see [Surfaces](#surfaces-marks-and-lights)): Auto reads it from the model's material names, triangle by triangle for a Mesh |

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

## Wind, cloth and swaying

The wind is the weather's ([Sky, time of day and weather](#sky-time-of-day-and-weather)): its speed and direction, swelling and easing in gusts that roll across the ground and swirling a little from place to place. It blows in the editor too, so you see foliage and cloth move as they will in play.

- **Foliage sways** by itself. Models whose materials are named for leaves, grass and the like (leaf, foliage, grass, bush, plant, needle, fern, flower, reed, hedge, ivy, vine...) bend from their base, more toward the top, and their leaves flutter. Woody parts (bark, trunk, branch, stem) bend a little and do not flutter. A tree's trunk and leaves bend together.
- **Wind Sway** (component) sets how much an object's model sways: **Sway** (1 for a tree or grass; 0 keeps it still) and **Leaf flutter**. Use it for a model whose materials are not named that way, or to change or stop a plant's sway.
- **Wind Zone** (component) adds wind of its own on top of the weather's. **Directional** blows along the object's forward (the blue arrow in the editor), everywhere or within **Radius**. **Radial** blows out from its middle, or draws in with a negative **Strength**. Both fade to nothing at their edge, and **Turbulence** makes them gust. Use one for a fan, a downdraft or a gap between buildings. Cloth, rain and snow feel it.
- **Cloth** (component) is a sheet hanging from the object: a flag, a banner, a curtain, a sail, washing on a line. Its top middle is at the object and it hangs down across the object's X. **Held by** pins it:
  - **Left edge**: a flag on a pole.
  - **Top edge**: a banner or curtain.
  - **Top corners**: washing or a hammock.
  - **All four corners**: a tarp or sail.
  - **Nothing**: it falls.

  Moving the object carries the cloth with it. The wind catches each part by how square it faces it. **Weight**, **Stiffness**, **Fold resistance**, **Air damping** and **Catches the wind** set how it behaves. **Colour** or a **Texture** asset sets its look. In play it rests on the ground under it and, with **Rests against characters**, drapes against the player and enemies, so a character walking through a curtain parts it. Rain wets it like any other surface.
- **Spring Bones** (component) makes the loose parts of a rigged model swing as it moves, sag and stream in the wind, then settle: hair, a ponytail, a tail, straps, a rope, a tassel. Bones whose names contain one of the **Bone names** words take part, with the bones below them. **Stiffness** is how firmly they hold the model's rest shape. **Damping** is how quickly a swing dies down. **Gravity** and **Wind** are how much those pull. A bone never bends more sharply from the one above it than a rope or lock of hair would, and bones an animation drives keep their animated pose underneath.

## Abilities

An **Abilities** component makes its object an actor with attributes, effects and abilities. Set **Belongs to** to **The player** to give the player theirs instead (put it on any object, such as the Player Start). Start from a **Preset** (Fighter, Mage, Training target) and change any part of it.

- **Attributes** are named numbers: health, mana, stamina, armor, speed, or any of your own. Each has a **Base** value, a **Min** and **Max** (a number, or another attribute's name: health's maximum is `maxHealth`), and can **Regen** so many per second after a **Delay** since it last went down.
- **Effects** change attributes and tags:
  - **Instantly**: damage, healing, spending. They change base values for good.
  - **For some seconds**: a speed boost, a weakness. They change the current value only while they last, then it returns.
  - **Until removed**: a passive aura.
  - **Every (s)**: a lasting effect applied over and over while it lasts, such as burning for 4 a second or healing over time.

  Applied again while it lasts, an effect **starts over**, **stacks** (up to a number of stacks) or is **refused**. It can **grant tags** while it lasts, **need tags** to take, have the target be **immune** with certain tags, and **remove** the effects that grant certain tags (a cleanse, or water putting out fire).
- **Abilities** have **costs** in attributes and a **cooldown**. They can **need tags**, be **blocked by** tags (no casting while State.Stunned), grant tags **while active** for some seconds, and **cancel** other active abilities by their tags. When used, they apply effects **on the user** and **on the target**. An ability with a **Range** and target effects takes the actor or character the user aims at within that range. The player's abilities bound to a **Key** are used with the number keys **1** to **4** (the left bumper and the d-pad on a gamepad).
- **Tags** are dotted names such as `State.Stunned`, `Class.Mage` or `Element.Fire`. Carrying `State.Stunned` also counts as carrying `State`. The actor's own tags are set at the top.

**What uses them:**

- **Weapons and blasts:** an actor with health takes damage from them, less its armor (100 armor halves damage). At 0 health it carries `State.Dead` and the **Actor Died** event runs. `State.Invulnerable` turns damage away.
- **The player:** health and max health are their own, so an ability's healing heals them and the HUD's health bar follows.
- **Enemies without the component** can still be targets: an ability's damage and healing reach them, and its lasting effects run on them until they end.
- **Scripts:** level scripts use them through the [ability nodes](level-scripting.md#ability-nodes), gameplay scripts through [`ctx.abilities`](scripting.md).
- **The HUD:** a bound value can show the player's attributes, their maxima and ability cooldowns. In the HUD editor's **Bind** field, choose **Player attribute**, **Player attribute maximum** or **Ability cooldown** and type the name, such as `mana` or `fireball`.

## Destruction

Add a **Destructible** component to an object for it to break into pieces: a wall, a crate, a pillar, a pane of glass, a rock. Give it a **Collider** too, so shots and vehicles can reach it.

- **Health** is the damage it takes to break. Shots take it down round by round, and explosions in reach take it down less the further they are.
- **Break speed**: a heavy loose body (a car, a falling crate) hitting it at this speed in m/s breaks it at once and carries on through, slowed by the pieces. 0 turns this off. Something light, however fast, does not break it. A piece of something already broken needs twice the speed, so one break does not easily set off the next.
- **Pieces** (2 to 64) and **Pattern** set how it breaks. Pieces are cut like cracks round random points, each keeping its share of the model's surface and gaining cut faces of the **Inside colour** (over the model's own texture). Turn on **Preview pieces (editor)** to see them in place of the model.
- **Scatter** is how fast the pieces fly apart. Those nearest the hit fly hardest, away from it. **Density** sets how heavy the pieces are: about 600 for wood, 2,400 for concrete, 2,500 for glass.
- **Pieces stay** is how many seconds the pieces lie before shrinking away (0: they stay). At most 600 pieces are loose at once; past that the oldest go first.
- **Dust and chips** raises a dust cloud and chips in the inside colour as it breaks. **Sound** plays an audio asset as it breaks; left blank, a synthesized crunch plays.

A broken object is gone for the rest of the session, and a save remembers it. Solid, roughly convex models break best: the cut faces follow the model's outer shape, so a deep hollow in a model is filled where it is cut.

Rounds the player and enemies fire now stop at walls, the ground and props instead of passing through them. Each hit shows how it struck: sparks off metal, stone and roads, dust and chips off wood, earth and plaster (in the surface's own colour), a splash in water. A round also pushes a loose body it hits. The [Explode, Break Object, Damage Object and Get Object Health nodes](level-scripting.md#destruction-nodes) and `ctx.explode`, `ctx.breakObject` and `ctx.damageObject` in [gameplay scripts](scripting.md) set off blasts and break things on cue.

## Lights

The **Lights** panel in the **Outliner** tab (under the prefab list) lists every point and spot light in the level.

- **+ Point** and **+ Spot** add a light above the origin (a spot light points down). The new light is selected so you can move it.
- Each row selects its light and has an on/off toggle, a colour swatch and an intensity field (**Int**).

The light's other settings are on its component in the inspector.

## Sky, time of day and weather

A level's **Sky Sphere** (under Logic Actors) gives it its sky, sun and fog. Select it to set them in its inspector:

| Section | What it sets |
|---|---|
| Time of Day | The hour the level shows in the editor and starts at in play: the sun rises at 6, stands overhead at noon and sets at 18, and the light turns warm near the horizon. After dark the stars come out and a moon rises opposite the sun |
| Day-Night Cycle | **Day Length**: how many real minutes a full day takes in play, starting at the Time of Day (0: time stands still). **Fog Follows Sky**: the fog takes the colour of the sky at the horizon, blue by day, orange at sunset, dark at night, instead of the Fog Color |
| Weather | The weather the level starts in: **None**, or a **Preset** (Clear, Cloudy, Overcast, Fog, Rain, Thunderstorm, Snow, Blizzard) whose values can then be changed: **Clouds** (how much sky they cover), **Rain** and **Snow** (how heavy), **Mist** (fog on top of the sky's own), **Wind** speed and the direction it blows toward, and lightning **Strikes/min** |
| Atmosphere, Light & Fog | The sky's colour (Turbidity, Rayleigh, Mie), the strength of the sun and of the sky's fill, and the fog's density and colour |

What the weather does:

- **Clouds** drift with the wind across the sky, lit by the sun and coloured by the sunset. Under heavy cloud the sun dims, shadows soften and the shade fills with the sky's light; a storm darkens all of it.
- **Rain and snow** fall around the camera wherever it goes, slanted by the wind. In play they stop at what covers them, so none falls under a roof or into a room; raindrops splash and ring ripples where they land.
- **Wet ground**: surfaces get darker and glossier while it rains, and flat ground pools into puddles; they dry slowly once it stops, faster in sun and wind. **Snow** settles on what faces up, patchy at first, and melts slowly after. In play, what is under cover stays dry and free of snow.
- **Lightning** strikes at random, lighting the scene and the clouds; near strikes draw a bolt on the sky, and thunder follows as late as sound takes to arrive, lower and longer the further off.
- **Sound** (in play): rain hisses, muffled under cover, wind gusts with its speed, and thunder rolls.
- **Vehicles** lose grip on wet roads (about 70% of their dry grip; loose ground less affected) and much more under settled snow; under cover the road stays dry. Headlights in **Auto** come on in storms and thick fog as well as at night.

In the editor the sky shows the level as it starts, everywhere (cover is worked out in play). In play, level scripts change the hour, the day length and the weather with the [Time and weather nodes](level-scripting.md#time-and-weather-nodes), and gameplay scripts with `ctx.setTimeOfDay`, `ctx.setWeather` and `ctx.setDayLength` ([scripting](scripting.md)).

## Screen effects

Every level gets global illumination, screen reflections, sunlit haze, light shafts, auto exposure, bloom, a vignette and tone mapping in play. A **Post Process** component on any object replaces that with the level's own settings, in the editor and in play (its transform does not matter, and when several objects carry one, the first applies). The player's **Post-processing** quality setting turns all of them off.

- **Global illumination**: light bounces. A sunlit wall lights the floor and walls around it in its own colour, so a red wall tints the floor beside it; and what is enclosed loses the sky light it cannot see, so a room, a doorway or the ground under a crate is darker than open ground. It is worked out every frame from what is on screen, so it follows moving lights, objects and the time of day, but something off screen or hidden behind something casts no bounce. **GI Intensity** sets its strength.
- **Screen reflections**: glossy surfaces reflect what is on screen: a polished floor shows the walls and objects standing on it, and metals reflect in their own colour. Smoother surfaces reflect more sharply and rough ones not at all; most surfaces reflect mainly at grazing angles. Where the reflected thing is off screen, the material's own environment reflection shows instead. **Reflection Intensity** sets their strength.
- **Auto exposure**: the eye adapting to the light. Looking into a bright sky dims the picture a little; dusk and dark interiors are lifted, night only so far that it stays night. It eases over about a second toward the light and two toward the dark. **Exposure Compensation** shifts where it settles, in stops; **Adaptation Speed** sets how fast. Turned off, **Exposure** alone sets the brightness.
- **Light shafts**: beams of sunlight through the gaps in trees, buildings and anything else standing against the sky, when the sun is up and in view. **Light Shafts Intensity** sets their strength.
- **Sunlit haze**: fog and mist glow toward the sun, by how much fog lies between the camera and each point. It follows the sky's fog and weather, so a clear day has almost none and a misty morning a lot. **Haze Intensity** sets its strength.
- **Motion blur**: the blur of the camera's own motion as it turns and moves. What is close to the camera, such as the character it follows, stays sharp. **Motion Blur Strength** is the shutter: 0.5 blurs half a frame's motion, 1 a whole frame's.
- **White balance**: **Temperature** warms (above 0) or cools the picture, and **Tint** pushes it toward magenta or green, without changing its brightness.
- **Look**: a colour grade over the whole picture. **Warm** and **Cool**; **Cinematic** (teal shadows, orange highlights); **Bleach bypass** (low colour, hard contrast); **Noir** (black and white); **Vintage** (faded and warm); **Night** (blue moonlight). **Look Strength** blends it in.
- **Film Grain** and **Chromatic Aberration** (colour fringes toward the edges of the picture) start at 0, which leaves them off.

If the frame rate stays low, play first lowers the resolution, and turns these effects off only if that is not enough.

## Baked lighting

Unbaked, a level's shaded sides get the same sky fill everywhere (the sky sphere's ambience and the environment light), so a room under a roof is as bright as open ground. **Baked Lighting**, under the Lights panel, bakes the light that really reaches each place into a grid of light probes:

1. Set **Gap** (world units between probes; smaller catches small rooms and tight corners but takes longer), **Bnc** (bounces: 1 lights surfaces with the open sky only, each more carries light further into enclosed spaces) and **Int** (strength of the baked light).
2. Click **Bake**. The bake runs in the viewport with a progress bar; **Cancel** stops it. A level the probes would not cover at the chosen gap within 16,384 probes gets a wider gap, shown under the buttons.

Without a **Light Bake Volume** the probes cover all of the level's static geometry, so a large terrain spreads them thin. Add the component to an object and size its box around where players go: the probes then fill the smallest box around all of the level's volumes, at the chosen gap, while geometry outside still blocks and bounces light.

The bake sees the level's static geometry (props, foliage and terrain without a Mover, Rotator or non-fixed Rigid Body, and not under one), its lights and the sky. Coloured surfaces tint the light they bounce, emissive materials give off light, and probes buried inside geometry take their neighbours' light. Each surface reads only the probes in front of it, so a thin wall, floor or roof does not let light (or the dark of an enclosed room) through to its other side. Characters, enemies and other moving objects are not part of the bake but are lit by it wherever they stand, in the editor and in play. Outside the probe grid the unbaked fill applies.

The bake is stored with the level and goes into every build. It shows **Out of date** once static objects, their lights, the sky or the Gap and Bnc settings change; **Int** changes show without baking again. **Clear** removes the bake.

## Particles

Add a **Particles** component to an object for a particle effect: smoke, fire, sparks, rain, snow, an explosion, a magic swirl, a trail, falling leaves, confetti. Pick a **Preset** to start from (Smoke, Fire, Sparks, Dust motes, Explosion, Embers, Magic, Rain, Snow, Steam, Falling leaves, Confetti, Fireflies, Waterfall mist, Muzzle flash, Shockwave, Trail, Debris, and on the GPU Fountain, Swarm and Downpour), then shape it in its sections. An object can carry several, one effect each: a campfire is a fire, its smoke and its embers.

| Section | What it sets |
|---|---|
| Emission | **Simulation** on the **CPU** or the **GPU** (see below); **Rate** per second; **Per metre moved** (particles laid along the way the object moves: trails and wakes); **Bursts** at times in each **Cycle**; **Loop** or run once; **Prewarm** (a looping effect starts as if it had been running); a **Delay** before it starts; **Max alive** |
| Shape | Where particles come from and which way they go: a **Point**, **Sphere** or **Hemisphere** (outwards), a **Cone** opening by its spread, a **Box**, a **Disc**, a **Line**, or the **model's surface** (along its faces: embers off a burning crate, sparkles off a statue). **Spread** is the cone around the **Launch axis** (up by default; rain and snow fall down it); **Fill** is 0 for the shape's edge only, 1 for anywhere in it; **Random dir.** mixes in random directions |
| Start | Each particle's **Lifetime**, **Speed**, **Size**, **Rotation** and **Spin**, picked between two values; a colour between two; how much of the object's own motion it starts with; and whether it stays in the **World** where it was left or moves with the object (**Local**: a jet's flame) |
| Forces | **Gravity** (negative rises), **Drag**, **Wind**, **Turbulence** (swirling, the size of its swirls set by **Swirl size**) and **Orbit** round the object's up axis |
| Over life | A **Colour and alpha** gradient and **Size** and **Speed** curves across each particle's life, with previews |
| Collision | **With the world**: particles bounce off what they hit (**Bounce**, **Friction**) or die there (**Die on hit**). It only runs in play |
| Sub-emitters | Another Particles component on the same object, set off where these particles **die** or **hit something**: rain that splashes, fireworks that burst, sparks that smoke |
| Rendering | **Draw as** camera-facing sprites, **stretched along their motion** (sparks, rain), **flat** (ripples, shockwaves), **upright**, or a **ribbon** through them (trails). The **Sprite** is one of the engine's (soft, smoke, spark, glow, ring, star, an animated flame, droplet, snowflake, leaf, square, debris) or a texture of the project, which can be a flipbook (columns and rows) played over each particle's life, at a frame rate, or one frame at random. **Blending** added glows, blended layers; **Brightness** above 1 glows with bloom |
| Light | A light that brightens and dims with the effect, and can flicker: a fire's glow, an explosion's flash |

### GPU particles

Set **Simulation** to **GPU** for effects of hundreds of thousands of particles: a fountain, a storm of rain over a whole valley, a swarm, a model dissolving into light. The graphics card moves and draws them, so an emitter holds up to 1,048,576 particles in play (131,072 in the editor's preview) and emits up to a million a second. Shapes (the model's surface too), forces, the curves over life, sprites and flipbooks, the light and the scripting nodes work as they do on the CPU. Some things are different:

- **Collision** is with the ground under the emitter rather than with every surface, looked for a few times a second.
- **Sub-emitters** do not run, **ribbons** draw as camera-facing sprites, and particles are not **sorted**: added (glowing) blending suits them best.
- When an emitter asks for more than it holds, its oldest particles give way to new ones.

Effects preview live in the editor, one-shot effects replaying so you can see them; collision runs only in play. In play an effect starts by itself unless **Play on start** is off; the [Play, Stop and Emit Particles](level-scripting.md#particle-nodes) nodes and `ctx.particles` in [gameplay scripts](scripting.md) start, stop and burst it.

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

A 3D sound the level hides from the listener is muffled: when something solid (anything with a collider, or the terrain's hills) stands between the camera and an Audio Source or 3D Audio Emitter, its high frequencies drop and it plays at half volume, easing back as the way opens. Rays go to the sound and to points around it, so a sound partly hidden (just around a corner, or past the edge of a wall) is only partly muffled, opening up gradually as you step out. The object a sound plays from does not hide it. 2D sounds are never muffled.

All game sound plays through four mixer buses (Master, Music, Effects and Interface), and players set each one's volume in the game's Options screen. Weapon sounds use Effects. **Audio Emitter** objects use Music when they are 2D and looping, and Effects otherwise. The **Play Sound** blueprint node chooses its bus.

## Level streaming

Big worlds can be split into levels that load as the player moves. Build each area as its own level, then in the level the player starts in, add an **Empty Object** with a **Level Streaming** component where the area begins:

- **Level to load** picks the area's level.
- **Box size** is the trigger volume around the object (drawn as a violet box in the editor).
- **Unload delay** is how long the player must be outside the box before the area unloads (2 s by default).

While the player is inside the box, every object of that level joins the play session: props, lights, terrain, colliders, components and scripts. Areas keep their own coordinates, so build them where they sit in the world. The area's player start and sky are not loaded; the starting level's are used. Objects loaded this way can be destroyed and moved like any others; unloading discards those changes, and the area loads fresh next time. Loading never changes the project. In the editor, play reads the other levels as they were when play started; a streamed level's sculpted terrain shows flat in play-in-editor until it is opened in the editor once.

## Terrain detail in play

In play and in built games, a terrain with a resolution of 64 or more is drawn in chunks of 32 by 32 cells. Chunks far from the camera use a half, a quarter or an eighth of the vertices per side, and short skirts under their edges hide the seams where chunks of different detail meet. The editor always shows the full-resolution terrain, which sculpting, painting and placement work on. Collisions always use the full-resolution heights.

## Procedural scatter

A **Procedural Scatter** component fills a box around its object with copies of models by rule instead of by hand. Put it on an empty object over the ground and set its **Area** (width, the height to search for ground within, depth).

**Each layer places one model:**

- **Per 100 m²**: how many copies.
- **Spacing**: metres kept clear around each copy, from this layer's and every other layer's copies. Put big things (trees) in the first layers, small ones (rocks, grass) after.
- **Clumping** and **Clump size**: 0 spreads copies evenly; 1 gathers them in patches about that many metres across.
- **Scale**: a size picked between two values.
- **Slope** and **Height**: the ground the layer grows on (no trees on cliffs, no reeds above the shore).
- **Lean with ground**: 0 stands copies upright; 1 tilts them with the ground, for rocks.
- **Sink**: metres up or down into the ground.
- **Collision** in play: **A trunk** (a narrow column, for trees) or **The model's box**.

Copies stand on the terrain and meshes in the area, never on other scatters. Where there is no ground, nothing is placed. They are placed again when a setting or the object changes, and the same **Seed** always gives the same placement; **New seed** tries another. Copies are drawn, not added to the level, so the Outliner stays short.

**Large scatters stay cheap.** The area is cut into cells of **Cell size** metres, each drawn as one batch per model part. Beyond **Impostors beyond**, a cell draws each copy as a flat picture of the model, made from the model once and turned toward the camera; beyond **Hidden beyond** it draws nothing. In a forest seen from above, impostors cut the triangles drawn about six times.

## Terrain painting

A terrain can blend up to four textures. Import the textures in the Content Browser first.

1. Select the terrain and open the **Sculpt** tab of the terrain inspector.
2. Under **Texture Layers**, click **+ Add Layer** and choose a **Texture**. **Tiling** sets how many times the texture repeats across the terrain's width (default 16). Layer 1 is the base layer that covers the whole terrain.
3. Click **Paint** (under Raise, Lower, Flatten and Smooth), or a layer's brush icon to paint that layer. **Radius (m)** and **Strength (%)** set the brush.

To erase paint, paint layer 1 over it. Only the last layer can be removed; its paint goes back to layer 1. Removing layer 1 returns the terrain to its plain material.

## Prefabs

A prefab is a reusable object tree. Select an object (its children come with it) and choose **Create from selection** in the prefab panel under the outliner; the selection becomes the prefab's first instance. **Place** adds another instance to the current level. The **Spawn Prefab** blueprint node places copies during play.

Instances stay linked to their prefab. Select any object of an instance and the inspector shows which prefab it belongs to and what it overrides:

- **Apply** saves the instance as the new version of the prefab and updates every other instance, in every level. Objects you added under the instance become part of the prefab.
- **Revert** puts the instance back to the prefab, dropping its overrides. The instance keeps its own position, rotation and scale.
- **Unlink** turns the instance into plain objects that prefab changes no longer reach.

When a prefab changes, a property an instance changed itself (an override, such as a moved child or a different light intensity) is kept; every other property takes the prefab's new value. Objects added to the prefab appear in every instance and removed ones disappear. Deleting a prefab unlinks its instances and leaves them in their levels.

## Placement

Placement, dropping models from the Content Browser and foliage painting all land on the surface under the cursor: terrain, other meshes, or the ground plane.
