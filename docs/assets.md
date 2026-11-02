# Assets

Assets live in the project's content store and are referenced by stable ids, so renaming or moving them never breaks the levels and blueprints that use them.

## Importing models

The **Content Browser** imports **FBX**, **glTF (.gltf with embedded data)**, **GLB** and **OBJ**. Importing a model opens its import options, which say what the file holds (where it came from, its size, geometry, materials, skeleton and clips) and how it will come in:

- **Size.** **As in the file** keeps the size and pivot the file says it has. An FBX file says what unit it is authored in (Blender, Maya and Mixamo write centimetres), so a 1.8 m character authored in centimetres is 1.8 m tall; glTF and GLB are metres already. **Fit to a size** scales the model so its largest side is the length you give, centred and resting on the floor. A person-shaped skeleton the file makes shorter than 1 m or taller than 2.6 m starts at 1.8 m, and the options say so. Some Mixamo files make their characters almost 4 m tall.
- **Keep.** A mesh a rigged file's skeleton does not move starts left out if it is under a tenth of the file's triangles, as some exporters leave strays behind: Meshy's rigged characters come with a sphere. Blend shapes can be left out too.
- **Animation.** Tick the clips to bring in. **Reduce keys** drops animation keys that change nothing you could see (**Light**, bones stay within 0.05 mm), keeps every key, or drops many more (**Strong**).
- **Images not in the file.** A model naming images its file does not hold lists them. **Find images...** or **Folder...** locates them by name, and they stay with the project.
- **More options** chooses between the file's normals and normals worked out from its faces, and whether normal-mapped parts get tangents.

When importing several files, **Import all** brings in the rest the same way. A model's **Properties** keep what its file held under **Source file**, with any warnings.

The world is in metres: gravity, vehicles, speeds and distances all are. A character's capsule, step height, jump height and third-person camera are sized from its height, so a character of any size moves and is framed the same way; a person is about 1.8 m tall. The third-person camera sits a little to the character's right, so the character stands beside the crosshair rather than under it.

An FBX that names texture images it does not contain still imports if they are not found, without those textures, and says how many it left out.

FBX and OBJ files are read by a native importer in the background, so a large file does not stall the editor. It reads every FBX version from Maya, 3ds Max, Blender, MotionBuilder, Cinema 4D and others, in binary or text:

- **Orientation and units.** A file authored Z-up is stood up on import. A file's unit is read from the file.
- **Materials.** Base colour, roughness, metalness, normal, emissive, opacity and ambient occlusion maps come through as physically based materials, including those Blender writes into its FBX exports. Roughness and metalness maps are packed into one image, and a glossiness map is inverted into roughness. TGA and TIFF images are read too.
- **Geometry.** Polygons are triangulated, corners are shared between triangles, and a mesh has one piece per material. A mesh with no normals gets them worked out, keeping edges sharper than 60 degrees hard. Parts with a normal map get MikkTSpace tangents, the standard the maps are baked against, unless the file has its own.
- **Skeletons.** A character split into several meshes shares one skeleton. Each vertex keeps its four strongest bones.
- **Animation.** Each take in a file becomes a clip, with all its animation layers merged and its curves followed exactly, then cut to the take's range and stripped of keys that change nothing. Blend shapes and their animation come through.

Animations in FBX and glTF files are kept and can be bound to characters in the animation graph.

Compressed glTF and GLB files load as they are: **Draco** and **meshopt** geometry is decoded as the model loads, and **KTX2 (Basis Universal)** textures are transcoded to a format the graphics card reads directly (BC7 or BC1/BC3 on desktops, ASTC or ETC on phones), so they stay small in graphics memory as well as on disk. The decoders are bundled into the editor and into built games.

Animation files without a mesh, such as Mixamo downloads made "Without Skin", go onto a character: select the character in the library, then choose **Import > Animation** and pick one or more files. A file with one clip names the clip after the file, so `Walk.fbx` gives a clip called `Walk`. The names are stored with the project, so renaming the model or file later does not rename its clips. A clip whose name the character already has is numbered: importing `Walk.fbx` twice gives `Walk` and `Walk 2`. Clips made for a skeleton with the same bone names (Mixamo characters share one) play as they are. Others are retargeted onto the character: bones are matched by what they are for (hips, spine, arms, legs, hands, fingers) across Mixamo, Unreal, Rigify, 3ds Max Biped and plain names, each bone is first lined up with the source's rest pose so a T-pose clip plays right on an A-pose character, and the hips' travel is scaled to the character's height. Most of the character's limbs and spine must find a match.

