# Assets

Assets live in the project's content store and are referenced by stable ids, so renaming or moving them never breaks the levels and blueprints that use them.

## Importing models

The **Content Browser** imports **FBX**, **glTF (.gltf with embedded data)**, **GLB** and **OBJ**. When you import a model, the import options ask whether to **normalise** it:

- **Normalise on** scales the model so its largest dimension equals the target size (5 units by default). Useful for assets from mixed sources.
- **Normalise off** keeps the authored scale.

Animations in FBX and glTF files are kept and can be bound to characters in the animation graph.

Compressed glTF and GLB files load as they are: **Draco** and **meshopt** geometry is decoded as the model loads, and **KTX2 (Basis Universal)** textures are transcoded to a format the graphics card reads directly (BC7 or BC1/BC3 on desktops, ASTC or ETC on phones), so they stay small in graphics memory as well as on disk. The decoders are bundled into the editor and into built games.

Animation files without a mesh, such as Mixamo downloads made "Without Skin", go onto a character: select the character in the library, then choose **Import > Animation** and pick one or more files. A file with one clip names the clip after the file, so `Walk.fbx` gives a clip called `Walk`. The names are stored with the project, so renaming the model or file later does not rename its clips. A clip whose name the character already has is numbered: importing `Walk.fbx` twice gives `Walk` and `Walk 2`. Clips made for a skeleton with the same bone names (Mixamo characters share one) play as they are. Others are retargeted onto the character: bones are matched by what they are for (hips, spine, arms, legs, hands, fingers) across Mixamo, Unreal, Rigify, 3ds Max Biped and plain names, each bone is first lined up with the source's rest pose so a T-pose clip plays right on an A-pose character, and the hips' travel is scaled to the character's height. Most of the character's limbs and spine must find a match.

A model's own clip can get a **mirrored** copy, with left and right swapped: hover the clip in the model's Properties and click the mirror button. A strafe left becomes a strafe right, a right-handed punch a left-handed one. The copy is called `<clip> (Mirrored)` and is rebuilt from its clip each time the project opens.

## Reimport

Choose **Reimport** on a model to replace its source file. The model keeps its id, so everything placed in levels and linked in blueprints updates to the new file.

## Material overrides

Change how a model's materials look without editing its source file:

1. Open the **Scene** tab and select the model.
2. In the **Properties** sidebar, open **Material Overrides**.
3. Click a material to expand it and change **Color**, **Roughness**, **Metalness**, **Emissive**, **Glow** (emissive strength), **Opacity**, **Base map** or **Normal map**. Maps are picked from the project's textures. Edits show on the model straight away.
4. Click **Save**. **Revert** discards unsaved edits; the reset button next to a field returns it to the imported value.

Overrides are stored with the model, so every placed copy and every build uses them. They are matched by material name and survive **Reimport**; an override whose material no longer exists is flagged so you can remove it. Unnamed materials cannot be overridden, and Animation models have no overrides. Closing the section discards unsaved edits.

## Material graphs

A material asset describes a surface as a graph of nodes, so one material can be shared by many models and can animate, tile, blend and react to the view angle.

1. Open the **Materials** tab and click **New**. The asset starts with a **Material Output** node; rename it in the field above the preview.
2. Click **Add node** and pick a node. The palette groups them as **Input** (Number, Color, Vector, Time), **UV** (UV, Tiling and Offset, Panner), **Texture** (Texture Sample, Normal Map), **Surface** (Fresnel, World Position, Vertex Color), **Math** (Noise, Add, Subtract, Multiply, Divide, Min, Max, Power, Step, Lerp, Clamp, Smoothstep, One Minus, Abs, Saturate, Sine, Cosine, Fraction, Floor) and **Vector** (Split, Combine, Dot, Normalize, Length).
3. Drag from an output pin on the right of a node to an input pin on the left of another. Pin colours show the value type; a value of another type is converted (a single number fills every component, a longer vector is cut down). Each input takes one wire, so a new wire replaces the old one, and a wire that would make a loop is refused. Click a wire to remove it.
4. Select a node to change its settings below the preview. **Delete** removes the selected node; the Material Output cannot be removed.
5. Connect the Material Output's **Base Color**, **Opacity**, **Metalness**, **Roughness**, **Normal (tangent space)**, **Emissive** and **Ambient Occlusion** inputs. An input with no wire uses the value set on the Material Output node.

The preview sphere updates as you edit, and changes save on their own. Time nodes run in every viewport, in play and in builds.

To use a material asset on a model, open the model's **Material Overrides**, expand a material and pick the asset in **Material asset**, then click **Save**. The model's material is then shaded by the graph, in every placed copy and every build; its own colour, map and PBR fields apply again when you set **Material asset** back to **(its own)**. Deleting a material asset returns every model that used it to its own material, and deleting a texture clears it from the Texture Sample and Normal Map nodes that read it.

## Textures and audio

Images and audio files are imported from the Content Browser in the same way. Textures are used by material overrides, terrain layers and masks. Audio is used by audio emitters, Audio Source components, the **Play Sound** blueprint node and weapon sounds.

## Folders

Use folders to organise assets: create a folder, then **Move** assets into it. **Rename** changes an asset's display name; model names must be unique.

## Exporter notes

Many FBX exporters (including Blender) write a white emissive colour with zero strength. Auvra ignores that so imported models do not glow.
