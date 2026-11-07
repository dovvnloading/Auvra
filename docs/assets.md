# Assets

Assets live in the project's content store and are referenced by stable ids, so renaming or moving them never breaks the levels and blueprints that use them.

## Importing models

The **Content Browser** imports **FBX**, **glTF (.gltf with embedded data)**, **GLB** and **OBJ**. Importing a model opens its import options, which say what the file holds (where it came from, its size, geometry, materials, skeleton and clips) and how it will come in:

- **Size.** **As in the file** keeps the size and pivot the file says it has. An FBX file says what unit it is authored in (Blender, Maya and Mixamo write centimetres), so a 1.8 m character authored in centimetres is 1.8 m tall; glTF and GLB are metres already. **Fit to a size** scales the model so its largest side is the length you give, centred and resting on the floor. A person-shaped skeleton the file makes shorter than 1 m or taller than 2.6 m starts at 1.8 m, and the options say so. Some Mixamo files make their characters almost 4 m tall.
- **Keep.** A mesh a rigged file's skeleton does not move starts left out if it is under a tenth of the file's triangles, as some exporters leave strays behind: Meshy's rigged characters come with a sphere. Blend shapes can be left out too.
- **Animation.** Tick the clips to bring in. **Reduce keys** drops animation keys that change nothing you could see (**Light**, bones stay within 0.05 mm), keeps every key, or drops many more (**Strong**). The scissors beside a take cut it into clips: see [Cutting a take into clips](#cutting-a-take-into-clips).
- **Images not in the file.** A model naming images its file does not hold lists them. **Find images...** or **Folder...** locates them by name, and they stay with the project. An OBJ keeps its materials in a `.mtl` file beside it: the same place asks for that, then for the images it names.
- **More options** chooses between the file's normals and normals worked out from its faces, and whether normal-mapped parts get tangents.

**Keep**, **Animation** and **More options** are for FBX and OBJ files: a glTF or GLB comes in as it is. When importing several files, **Import all** brings in the rest the same way. The **Properties** of a model from an FBX or OBJ keep what its file held under **Source file**, with any warnings. A file that cannot be read says why and is not imported, and neither is one that holds no meshes and no animation.

A project opens without a model whose file cannot be read, says which and why, and keeps it in the project.

The world is in metres: gravity, vehicles, speeds and distances all are. A character's capsule, step height, jump height and third-person camera are sized from its height, so a character of any size moves and is framed the same way; a person is about 1.8 m tall. The third-person camera sits a little to the character's right, so the character stands beside the crosshair rather than under it.

An FBX that names texture images it does not contain still imports if they are not found, without those textures, and says how many it left out.

FBX and OBJ files are read by a native importer in the background, so a large file does not stall the editor. It reads every FBX version from Maya, 3ds Max, Blender, MotionBuilder, Cinema 4D and others, in binary or text:

- **Orientation and units.** A file authored Z-up is stood up on import. A file's unit is read from the file.
- **Materials.** Base colour, roughness, metalness, normal, emissive, opacity and ambient occlusion maps come through as physically based materials, including those Blender writes into its FBX exports. Roughness and metalness maps are packed into one image, a glossiness map is inverted into roughness, and a height (bump) map on a material with no normal map becomes a normal map. TGA and TIFF images are read too.
- **Geometry.** Polygons are triangulated, corners are shared between triangles, and a mesh has one piece per material. A mesh with no normals gets them worked out, keeping edges sharper than 60 degrees hard. Parts with a normal map get MikkTSpace tangents, the standard the maps are baked against, unless the file has its own.
- **Skeletons.** A character split into several meshes shares one skeleton. Each vertex keeps its four strongest bones.
- **Animation.** Each take in a file becomes a clip, with all its animation layers merged and its curves followed exactly, then cut to the take's range and stripped of keys that change nothing. A take of one frame is a pose, and lasts that frame. Blend shapes and their animation come through.

Animations in FBX and glTF files are kept and can be bound to characters in the animation graph.

Compressed glTF and GLB files load as they are: **Draco** and **meshopt** geometry is decoded as the model loads, and **KTX2 (Basis Universal)** textures are transcoded to a format the graphics card reads directly (BC7 or BC1/BC3 on desktops, ASTC or ETC on phones), so they stay small in graphics memory as well as on disk. The decoders are bundled into the editor and into built games.

Animation files without a mesh, such as Mixamo downloads made "Without Skin", go onto a character: select the character in the library, then choose **Import > Animation** and pick one or more files. A file with one clip names the clip after the file, so `Walk.fbx` gives a clip called `Walk`. The names are stored with the project, so renaming the model or file later does not rename its clips. A clip whose name the character already has is numbered: importing `Walk.fbx` twice gives `Walk` and `Walk 2`. Clips made for a skeleton with the same bone names (Mixamo characters share one) play as they are. Others are retargeted onto the character: bones are matched by what they are for (hips, spine, arms, legs, hands, fingers) across Mixamo, Unreal, Rigify, 3ds Max Biped and plain names, each bone is first lined up with the source's rest pose so a T-pose clip plays right on an A-pose character, and the hips' travel is scaled to the character's height. Most of the character's limbs and spine must find a match.

### Cutting a take into clips

Many art kits and motion capture files keep every action on one long timeline. The scissors beside a take in the import options open it on a timeline over a preview on the model, and so do the **Cut** button and the scissors on a clip in a model's **Properties**, for its own clips and for clips imported onto it. Drag along the timeline to mark a clip, or press **Add clip** to start from the whole take and trim its ends. Each clip has a name, a start and an end in frames as the file counts them or in seconds, and whether it loops. Selecting a clip plays just that stretch; **S** splits a clip at the playhead, and **[** and **]** set its ends there. Scroll over the timeline to zoom in.

A take that has clips cut from it no longer comes in whole unless **Also keep the whole take** is ticked. The first clip on a take starts with the take's own clip name, so trimming a clip changes nothing for what plays it. Clips are found by name, so renaming one is up to you: a graph state that played the old name has to be pointed at the new one.

**Start at the origin** moves a clip so the character starts where the take starts rather than wherever it has walked to by then. It comes on by itself where the character has moved away by more than half its hip height, and it can be set either way. A clip keeps the facing it has in the take.

Clips are stored with the project and cut again from the source file each time it is read: on opening the project, in a built game, and on reimport. A new export of a file with one take keeps its clips even if the take was renamed, and a clip stops at the end of a shorter take. A clip whose take is gone from a new file is left out, with a message saying which, and comes back if the take does. A graph state given a clip that says whether it loops takes that up.

A model's own clip can get a **mirrored** copy, with left and right swapped: hover the clip in the model's Properties and click the mirror button. A strafe left becomes a strafe right, a right-handed punch a left-handed one. The copy is called `<clip> (Mirrored)` and is rebuilt from its clip each time the project opens.

## What names say in a model file

Whatever format it comes in, a model file can say more through the names of its nodes, as art tools and engines have long agreed:

- **`UCX_`, `UBX_`, `USP_` and `UCP_` meshes** (hull, box, sphere, capsule), in capitals, are collision shapes. They are not drawn, unless the file has nothing else to draw. A **Rigid Body** with no **Collider** uses them instead of one hull around the model, and a **Collider** can use them with **From the model file** as its shape. Each counts as a convex hull of its corners, so a concave shape is built from several, as in the art tools.
- **`SOCKET_` nodes** become sockets of the model when a file is imported or a new one replaces it, at the place the node has, hanging from the bone or moving node above it if there is one. A socket of the same name already on the model is left as it is. A socket marks where a muzzle flash and shots start.
- **`Name_LOD0`, `Name_LOD1`** and so on, or `Name` beside `Name_LOD1`, and the children of an FBX LOD group, are simpler versions of a mesh. The finest is kept. The rest are left out, as Auvra makes the simpler levels of every mesh itself.

A mesh hidden in the art tool when an FBX was saved is left out too, unless every mesh in the file is hidden. The size the import options give is that of what is left.

## Skeletons

Select a model and open the **Skeleton** tab in the sidebar to see its bones as a tree you can search, each with the part of the body it stands for. **Show bones** draws them over the model, and clicking a joint in the view picks its bone in the tree. **Show weights** colours the model by how much the picked bone moves it, from dark where not at all to red where fully, and goes off when you leave the tab. **Add a socket here** puts a socket on the picked bone, for things carried or attached.

A clip made for one skeleton plays on another when both read as people. Bones are recognised by the names rigs commonly use (`mixamorig:LeftArm`, `upperarm_l`, `UpperArm.L`, `LUpperLeg`, `FootL`). A skeleton whose names say nothing, such as `Bone.012`, is read from its shape at rest: the feet are the lowest leaves, the head the highest, the hands those furthest out, and hips and chest are where their paths meet. The tab warns when a part is still missing. To put a bone right, pick it and choose under **This bone is**; the choice stays with the project, and **Make them again** remakes the clips from other rigs with it.

A clip plays as it is only when it fits the skeleton: the same bone names, and bones it places resting where it expects them. A clip made for other proportions or in another unit is carried over like one from any other skeleton, so feet stay on the floor even between rigs that name their bones alike.

A clip from another skeleton is rebuilt for this one rather than copied: each bone takes the pose its counterpart has, then the legs bend so that the feet land where the clip's feet land, in proportion to this character's legs. Feet that hang from the skeleton's root instead of the legs, as on rigs built for inverse kinematics, are moved to the same places. Clips keep the rate they were made at, and bones a clip never moves get no keys.

### Making a skeleton

A model with no skeleton can be given one: select it, open the **Skeleton** tab and choose **Make a skeleton**. It is for a person, upright or hunched, with their arms anywhere clear of the body, even long enough to reach the floor, or for an animal on four legs, facing any way. Spikes, horns and blades do not get in the way, nor do legs grown together, and an arm that runs on into a blade or something held has its joints where the other arm's are.

The panel starts on the kind of body the model looks like, **Person** or **Four legs**, and you can change it. **Turn around** reads the body again the other way round, for a front and back or a head and tail it got the wrong way.

The body is read from its mesh, and markers appear on the joints: on a person the chin, shoulders, elbows, wrists, groin, knees and ankles, seen from the front; on an animal the nose, head, neck, hips and tail, and each leg's shoulder or hip, elbow or knee, wrist or hock, and paw, seen from the side. Drag any that are off. Only their place in the view counts: each is kept in the middle of the limb it is on, and both sides move together unless you turn that off. An animal's far side only shows when you do. A mesh that does not read as the kind of body chosen gets markers from that kind's usual proportions to start from.

**Make the skeleton** gives the model the bones most character rigs have, turned the way those rigs turn them, with each vertex following the bones nearest it through the body, in lengths of the limb's own thickness. A hand resting on a thigh does not pull the thigh along, and loose pieces such as a belt follow the bones nearest them. Materials and images stay as they were. A person's spine follows the curve of their back.

An animal's bones are named as a person's where they stand alike: its back, neck and head, its hind legs as legs and its front legs as arms, each down to the paw. It also has a second neck bone and, if it has a tail, a chain of four bones along it, which **Give the tail bones** can leave out.

**Give the hands fingers** adds three bones to each finger, so clips that curl the fingers, such as holding a weapon, show. Fingers that stand apart are followed where they are. A hand whose fingers are grown together into a mitten, as on many generated meshes, is shared out across its width, with each finger ending at the hand's outline. Nothing behind the wrist follows a finger. Turn it off to keep each hand as one bone.

The model keeps its place in levels and blueprints, its size, its sockets and its collision shapes, and goes among the characters, its source now a GLB. Only what it draws counts as its body: parts the import leaves out are gone from the GLB. Any clips in its old file go, with a note saying so before you start. Clips from any humanoid rig can then be imported onto a person. An animal takes clips from rigs named as it is, and from rigs that say which end of the body a leg is at, such as `front_thigh.L` and `RearLeg_R`.

### Painting weights

Any weight can be corrected by hand, on a skeleton from a file as well as one made here. With a bone picked and **Show weights** on, choose a brush under **Paint weights** and drag on the model. **Add** makes the picked bone move what the brush touches more, and **Remove** less, with the other bones there taking up the difference. **Smooth** evens out all the bones under the brush. **Size** is across the brush, as a share of the model's longest side (keys `[` and `]`), and **Strength** is how far one touch moves a vertex (keys `,` and `.`). Shift does the opposite of Add or Remove. Alt-drag, or any drag that starts off the model, still turns the view. Ctrl-click picks the bone moving that spot most, and the label beside the brush lists all the bones that do.

**Pose** plays one of the model's clips, and its slider stops the clip at any moment, so a patch can be painted in the pose where it looks wrong and seen to change as it is painted.

A vertex keeps at most four bones, with shares adding up to one. The brush follows the surface out from where it lands, so a hand resting on a thigh is not painted with the thigh, and takes any other piece of the mesh in reach, such as clothes over a body. Vertices at the same place move as one, across texture seams, materials and meshes, and a mesh is given any bone it did not have.

Each stroke is one step of undo (Ctrl+Z and Ctrl+Y), and **Put back original** returns to the weights the model came with. Painted weights are kept with the model, apart from its source file. They go with the project into built games, and stay through **Import Settings** and **Reimport** wherever vertices still stand in the same place. The editor says so when a new file leaves some of them nowhere to go.

## Reimport and import settings

Choose **Reimport** on a model to replace its source file. The model keeps its id, so everything placed in levels and linked in blueprints updates to the new file.

Choose **Import Settings** on a model to change how it imports after the fact: the same options as when it was imported. The model is read again from its source; it keeps its id, overrides and clips, and everything placed or linked updates. To make a 5 m character person-sized, fit its largest side to 1.8.

## Material overrides

Change how a model's materials look without editing its source file:

1. Open the **Scene** tab and select the model.
2. In the **Properties** sidebar, open **Material Overrides**.
3. Click a material to expand it and change **Color**, **Roughness**, **Metalness**, **Emissive**, **Glow** (emissive strength), **Opacity**, **Base map**, **Normal map**, **Roughness map** or **Metalness map**. Maps are picked from the project's textures; the reset button next to a map clears it. Edits show on the model straight away.
4. Click **Save**. **Revert** discards unsaved edits; the reset button next to a field returns it to the imported value.

Overrides are stored with the model, so every placed copy and every build uses them: all copies of a model share one set of values. They are matched by material name and survive **Reimport**; an override whose material no longer exists is flagged so you can remove it. Unnamed materials cannot be overridden, and Animation models have no overrides. Closing the section discards unsaved edits.

Every map a model's material wears shows here, including those **Retexture** saves. A picture Retexture or the mask tool puts on a material is kept as a painted copy the model owns: the painted picture over the material's own normal, roughness, metalness and other maps, which stay as they were. It shows here as the material's painted **Base map**. A result Retexture saves is a painted picture: it shows its own colours, is cut out where it is see-through and draws from both sides, as the note under its **Base map** says. Picking another base map, or clearing it, draws the material as usual again. Base maps that older projects stored apart from the other overrides show here as painted pictures too. **Reset Textures** at the top of the model's properties takes every painted picture off, so the model wears the maps it was imported with; the other overrides stay.

A physical material, as glTF files using the coat, sheen, transmission, specular, index of refraction, thin film or anisotropy extensions bring in, also lists those values under **Coat**, **Sheen**, **Specular**, **Thin film** and **Transmission** (what each does is under [Physical surfaces](#physical-surfaces)). The groups the material uses open on their own, and a closed group says when it is in use. They save with the override like the other fields, so a car paint's coat can be made glossier or a bottle's glass greener, and the reset button returns each to the imported value. While a material asset shades the material, the asset decides these values.

## Material graphs

A material asset describes a surface as a graph of nodes, so one material can be shared by many models and can animate, tile, blend, cut out, move its vertices and react to the view angle.

1. Open the **Materials** tab, click **New** and pick **Shader graph**. The asset starts with a **Material Output** node; rename it in the field above the preview. To start from a finished surface instead, pick one under **Start from a shader graph** in the same menu: **Car paint**, **Frosted glass**, **Velvet**, **Lacquered wood** or **Rubber**, each set to realistic values.
2. Right-click the canvas (or press **Space** or **Tab**, or click **Add node**) and type to find a node by name or keyword; arrow keys and **Enter** pick it, and it lands where the pointer is. With nothing typed the palette lists every node by category:
   - **Input**: Number, Color, Vector 2, Vector, Time.
   - **Geometry**: UV, World Position, Local Position, Object Position, World Normal, Local Normal, View Direction, Camera Position, Camera Distance, Vertex Color, Fresnel.
   - **UV**: Tiling and Offset, Panner, Rotate UV, Polar Coordinates, Flipbook, Parallax Offset, UDIM Atlas (reads a set of UDIM tiles from one picture, as Paint makes it).
   - **Texture**: Texture Sample, Normal Map, Triplanar Sample, Triplanar Normal Map, Parallax, Normal From Height, Normal Blend, Normal Strength. Set a Texture Sample or Triplanar Sample's **Read As** to **Data** for masks, roughness, metalness and height maps, so their values are not treated as sRGB colour; tick a Normal Map's **Flip Green (DirectX)** for maps baked with the green channel pointing down.
   - **Procedural**: Noise, Fractal Noise (gradient, simplex or value noise; fractal, turbulence or ridged), Voronoi, Checker, Brick, Gradient.
   - **Color**: Color Ramp, Blend (14 modes), Hue / Saturation / Value, RGB to HSV, HSV to RGB, Desaturate, Contrast, Posterize, Luminance.
   - **Math**, **Vector** and **Logic**: arithmetic, trigonometry, Lerp, Clamp, Smoothstep, Remap, Split, Combine, Swizzle, Dot, Cross, Rotate About Axis, Branch, Switch and more.
   - **Custom**: Custom GLSL, your own function of four inputs.
   - **Utility**: Reroute, Send and Receive (every Receive gives out what the first Send of its name takes in, with no wire across the graph).
3. Drag from a pin to a pin of the other kind to wire them (outputs on the right, inputs on the left). Pin colours show the value type: grey a number, green a 2-vector, yellow a 3-vector or colour, purple a 4-vector. Math nodes take the widest type wired into them, so adding two colours gives a colour. A value of another type is converted (a single number fills every component, a longer vector is cut down). Each input takes one wire, so a new wire replaces the old one, and a wire that would make a loop is refused.
4. Drop a wire on empty space to pick a node for it: the new node is wired to it. Drag a wire off an input to move it to another, or drop it on empty space. **Alt**-click or right-click a wire to cut it; double-click a wire to bend it through a **Reroute**.
5. Every node shows its value as a small image as you edit (the eye button turns these previews off). Nodes that feed nothing the material reads are dimmed with a dashed border.
6. Select nodes by clicking (**Shift** or **Ctrl** adds) or by dragging a box on empty space; drag a selected node to move them all. **Ctrl+C**, **Ctrl+X** and **Ctrl+V** copy, cut and paste nodes (between materials too, as text), **Ctrl+D** duplicates, **Delete** removes, **Ctrl+A** selects all, **Ctrl+Z** and **Ctrl+Y** undo and redo, **F** frames the view on the selection (or everything) and **C** puts a frame round the selection. A frame moves the nodes inside it; double-click its title to rename it, and pick its colour from its menu or in the inspector. Right- or middle-drag pans and the wheel zooms.

   Right-click a node to rename it (**F2**), colour its header, fold it to its header (**H**) or bypass it (**B**). A bypassed node passes its main input straight through (the first, or a Step's and an Inverse Lerp's value, a Branch's True), so you can see the material without it. Names, colours and folding change nothing the material draws.
7. Select a node to change its settings in the inspector. Drag a number's label sideways to change it (**Shift** for finer steps). A Color Ramp's stops are edited on its bar: drag a stop, double-click the bar to add one, pick its colour below. Custom GLSL is applied with **Apply** or **Ctrl+Enter**.
8. Select nothing to set the material itself, on the Material Output. Its settings come first:
   - **Alpha mode**: **Opaque**; **Masked (cut-out)** (cut out where Opacity is below **Alpha clip**, and the shadow has the same holes); **Translucent**; **Additive** (glows add to what is behind).
   - **Two-sided** shades the back faces too; **Shading** **Unlit** shows the base colour and emission without lighting.
   - **Normal input**: **Like a normal map** (tangent space, as the Normal Map node gives) or **In world space** (as the Triplanar Normal Map node gives).
   - **Keep the model's own maps**: what the graph leaves unwired (base colour, roughness, metalness, normal, emission) comes from the model's own material, its maps and values, as painted copies do.

   Below them are the values its unwired inputs take, in groups: **Base** (base colour, metalness, roughness), **Specular**, **Coat**, **Sheen**, **Thin film**, **Transmission**, **Emission** and **Opacity**. Click a group's header to open or close it. A group the material uses opens on its own, and an input with a wire into it says so instead of offering a value.
9. Connect the Material Output's inputs for the surface: **Base colour**, **Metalness**, **Roughness**, **Normal**, **Ambient occlusion**, **Self-shadow** (darkens only the sunlight, as Parallax's Shadow does), **Emission colour** and **Emission strength**, **Opacity**, and the [physical layers](#physical-surfaces). **Vertex offset** moves its vertices (in world units): the offset moves the shadow too, and works on skinned and instanced meshes.

The preview shows the material on a sphere, cube, plane, cylinder or knot, casting its shadow on a floor; drag it to turn it and scroll to zoom. **Lighting** under it picks what lights it and shows in its reflections: **Studio** (soft panels), **Room** (a bright interior with windows), **Outdoor** (open sky and the sun) or **Night**. **Background** shows what surrounds the shape behind it: the room or the outdoors themselves, or a lit backdrop for Studio and Night. A see-through material always shows it, so glass has something to show through it. Both choices are remembered. A shader that does not compile (a mistake in Custom GLSL) is reported under the preview with the line it names. Changes save on their own, and undo keeps each material's steps while the project is open, across switching tabs. Changing a value updates every model using the asset at once; only changes to wiring, to a node's choices or to what is bypassed rebuild its shader. Time nodes run in every viewport, in play and in builds, counting seconds from when the editor or the game opened.

To use a material asset on a model, open the model's **Material Overrides**, expand a material and pick the asset in **Material asset**, then click **Save**. The model's material is then shaded by the graph, in every placed copy and every build; its own colour, map and PBR fields apply again when you set **Material asset** back to **Its own**. Rain, snow and wind still reach a graph-shaded material, and bounced light takes its colour from the graph. Deleting a material asset returns every model that used it to its own material, and deleting a texture clears it from the Texture Sample, Normal Map and Triplanar Sample nodes that read it.

**Material asset** offers only assets that draw. A texture graph is offered once its pictures are made (**Update material**), and a painting once it is put on a model; until then the field names them in a note. A graph for other graphs is never offered. A material drawn without lighting, or an older kind of shaded material, cannot be shaded by a graph: its **Material asset** field is turned off and says so.

A material made from a texture graph or a painting keeps its pictures by name (base colour, normal, height...). Its graph reads them with **Material Picture** nodes (Texture), and Parallax can take **Height from** the material's height picture. Making the pictures again (**Update material**, or putting a painting on a model) changes only the pictures, so changes made by hand to the graph stay.

Deleting a material asks first, naming the models and decals that use it, and **Undo** at the top of the material list brings it back with every model's settings as they were.

Materials made before blend modes keep their look: one whose opacity was set or wired is **Translucent**, any other **Opaque**.

A shader that does not compile marks the nodes whose code failed on the canvas, and on a Custom GLSL node's code, with what is wrong in plain words; the panel under the preview says the same, with the compiler's own lines behind **Details**.

### Height, parallax and triplanar normals

**Parallax** makes a flat surface look deep: it follows the view into a height map (white high, black low), so bricks, stones and tiles look raised as you move round them. Wire its **UV** into the textures it should move and its **Shadow** into the Material Output's **Self-shadow**, where the raised parts shade the low ones from the sun. **Depth** is in texture units; **Quality** takes 8, 16 or 32 steps; **Self-shadow** off skips the shadow. Materials made from pictures with a height (a texture graph's **Update material**, or a painting put on a model) are wired this way for you, with a depth of 0.03 that each model and placed object can change through the material's **Height depth** value.

**Triplanar Normal Map** projects a normal map from the three axes, each face reading it the right way round, and blends the bumps onto the surface, so cliffs and rocks without good UVs get bumps with no seams or mirrored faces. It gives a world-space normal: set the Material Output's **Normal input** to **In world space**.

### Physical surfaces

Beyond base colour, metalness and roughness, the Material Output builds a surface up in layers, as glTF's physical materials do:

- **Specular**: **Specular strength** and **Specular colour** weaken and tint the reflection of a surface that is not metal. **Index of refraction** sets how strongly it reflects (1.33 for water, 1.5 for glass and most plastics, 2.4 for diamond). **Anisotropy** stretches highlights along one direction, as on brushed metal, turned by **Anisotropy direction**.
- **Coat**: a clear layer over the surface (car paint, lacquer, varnish) with its own **Coat roughness** and **Coat normal**.
- **Sheen**: the soft light at the edges of cloth such as velvet, in its own colour and roughness. Black is no sheen.
- **Thin film**: rainbow colours like a soap bubble or oil on water; **Thin film thickness**, in nanometres, picks the colours.
- **Transmission**: light passes through the surface (glass, water, thin plastic). **Thickness** is how deep the volume behind it is; light crossing it takes on the **Absorption colour** over the **Absorption distance**, and **Dispersion** splits it into colours.

A material draws with the plainer, cheaper shader until one of these is wired or set away from its default. Only then does it draw as a physical surface, and only the layers it uses cost anything. Changing a value updates the material at once; turning a layer on or off rebuilds its shader. Rain and snow still lie on coated and see-through materials: rain makes a coat glossier, and snow covers glass rather than frosting it.

### Material parameters: values, textures and switches

A material asset can leave some of its values to the models that use it, like a material instance. Select a **Number**, **Color** or **Vector** node, a **Texture Sample**, **Normal Map**, **Triplanar Sample**, **Triplanar Normal Map** or **Parallax** (its picture), or a **Switch**, and give it a **Parameter name** (the node shows the name in its title). Nodes with the same name share one value.

A **Switch** picks its **On** or **Off** input when the material is built, so only the side picked is drawn and costs anything. Each choice of a switch builds a shader version of its own, which takes time to build and memory to keep: Material Overrides and the level inspector say how many versions a material builds when its switches make more than one. Values and textures never add one.

In a model's **Material Overrides**, a material shaded by that asset lists its parameters under **Material parameters**. Set a value to give this material its own (a red tint on one model's crates, a blue one on another model using the same asset); the reset button returns it to the value in the graph. Like all overrides, the values belong to the model, so every placed copy of it shares them. Number, Color, Vector and Vector 2 values, textures and switches can all be parameters. Values and textures only change what the shader is given, so every material using the asset keeps sharing one shader; a switch set another way makes another version.

A placed object can set its own values too, for that object alone: select it in the level and open **Material values** in the inspector. Each material shaded by an asset with parameters lists them, showing the model's value where the object sets none. The model and its other copies keep theirs. An object with values of its own is drawn on its own rather than with its model's other copies, in the editor and in play.

While a game plays, the blueprint's **Set Material Number** and **Set Material Colour** nodes set a value on one object (a switch is on for any number but 0); its other copies keep theirs.

## Textures and audio

Images and audio files are imported from the Content Browser in the same way. Textures are used by material assets, material overrides, terrain layers, decals and masks. Audio is used by audio emitters, Audio Source components, the **Play Sound** blueprint node and weapon sounds.

Textures can be PNG, JPEG or WebP, and also 16-bit PNG, TIFF (8, 16 or 32-bit floating point), OpenEXR, Radiance HDR, TGA and Photoshop PSD. A PSD is read as its flattened picture, which Photoshop keeps when it is saved with **Maximize compatibility**. These deep pictures keep their depth: they are read whole, not cut to 8 bits, and material assets draw with them as they are. Everywhere else that shows a picture (the Content Browser, terrain, decals) uses an 8-bit preview made on import.

**Texture Settings** on a texture's menu in the Content Browser sets how it is kept and drawn:

- **Read as**: **By use** (colour where a material reads colour, data where it reads data), **Colour**, or **Data** (masks, roughness, metalness, height: values kept as stored). **Normal map** marks it as one wherever it is read.
- **Compression**: **By what it is** compresses colour to BC7, normal maps to BC5 and one channel of data to BC4, for about a quarter (or an eighth) of the memory; or pick one, or **None**. Pictures with light beyond white stay 16-bit floating point. A graphics card that cannot take a compression gets the texture whole. The game's **Texture compression** setting turns compression off altogether.
- **Size limit** draws it no larger than that; **Mip levels** keeps smaller copies for far away (made with a sharp filter, normals kept unit length); **Edges** repeat, stretch or mirror; **Filter** is smooth or pixelated.

A texture whose name ends _n, _nrm, _normal, _nor or _nor_gl (a size such as _4k after it is fine) is imported as a normal map, and one ending _nor_dx as a DirectX normal map, whose green is turned over as it loads (**Green points** in its settings). Roughness, metallic, occlusion, height and packed maps are read as data. Texture Settings can change any of it.

A texture is compressed once: the result is kept in the project and in built games, so reopening the project or playing the game loads it as it is. Textures named by material overrides and decals take the same path as material textures.

Its preview shows the picture as imported and as kept, side by side, with the memory each takes. Compressed sides must be a multiple of 4 pixels. **Memory** in the Materials tab shows what a level's textures take against the game's asset memory, its largest textures and what each material asset's textures take, with plain warnings where it is a lot.

## Folders

Use folders to organise assets: create a folder, then **Move** assets into it. **Rename** changes an asset's display name; model names must be unique.

## Exporter notes

Many FBX exporters (including Blender) write a white emissive colour with zero strength. Auvra ignores that so imported models do not glow.
