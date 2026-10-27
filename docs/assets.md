# Assets

Assets live in the project's content store and are referenced by stable ids, so renaming or moving them never breaks the levels and blueprints that use them.

## Importing models

The **Content Browser** imports **FBX**, **glTF (.gltf with embedded data)**, **GLB** and **OBJ**. When you import a model, the import options ask whether to **normalise** it:

- **Normalise on** scales the model so its largest dimension equals the target size (5 units by default). Useful for assets from mixed sources.
- **Normalise off** keeps the authored scale.

Animations in FBX and glTF files are kept and can be bound to characters in the animation graph.

Animation files without a mesh, such as Mixamo downloads made "Without Skin", go onto a character: select the character in the library, then choose **Import > Animation** and pick one or more files. A file with one clip names the clip after the file, so `Walk.fbx` gives a clip called `Walk`. Clips made for a skeleton with the same bone names (Mixamo characters share one) play as they are. Others are retargeted when most of their animated bones match the character's.

## Reimport

Choose **Reimport** on a model to replace its source file. The model keeps its id, so everything placed in levels and linked in blueprints updates to the new file.

## Material overrides

Change how a model's materials look without editing its source file:

1. Open the **Scene** tab and select the model.
2. In the **Properties** sidebar, open **Material Overrides**.
3. Click a material to expand it and change **Color**, **Roughness**, **Metalness**, **Emissive**, **Glow** (emissive strength), **Opacity**, **Base map** or **Normal map**. Maps are picked from the project's textures. Edits show on the model straight away.
4. Click **Save**. **Revert** discards unsaved edits; the reset button next to a field returns it to the imported value.

Overrides are stored with the model, so every placed copy and every build uses them. They are matched by material name and survive **Reimport**; an override whose material no longer exists is flagged so you can remove it. Unnamed materials cannot be overridden, and Animation models have no overrides. Closing the section discards unsaved edits.

## Textures and audio

Images and audio files are imported from the Content Browser in the same way. Textures are used by material overrides, terrain layers and masks. Audio is used by audio emitters, Audio Source components, the **Play Sound** blueprint node and weapon sounds.

## Folders

Use folders to organise assets: create a folder, then **Move** assets into it. **Rename** changes an asset's display name; model names must be unique.

## Exporter notes

Many FBX exporters (including Blender) write a white emissive colour with zero strength. Auvra ignores that so imported models do not glow.