A model's own clip can get a **mirrored** copy, with left and right swapped: hover the clip in the model's Properties and click the mirror button. A strafe left becomes a strafe right, a right-handed punch a left-handed one. The copy is called `<clip> (Mirrored)` and is rebuilt from its clip each time the project opens.

## Skeletons

Select a model and open the **Skeleton** tab in the sidebar to see its bones as a tree you can search, each with the part of the body it stands for. **Show bones** draws them over the model. **Show weights** colours the model by how much the picked bone moves it, from dark where not at all to red where fully. **Add a socket here** puts a socket on the picked bone, for things carried or attached.

A clip made for one skeleton plays on another when both read as people. Bones are recognised by the names rigs commonly use (`mixamorig:LeftArm`, `upperarm_l`, `UpperArm.L`, `LUpperLeg`, `FootL`). A skeleton whose names say nothing, such as `Bone.012`, is read from its shape at rest: the feet are the lowest leaves, the head the highest, the hands those furthest out, and hips and chest are where their paths meet. The tab warns when a part is still missing. To put a bone right, pick it and choose under **This bone is**; the choice stays with the project, and **Make them again** remakes the clips from other rigs with it.

A clip from another skeleton is rebuilt for this one rather than copied: each bone takes the pose its counterpart has, then the legs bend so that the feet land where the clip's feet land, in proportion to this character's legs. Feet that hang from the skeleton's root instead of the legs, as on rigs built for inverse kinematics, are moved to the same places. Clips keep the rate they were made at, and bones a clip never moves get no keys.

## Reimport and import settings

Choose **Reimport** on a model to replace its source file. The model keeps its id, so everything placed in levels and linked in blueprints updates to the new file.

Choose **Import Settings** on a model to change how it imports after the fact: the same options as when it was imported. The model is read again from its source; it keeps its id, overrides and clips, and everything placed or linked updates. To make a 5 m character person-sized, fit its largest side to 1.8.

## Material overrides

Change how a model's materials look without editing its source file:

1. Open the **Scene** tab and select the model.
2. In the **Properties** sidebar, open **Material Overrides**.
3. Click a material to expand it and change **Color**, **Roughness**, **Metalness**, **Emissive**, **Glow** (emissive strength), **Opacity**, **Base map** or **Normal map**. Maps are picked from the project's textures. Edits show on the model straight away.
4. Click **Save**. **Revert** discards unsaved edits; the reset button next to a field returns it to the imported value.

Overrides are stored with the model, so every placed copy and every build uses them. They are matched by material name and survive **Reimport**; an override whose material no longer exists is flagged so you can remove it. Unnamed materials cannot be overridden, and Animation models have no overrides. Closing the section discards unsaved edits.

## Material graphs

A material asset describes a surface as a graph of nodes, so one material can be shared by many models and can animate, tile, blend, cut out, move its vertices and react to the view angle.

1. Open the **Materials** tab and click **New**. The asset starts with a **Material Output** node; rename it in the field above the preview.
2. Right-click the canvas (or press **Space** or **Tab**, or click **Add node**) and type to find a node by name or keyword; arrow keys and **Enter** pick it, and it lands where the pointer is. With nothing typed the palette lists every node by category:
   - **Input**: Number, Color, Vector 2, Vector, Time.
   - **Geometry**: UV, World Position, Local Position, Object Position, World Normal, Local Normal, View Direction, Camera Position, Camera Distance, Vertex Color, Fresnel.
   - **UV**: Tiling and Offset, Panner, Rotate UV, Polar Coordinates, Flipbook, Parallax Offset.
   - **Texture**: Texture Sample, Normal Map, Triplanar Sample, Normal From Height, Normal Blend, Normal Strength. Set a Texture Sample or Triplanar Sample's **Read As** to **Data** for masks, roughness, metalness and height maps, so their values are not treated as sRGB colour; tick a Normal Map's **Flip Green (DirectX)** for maps baked with the green channel pointing down.
   - **Procedural**: Noise, Fractal Noise (gradient, simplex or value noise; fractal, turbulence or ridged), Voronoi, Checker, Brick, Gradient.
   - **Color**: Color Ramp, Blend (14 modes), Hue / Saturation / Value, RGB to HSV, HSV to RGB, Desaturate, Contrast, Posterize, Luminance.
   - **Math**, **Vector** and **Logic**: arithmetic, trigonometry, Lerp, Clamp, Smoothstep, Remap, Split, Combine, Swizzle, Dot, Cross, Rotate About Axis, Branch and more.
   - **Custom**: Custom GLSL, your own function of four inputs.
   - **Utility**: Reroute.
