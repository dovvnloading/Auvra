# Garments

Add **Garment** to a level object to sew and simulate a garment in the editor and in play. Each new component starts with its own editable front and back panels. The existing **Cloth** component remains available for flags, sails and curtains.

To try the complete fitting scene, import [Auvra Garment Studio](examples/Auvra-Garment-Studio.auvrapack) through the project's **Import** control. Open **Fitting room**, select **Garment · sleeveless top**, and inspect its **Garment** component. **Play** uses the scene's fitting camera. **Build Web** or a supported desktop target packages the authored component with the game.

## Fit the sleeveless top

1. Select a **Pattern panel**. The outline uses millimetres in its controls. Green edges are sewn, the selected outgoing edge is yellow, and orange points are pinned.
2. Drag a vertex in the outline or choose **Point / outgoing edge** and enter its X and Y. Release the pointer, or press Enter in a number field, to commit one undoable change. An invalid outline or a mesh over budget reports an error and preserves the last valid pattern.
3. Select a shoulder and click **Unsew edge**. Choose **Start seam**, select its opposite open edge on the other panel, and click **Sew to first edge**. Sewing connects endpoints in opposite boundary order and closes over time when fitting starts. The neck, hem and both armholes stay open.
4. Use **Split edge** to add a control point. Splitting a sewn edge also splits its partner and preserves the stitch correspondence. **Add panel** adds a rectangle that you can subdivide, reshape, place and sew. **Panel placement** translates a panel in three dimensions.
5. Set **Grain angle**, **Mesh edge**, fabric preset, pins and wind. The mesh cooker preserves the measured pattern and paired stitches at different resolutions. The cotton, linen and silk values are authored presets. The **Sway fitting torso** control moves the sewing supports and collision body. **Show fitting torso** changes its visibility.
6. Use **Follow bone translation** on a rigged object to follow the displacement of a named bone from its initial pose. This fitting mode uses one upright elliptical capsule in the object's local frame. The optional **Self-collision (preview)** setting tests non-adjacent cloth features within this garment and increases CPU cost in dense folds.

## Inspect deformation

The strain view colors each vertex from adjacent faces, weighted by rest area. **Warp** and **weft** show change in thread length relative to the pattern. **Shear** shows how far the angle between those directions has moved from 90°. Blue is negative, light grey is zero and red is positive. The color range saturates at ±20% extension or ±30° shear. Charcoal marks an undefined sample. Switch the view off to see the fabric color.

## Bake and ship

In a writable project, open **Fitting bake**, select a duration and click **Bake fitting clip**. The worker advances the upright fitting form in still air at the simulation's 120 Hz step and records 30 samples per second plus the initial pose. It saves the clip as a content-addressed binary asset. Garment and torso positions are sampled together. **Loop clip** restarts from the initial arrangement, which can produce a visible cut. Without looping, the final fit holds. **Use live simulation** restores wind and interactive motion.

Changing the pattern, fabric preset, self-contact setting or form motion invalidates the previous bake for that recipe. Restoring the same inputs can make it usable again. A missing, damaged or incompatible clip falls back to live fitting. A bone-driven garment uses live motion. The offline player uses the same garment component, saved pattern, and baked data as the editor.

The example opens in live mode and includes a two-second fitting clip. Select **Play fitting clip** to replay it.

The CPU fitting solver uses separate warp, weft and shear constraints, dihedral bending, mass from rest area, stretch-resistant sewing, friction and a bounded fixed clock. A fitting bake records that solver's output. Large layered wardrobes, full skinned-body contact, GPU simulation and measured fabric calibration require separate qualification.
