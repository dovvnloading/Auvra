# Garments

Add **Garment** to a level object to sew and simulate a garment in the editor and in play. Each new component starts with its own editable front and back panels. The existing **Cloth** component remains available for flags, sails and curtains.

To try the complete fitting scene, import [Auvra Garment Studio](examples/Auvra-Garment-Studio.auvrapack) through the project's **Import** control. Open **Fitting room**, select **Garment · sleeveless top**, and inspect its **Garment** component. **Play** uses the scene's fitting camera. **Build Web** or a supported desktop target packages the authored component with the game.

[Watch the two-second fitting sequence](examples/Auvra-Garment-Studio.mp4). The preview renders the saved garment positions and fitting form from the example.

## Fit the sleeveless top

1. Select a **Pattern panel**. The outline uses millimetres in its controls. Green edges are sewn, the selected outgoing edge is yellow, and orange points are pinned.
2. Drag a vertex in the outline or choose **Point / outgoing edge** and enter its X and Y. Release the pointer, or press Enter in a number field, to commit one undoable change. An invalid outline or a mesh over budget reports an error and preserves the last valid pattern.
3. Select a shoulder and click **Unsew edge**. Choose **Start seam**, select its opposite open edge on the other panel, and click **Sew to first edge**. Sewing connects endpoints in opposite boundary order and closes over time when fitting starts. The neck, hem and both armholes stay open.
4. Use **Split edge** to add a control point. Splitting a sewn edge also splits its partner and preserves the stitch correspondence. **Add panel** adds a rectangle that you can subdivide, reshape, place and sew. In **Panel placement**, set a translation in millimetres or rotate the panel by a signed angle around its local X, Y or normal. Rotation is about the pattern origin. **Delete point** removes its pin and seams attached to its adjacent edges. **Delete panel** removes that panel and its seams. Each action makes one undoable edit.
5. Set **Grain angle**, **Mesh edge**, fabric preset, pins and wind. The mesh cooker preserves the measured pattern and paired stitches at different resolutions. The cotton, linen and silk values are authored presets. Under **Fabric properties**, enter measured or artistic values for areal density, independent warp/weft stiffness, shear stiffness, bending, damping, contact offset and friction. Edited coefficients are stored with this garment and apply to both live simulation and bakes. **Restore preset values** clears the overrides. The **Sway fitting torso** control moves the sewing supports and collision body. **Show fitting torso** changes its visibility.
6. Use **Follow bone translation** on a rigged object to follow the displacement of a named bone from its initial pose. This fitting mode uses one upright elliptical capsule in the object's local frame. The optional **Self-collision (preview)** setting tests non-adjacent cloth features within this garment and increases CPU cost in dense folds.

## Fit to an animated avatar

Add the garment to the level object that owns the rigged model. Arrange its panels around the body in the model’s local frame. Set **Skinned collision mesh (exact name)** to the name of an outward-wound skinned proxy on that object. A lower-resolution, hidden proxy can share the avatar’s skeleton. The component samples bone and morph deformation as the actor animates. Selecting a mesh replaces the display form and its sway. Bind **Follow bone translation** to move the pins with a bone, or leave the pins at the authored positions.

Each garment accepts one proxy, up to 4,096 vertices and 8,192 triangles. Use a unique mesh name. Missing or invalid bindings suspend the garment and retry. Contacts check cloth vertices against moving avatar triangles and apply friction relative to the moving surface. Start with the garment arranged outside the avatar. Edge crossings, deep initial overlap and multiple layers can still intersect. Bone and mesh bindings use live simulation. The garment samples the current transforms when its frame callback runs. A procedural rig modifier scheduled later in the same frame is sampled on the following frame.

## Inspect deformation

The strain view colors each vertex from adjacent faces, weighted by rest area. **Warp** and **weft** show change in thread length relative to the pattern. **Shear** shows how far the angle between those directions has moved from 90°. Blue is negative, light grey is zero and red is positive. The color range saturates at ±20% extension or ±30° shear. Charcoal marks an undefined sample. Switch the view off to see the fabric color.

## Bake and ship

In a writable project, open **Fitting bake**, select a duration and click **Bake fitting clip**. The worker advances the upright fitting form in still air at the simulation's 120 Hz step and records 30 samples per second plus the initial pose. It saves the clip as a content-addressed binary asset. Garment and torso positions are sampled together. **Loop clip** restarts from the initial arrangement, which can produce a visible cut. Without looping, the final fit holds. **Use live simulation** restores wind and interactive motion.

Changing the pattern, fabric coefficients, self-contact setting or form motion invalidates the previous bake for that recipe. Restoring the same inputs can make it usable again. A missing, damaged or incompatible clip falls back to live fitting. A bone-driven garment uses live motion. The offline player uses the same garment component, saved pattern, and baked data as the editor.

The example opens in live mode and includes a two-second fitting clip. Select **Play fitting clip** to replay it.

The CPU fitting solver uses separate warp, weft and shear constraints, dihedral bending, mass from rest area, stretch-resistant sewing, friction and a bounded fixed clock. A fitting bake records that solver's output. Dense layered garments, arbitrary-mesh continuous collision, native or GPU cloth solving, and automated fitting of coefficients to physical swatches remain open work.