3. Drag from a pin to a pin of the other kind to wire them (outputs on the right, inputs on the left). Pin colours show the value type: grey a number, green a 2-vector, yellow a 3-vector or colour, purple a 4-vector. Math nodes take the widest type wired into them, so adding two colours gives a colour. A value of another type is converted (a single number fills every component, a longer vector is cut down). Each input takes one wire, so a new wire replaces the old one, and a wire that would make a loop is refused.
4. Drop a wire on empty space to pick a node for it: the new node is wired to it. Drag a wire off an input to move it to another, or drop it on empty space. **Alt**-click or right-click a wire to cut it; double-click a wire to bend it through a **Reroute**.
5. Every node shows its value as a small image as you edit (the eye button turns these previews off). Nodes that feed nothing the material reads are dimmed with a dashed border.
6. Select nodes by clicking (**Shift** or **Ctrl** adds) or by dragging a box on empty space; drag a selected node to move them all. **Ctrl+C**, **Ctrl+X** and **Ctrl+V** copy, cut and paste nodes (between materials too, as text), **Ctrl+D** duplicates, **Delete** removes, **Ctrl+A** selects all, **Ctrl+Z** and **Ctrl+Y** undo and redo, **F** frames the selection (or everything) and **C** puts a comment box around the selection. A comment moves the nodes inside it; double-click its title to rename it and pick its colour in the inspector. Right- or middle-drag pans and the wheel zooms.
7. Select a node to change its settings in the inspector. Drag a number's label sideways to change it (**Shift** for finer steps). A Color Ramp's stops are edited on its bar: drag a stop, double-click the bar to add one, pick its colour below. Custom GLSL is applied with **Apply** or **Ctrl+Enter**.
8. Select nothing to set the material itself, on the Material Output:
   - **Blend Mode**: **Opaque**; **Masked** (cut out where Opacity is below **Alpha Clip**, and the shadow has the same holes); **Translucent**; **Additive** (glows add to what is behind).
   - **Two Sided** shades the back faces too; **Shading** **Unlit** shows the base colour and emissive without lighting.
   - The values its unwired inputs take: Base Color, Opacity, Metalness, Roughness and Emissive.
9. Connect the Material Output's **Base Color**, **Opacity**, **Metalness**, **Roughness**, **Normal (tangent space)**, **Emissive** and **Ambient Occlusion** inputs for the surface, and **World Position Offset** to move its vertices (in world units): the offset moves the shadow too, and works on skinned and instanced meshes.

The preview shows the material on a sphere, cube, plane, cylinder or knot, lit by an environment that shows reflections and casting its shadow on a floor; drag it to turn it and scroll to zoom. A shader that does not compile (a mistake in Custom GLSL) is reported under the preview with the line it names. Changes save on their own. Time nodes run in every viewport, in play and in builds.

To use a material asset on a model, open the model's **Material Overrides**, expand a material and pick the asset in **Material asset**, then click **Save**. The model's material is then shaded by the graph, in every placed copy and every build; its own colour, map and PBR fields apply again when you set **Material asset** back to **(its own)**. Deleting a material asset returns every model that used it to its own material, and deleting a texture clears it from the Texture Sample, Normal Map and Triplanar Sample nodes that read it.

Materials made before blend modes keep their look: one whose opacity was set or wired is **Translucent**, any other **Opaque**.

### Material parameters

A material asset can leave some of its values to the models that use it, like a material instance. Select a **Number**, **Color** or **Vector** node and give it a **Parameter name** (the node shows the name in its title). Nodes with the same name share one value.

In a model's **Material Overrides**, a material shaded by that asset lists its parameters under **Material parameters**. Set a value to give this material its own (a red tint on one crate, a blue one on another); the reset button returns it to the value in the graph. Parameters only change values, not wiring, so every material using the asset keeps sharing one shader.

## Textures and audio

Images and audio files are imported from the Content Browser in the same way. Textures are used by material overrides, terrain layers and masks. Audio is used by audio emitters, Audio Source components, the **Play Sound** blueprint node and weapon sounds.

## Folders

Use folders to organise assets: create a folder, then **Move** assets into it. **Rename** changes an asset's display name; model names must be unique.

## Exporter notes

Many FBX exporters (including Blender) write a white emissive colour with zero strength. Auvra ignores that so imported models do not glow.
