# Material and Texture Authoring Roadmap — Auvra

> **Scope:** everything an artist uses to make a surface look right:
> - the texture graph;
> - painting and layers;
> - mesh-map baking and UVs;
> - the material (shader) graph and the engine's shading model;
> - the texture pipeline;
> - photo and AI tools;
> - the editor screens around them.
>
> **Date:** 2026-11-06. **Revision:** `b6b164e` (main).
>
> **Method:** four sources fed this map.
> 1. A read of the code: `texturing/`, `components/Texturing/`, `components/Materials/`, `runtime/materials/`, `renderer/`, and the unmerged WebGPU renderer on `claude/gpu-core-land`.
> 2. A survey of the leading dedicated tools for node-based texture authoring, 3D painting and material capture, current to their autumn 2026 versions.
> 3. A survey of material authoring in leading engines and of the open standards (OpenPBR, MaterialX, glTF, USD).
> 4. Research and products from 2023 to 2026.
>
> It builds on the 2026-11-04 review of the texture graph, whose bugs were fixed in #162.
>
> **Ground rules:** clean-room work from public knowledge only. No other product's code, shaders, presets, sample graphs or assets are copied or decompiled, and no closed file format is reverse engineered. Open specifications and openly licensed reference code (for example the OpenPBR reference implementation) may be used under their licences. Features are described in Auvra's own terms.
>
> **"The best tools"** below means the leading dedicated node-based texture tool, the leading 3D painting tool and the leading capture tool, plus the material systems of leading engines.
>
> **The bar moves.** Re-check the best tools' latest versions before starting each stage, and update this document as stages land.

## 0. In short

**What Auvra has.**
- **Texture graph:** a GPU texture graph with 78 node types. Graphs can be used inside other graphs, and controls can be exposed and driven by formulas. Each node's result is cached.
- **Paint tab:**
  - layered painting on real models, with masks and smart materials built as graphs;
  - an 8-map GPU baker;
  - automatic UV unwrapping and nested packing, with UDIM sets.
- **Shader graph:** a separate shader graph with 90 nodes.
- **AI tools:** generate a material from a description, and retexture a model.

**Where the gap is largest.**
1. **The engine's shading model.** Authored materials have only base colour, metalness, roughness, normal, AO and emission. The best tools now default to a layered physical surface (OpenPBR): coat, sheen, transmission, subsurface, anisotropy and thin film. Without it, glass, car paint, fabric, skin and lacquered wood cannot be made.
2. **One material, not five places.** Five places change how a surface looks:
   - the Materials tab;
   - Material Overrides;
   - Retexture;
   - Paint;
   - the texture graph.

   They work through two graph editors in two visual styles. A material is either a texture graph or a shader graph, never both, and everything reaches the game as baked 8-bit pictures.
3. **Library breadth.** 78 node types against roughly 440 in the leading tool. Whole families are missing: shape scatter, splines and paths, text and vector shapes, SDF shapes, photo processing, mesh-based weathering, and nodes that work on whole materials.
4. **Authoring depth.**
   - No presets, no show/hide conditions on controls, and no wire that carries a whole material.
   - No node-based function graphs, no value reading, and no recursive pattern placement.
   - No tiling modes, non-square sizes or physical size in the editor.
5. **Painting depth.**
   - The brush paints flat values only: no painting with a material or a texture.
   - No layer types that reference or filter the layers below.
   - No extended channels; no clone, smudge, path or text tools; no cage baking.
6. **Professional editing.** The canvas lacks the tools that keep big graphs readable. Neither 2D view has on-screen handles or a histogram, and the 3D previews don't use the engine's own material path. The Materials tab doesn't use the editor's shared controls.
7. **The pipeline.**
   - Images import at 8 bits only.
   - Textures used by material graphs are never compressed.
   - There are no texture import settings, no streaming, no budget view and no export to glTF, MaterialX or USD.

**Where Auvra can lead.**
- Materials that stay procedural in the running game.
- Generative material nodes inside the graph. The leading capture tool has removed its generative features.
- An assistant that builds graphs you can edit.
- Graphs that loop.
- Function graphs where every intermediate value can be seen.
- Filters that run across UV seams.
- Any setting can be exposed, including the gradients, curves and fonts the leading tool cannot expose.
- Painting at 8K inside the app. The leading painting tool stops at 4K, and its makers have said 8K in the view is not planned.
- Web-first output: glTF with its material extensions plus KTX2. The leading painting tool has no glTF template.
- A path-traced reference beside the live view.

**Where the work stands:**
- **Round 1** fixed most of §8's defects.
- **Round 2** brought both graphs onto one canvas, the physical surface model in WebGL2, and painting with whole materials.
- **Round 3** brought:
  - wires that carry a whole material;
  - the 2D and 3D views and widgets;
  - material instances, parallax and material decals;
  - part masks, the brush engine and paths.
- **Round 4** brought:
  - the scatter pass, inheritance and tiling modes, and flood fill on the GPU;
  - baking at full depth, and UV relax, straighten and texel density;
  - deep texture import, GPU compression for material textures, and views of what textures cost.
- **Round 5** brought:
  - function graphs, the value processor and the Iterate node;
  - strip-baked supersampling, fixing bakes in place, painting in 2D, brush projections and more UV tools;
  - one material document with painted copies, delete with undo, and compressed textures kept in the project.
- **Round 6** brought:
  - parameters and presets at full depth, a variation sheet, safe transform and a deep Bitmap node;
  - export templates, more file kinds and glTF export;
  - a material library for every project, phone compression and MaterialX.
- **Round 7** brought:
  - six families of new nodes (91 nodes), weathering from mesh maps among them;
  - a history panel, particle brushes, wrapped decals and whole-model glTF export;
  - material features drawing on WebGPU as on WebGL2, and balls in the material list.
- **Round 8** brought:
  - the node library's last five families, a make-it-tile without ghosting, fur and an HDR range view;
  - games that cook texture graphs on their own GPU, with per-object seeds and values;
  - paint stacks as graph nodes, graphs as brushes, filters across UV seams, and Retexture results as layers.
- **Round 9** brought:
  - photo to material, a branching history with comparison, and graph brushes in colour;
  - animated materials, growing a texture from an example, and a WGSL writer for function graphs;
  - a material command line and script calls, compression-aware authoring, and kept terrain arrays.

See §6.

## 1. What "rival, then lead" means

Auvra's material tools rival the best tools when all of these hold:

1. **Any surface, same quality.** An artist can build any material they would build in the leading node-based tool: bricks, tiles, rock, bark, fabric, metal panels, scanned ground. It holds the same detail and range, with 16-bit and float precision where it matters, and 4K and 8K output without banding or seams.
2. **Same or less effort.** The node library is broad enough that common looks take a handful of nodes rather than a hand-built chain. Scatter, whole-material blending, weathering and the height and normal tools are single nodes.
3. **Reusable work.** Graphs become nodes with clean exposed controls, presets and conditions. A studio can build a library of its own materials and reuse it across projects.
4. **Painting on real models.** Layers, masks, smart materials and generators, and brushes with full dynamics. Baking from high-poly models with cages. UV tools that hold up on messy imported meshes as well as clean ones.
5. **What you see is what the game draws.** The previews, the editor's level view and built games share one shading model. That model covers the lobes artists expect: coat, sheen, transmission, subsurface, anisotropy and thin film.
6. **A professional tool to use.** The screens feel like a professional tool, not a web form. §5 sets out the standard.

Auvra goes past those tools where being inside the engine helps:
- materials that stay procedural in the game;
- filters that run across UV seams;
- graphs that loop;
- an assistant that builds editable graphs, never pasted bitmaps;
- one GPU shared by the editor and the game.

## 2. Where Auvra stands

### 2.1 Texture graph (Materials tab → New → Texture graph)
- **Nodes:** 78 built-in node types. Any project graph can also be used as a node, nested up to 8 deep and kept warm between runs.
- **Wires and precision:** colour and grey wires; 8-bit, half-float or full-float precision per node.
- **Sizes:** powers of two from 16 to 8192. The editor offers square sizes from 256 to 4096 while editing, and up to 8192 for output.
- **Seeds and settings:** graph and node seeds give identical results on every GPU. Settings can follow exposed parameters or formulas.
- **Evaluation:** WebGL2 on the GPU. Each node's result is kept with a signature of everything it came from, runs cancel between nodes, and heavy passes are split across frames.
- **Outputs:** base colour, normal, roughness, metallic, height, AO, emissive and opacity.
  - **Update material** draws PNGs and rewrites the material's shader graph to use them.
  - **Download pictures** gives a ZIP with 16-bit height and normal.
- **Editor:**
  - a live thumbnail on every node, wires coloured by kind, and a node list with search;
  - dropping a wire on empty space opens the list filtered to nodes that fit;
  - comments, copy and paste, and 200 steps of undo;
  - a 2D view with channels, a 3×3 tiling check and zoom;
  - a 3D view of shapes or a project model, with a studio light and displacement on the shapes.

### 2.2 Painting, baking and UVs (Paint tab)
- **Texture sets:** each model's materials are grouped into sets by shared pictures.
- **Layers:** paint, fill and folder layers, each channel with its own blend mode (21) and opacity.
  - Masks are stacks of effects: paint, fill, smart mask, levels, blur and invert.
  - A fill can come from a value, a picture (along the UVs or from three sides), a texture graph drawn with the model's baked maps, or what the surface wore before.
- **Channels:** base colour, roughness, metallic, height, normal, emissive and opacity.
- **Brushes:** size, hardness, flow, spacing, angle, pen pressure, jitter and turning with the stroke. They project from the screen or as a disc on the surface, with X/Y/Z mirroring, an island fill and a screen stencil. They paint one flat value per channel.
- **Ready-made:** 6 smart masks, 2 fill graphs and 5 smart materials, all built as texture graphs.
- **Baking:** a GPU bake of AO, curvature, tangent and world normals, position, thickness, ID and height, from the surface itself or from a high-poly model in the scene.
- **UVs:**
  - automatic seams, plus seam editing by hand;
  - conformal flattening, cut again until every piece lies flat;
  - an outline-nesting packer across 1 to 8 UDIM tiles;
  - pictures are carried over to a new layout.
- **Output:**
  - **Put on the model:** 8-bit packed pictures, with UDIM sets as one atlas per channel.
  - **Download pictures:** per tile, per channel or packed.

### 2.3 Material graph and the engine's materials
- **Shader graph:** 90 nodes covering math, vectors, UVs, texture sampling, triplanar, simple noises, colour, logic and custom GLSL, plus comments and reroutes.
  - Named parameters are shared across nodes, with values set per model in Material Overrides.
  - The graph is compiled to GLSL and patched into the standard three.js material. The WebGPU renderer (in main since #154) translates the same GLSL to WGSL.
- **Authored materials:** base colour, metalness, roughness, normal, AO, emission, opacity (4 blend modes) and world-position offset.
- **Imported glTF models:** keep coat, sheen, transmission, volume, anisotropy, iridescence and dispersion through three.js, but nothing in the editor can see or change them.
- **Separate systems:** terrain (8 layers with height blending and cliff projection), colour-only decals, water, and weather and wind patches.

### 2.4 Texture pipeline
- **Import:** images come in through the browser's decoder, so at 8 bits.
- **Compression:**
  - Model textures are compressed to BC1, BC3 or BC5 in workers on desktop GPUs.
  - Textures used by material graphs are never compressed.
- **Missing:** streaming, per-texture import settings and a budget view.

*Since round 4:* 16-bit PNG, TIFF, OpenEXR, Radiance HDR, TGA and PSD import at their own depth, each texture keeps its own settings, material textures compress to BC7, BC5 or BC4, and a memory view shows what they cost. See Stage 8.

### 2.5 AI tools
- **Describe:** makes a tileable material with colour, normal, roughness and metalness maps.
- **Retexture:** restyles a model through a six-view sheet, makes a new texture, or retextures a whole model.
- **Make matching maps:** builds the other maps for a picture.

Results become textures and overrides, never material assets.

## 3. The gap map

Gap sizes: **Small** (polish), **Medium** (real work on an existing base), **Large** (most of the capability is missing), **Missing** (nothing there).

### 3.A Graph engine
| Capability | Auvra now | The bar | Gap |
|---|---|---|---|
| Precision | 8-bit, half and full float per node | the same, plus 16-bit integer | Small |
| Size and inheritance | Powers of two; a node follows its input or the graph, or has a fixed size. The editor only offers square sizes | Size, bit depth, tiling, seed and pixel ratio are each taken from the input or the parent, or fixed. Relative sizes span ±12 doublings. Non-square sizes are offered in the editor, and the graph has a physical size | Medium |
| Tiling | Most nodes tile by construction, but rotation and fractional scale break it. There are no tiling modes | Tiling modes per graph and per node (none, horizontal, vertical, both), and a non-tiling option on noises | Medium |
| Variation | Graph and node seeds; copies of one sub-graph all look the same | Seeds are inherited and vary per copy, and chosen parameters can be varied together | Small |
| Speed | GPU, cached and cancellable. But flood fill runs on the CPU, every node is redrawn after each edit for thumbnails, and output re-renders the whole graph | Everything on the GPU, the cost of each node shown on the canvas, a quick low-resolution draw first, then the full one | Medium |
| Loops | None | Per-pixel loops in function graphs and recursive pattern placement. No image-level loops anywhere | Missing |
| Runs in the game | Baked pictures only | Published procedural materials with live parameters inside engines | Missing |

### 3.B Node library
| Family | Auvra now | The bar | Gap |
|---|---|---|---|
| Size of the library | 78 | 28 basic + about 410 library nodes | Large |
| Basic image operations | Blend (21 modes), levels, curves, HSL, gradient map, channel tools, transforms, warps, blurs, distance, normal, emboss, sharpen. Levels are not per channel | Similar | Small |
| Noises and grunges | Perlin; fractal (3 bases × 4 styles); cells; white; streaks; 3D noise | About 90: clouds, dirt, spots, crystal, fibres, fur, moisture, liquid, plasma, caustics, blue noise, simplex, anisotropic and directional noises, directional scratches, 15+ grunge maps; non-tiling and "disorder" options | Large |
| Patterns and scatter | 12 shapes; linear gradient; checker; tiles and bricks; hexagons; weave; scratches; a grid tile sampler with one output and no rotation or ID maps | A tile generator, plus a tile sampler with 6 pattern inputs whose scale, rotation, offset, mask, colour and pattern choice can each follow a map. Shape scatter with Poisson, density or custom placement, 3D and SDF shapes, height-aware stacking, and per-copy ID and UV outputs. Atlas scatter; arc pavement; triangle grid; stripes; starburst; a weave generator; radial, axial and circular gradients | Large |
| Adjustments and colour | Levels; curves; auto levels; brightness and contrast; invert; threshold; histogram scan and range; posterize; clamp; to grey; HSL; colour to mask; replace colour | Also histogram select, shift, equalize and compute; channel mixer; colour match; colour lookup tables; palettes; quantize colour; ID to mask; lighting removal; HDR range view | Medium |
| Blurs, warps, transforms | Gaussian, directional, by mask, slope, high pass; warp, fixed-angle directional warp, vector warp; transform, repeat, mirror, polar, swirl; make it tile (one cross-fade) | Also anisotropic, non-uniform, radial and median blurs, and edge-preserving smoothing. Multi-directional and map-driven directional warps; vector morph. Safe transform (keeps tiling), skew, symmetry, trapezoid and quad transforms, non-uniform rotation, auto crop, clone, noise upscale | Medium |
| Geometry effects and normals | Distance, bevel, grow and shrink, edge detect; normal from height, normal combine, normal adjust; curvature (from normal); horizon-based AO; height from normal | Also smooth bevel, directional distance, smooth curvature, ray-traced AO and shadows, glow, shape outline/glow/shadow, reaction-diffusion, diffusion. Normals in world units, normal uncombine, normal vector rotation, normal transform, bent normals, high-quality normal to height | Medium |
| Flood fill | Fill plus 5 followers. Runs on the CPU, and per-island random values repeat after about 2,000 | On the GPU. Follows to random grey or colour, gradient, size, bounding box, index and position. The mapper allows free rotation, scale and flips | Medium |
| Whole-material nodes | None: every channel is wired by hand | One wire carries a whole material, with material blend, height blend, multi-blend, switch, transform and adjust nodes, plus snow cover, water level and seasons | Missing |
| Mesh-based weathering | 6 smart masks, in Paint only. In Materials, mesh-map nodes show stand-ins | About 36:<br>• Wear: edge wear, damage, notches and dirt; cloth, leather and metal wear.<br>• Stains: dust, grease, leaks, dripping rust, sun bleach.<br>• Tools: a mask builder.<br>• Weathering sets: cracks, fabric, leather, metal, moss, rock, rust. | Large |
| Splines and paths | None | About 36 nodes edited in the 2D view:<br>• Building: point lists, curves, bridges between curves.<br>• Drawing: render, fill, mapping a texture along a curve, scatter along curves.<br>• Paths: mask to paths, path tools. | Missing |
| Text and vector shapes | None | Text in any font; vector images | Missing |
| SDF shapes | None | 3D SDF primitives, booleans, bends, twists and repeats, with materials and IDs, plus a 3D viewer node | Missing |
| Photo and scan processing | Bitmap input only (8-bit, stretched to the graph) | Make photos tile, smart auto tile, clone patch, colour equalizer, multi-angle capture to albedo and normal, atlas splitter, AO cancellation | Missing |
| Programmable nodes | A GLSL pixel processor whose settings are named x/y/z/w | Node-based function graphs with loops, a value processor and recursive pattern placement. Users of the leading tool ask for code nodes | Medium |
| PBR checks | None | Albedo-safe colour, PBR range validation, measured F0 references | Missing |

### 3.C Graph authoring
| Capability | Auvra now | The bar | Gap |
|---|---|---|---|
| Sub-graphs | Any project graph as a node, kept warm | The same, plus editing in place | Small |
| Exposed parameters | Number, whole number, switch, colour, pair and choice; ranges; formulas. Choice options can't be edited, and the stored group, step and description fields have no UI | Groups, descriptions, steps, and soft and hard ranges. Show/hide conditions on parameters, inputs and outputs. Values driven by function graphs | Medium |
| What can be exposed | Not ramps, curves, pictures or text | The leading tool cannot expose gradients, curves, fonts or levels either | Lead available |
| Presets | None | Named presets, embedded or in shared files | Missing |
| Libraries and packages | A "for other graphs" flag, per project | Packages with dependencies, watched folders and cross-project libraries; a library of over 20,000 ready assets | Large |
| Templates and samples | Two starters | A template gallery with pictures, and annotated sample graphs | Large |

### 3.D Outputs and interchange
| Capability | Auvra now | The bar | Gap |
|---|---|---|---|
| Channels | 8, plus "Other" | A full physical surface (OpenPBR is now the default in the best tools): coat, fuzz, thin film, transmission, subsurface, anisotropy, specular colour, IOR, diffuse roughness | Large |
| Export | PNG at 8 or 16 bits; packed ORM or one picture per channel; ZIP | PNG, TGA, TIFF, EXR and PSD at a chosen bit depth; batches of sizes; saved export settings; packing per target engine; UDIM batches | Large |
| Published procedural material | None | A package keeping exposed parameters, presets and image inputs live in other apps and engines | Missing |
| glTF, MaterialX, USD | glTF import only | MaterialX and USD in the best tools; glTF with its material extensions for the web | Missing |

### 3.E Painting and layers
| Capability | Auvra now | The bar | Gap |
|---|---|---|---|
| Layer types | Paint, fill, folder | Also:<br>• layers and folders shared across texture sets (instances);<br>• anchor points that let later effects read painted detail;<br>• generator, filter, levels and compare effects on a layer's content or its mask;<br>• flattening layers.<br>The leading painting tool documents 62 filters, including metal finishes (brushed, hammered, galvanised), wear effects and stylisation | Large |
| What a brush paints | One flat value per channel | Whole materials and smart materials in every channel at once; film tools paint up to eight channel streams together | Missing |
| Masks | Stacks of paint, fill, smart mask, levels, blur and invert. ID masks exist only as a texture-graph node, and the stack can't be reordered | Generators, smart masks, ID-colour selection, geometry masks, polygon fills (by triangle, quad, mesh, UV piece and edge loop), saved smart masks, masks set up by rules across many assets | Medium |
| Channels | Base colour, roughness, metallic, height, normal, emissive, opacity | Any number of channels, each with its own format (8-bit to 32-bit float). Coat with its own normal, sheen, anisotropy, specular edge colour, scattering, translucency, dispersion, absorption, displacement in physical units, and user channels. OpenPBR is the default | Large |
| Brush engine | Size, flow, spacing, angle, pressure (size and flow), 4 jitters, follow the stroke; screen or surface projection; X/Y/Z mirror | Also:<br>• brush and stroke setup: an alpha and brush library, stencils, pressure curves, lazy mouse, mirror and radial symmetry, additive strokes within a layer;<br>• paths: editable paths with size and opacity per point, filled paths, ribbons, text along a path;<br>• special brushes: strokes driven by a graph (stitches) and physics particle brushes | Large |
| Projections | Screen and surface brushes; fills along UVs or from three sides | UV, triplanar, planar, spherical and cylindrical projections; warp grids; projections wrapped onto the mesh; symmetry on fills | Medium |
| Tools | Erase, island fill, colour pick (base colour only), screen stencil (not drawn, square only) | Clone and smudge; polygon and loop fills; text, fonts and vector images; a visible, movable stencil; a colour picker for every channel | Large |
| Smart materials | 5 built in, plus project graphs as layers; can't be edited or saved | Large libraries of smart materials and masks that re-fit to each mesh's bakes, saved by the user, shown with previews, and reused across projects | Medium |
| Painting views | 3D only; the 2D view edits UVs | Painting in 2D UV space and in 3D; post effects and order-independent transparency in the view; a path-traced preview | Large |
| Resolution and scale | Up to 4096. Each brush step recombines every layer of the touched channels on every tile, and every channel is a full-size picture | The leading painting tool paints at up to 4K inside the app (8K on export), and its makers have said 8K in the view is not planned. Film tools reach 32K per UDIM tile. Only changed areas should be recombined, using sparse tiles | Large (8K in the app is a lead available) |
| Export from Paint | PNG; one picture per channel or packed ORM; OpenGL normals only | 34 templates for engines and renderers, plus:<br>• channel packing and conversions (OpenGL or DirectX normals, spec/gloss, F0);<br>• naming tokens;<br>• PNG, TGA, TIFF, EXR, PSD, JPEG and WebP at 8, 16 or 32-bit;<br>• padding modes.<br>The leading painting tool has no glTF template | Large (a web-first glTF template is a lead available) |
| History | 80 steps, no panel, lost on switching tabs | A history panel, and one history for painting and baking, kept with the document | Medium |

### 3.F Baking
| Capability | Auvra now | The bar | Gap |
|---|---|---|---|
| Maps | AO, curvature, tangent and world normals, position, thickness, ID, height | About 10 standard maps, adding bent normals and opacity. Dedicated bakers offer about 30, including colour and texture transfer from the high-poly model | Medium |
| High to low | Fixed front and back distances; the high-poly model must already be in the scene | Cages by distance, automatic or from a file; averaged normals; lists of high-poly meshes; match by mesh name; automatic grouping of meshes into bake sets; a choice of tangent space | Large |
| Quality | One sample per texel; normals 8-bit; position scaled per axis (distorts noise); bake size tied to set size | Supersampling up to 8×8 (32 samples per pixel in dedicated bakers), dilation and diffusion, 16-bit normals, non-square sizes from 32 to 8192, GPU ray tracing on every vendor, UDIM tiles | Medium |
| Fixing bakes | Bake again from scratch | Painting the skew and the cage offset, live rebake of only the changed region, a view of the bake rays, one undo history for painting and baking | Missing |

### 3.G UVs
| Capability | Auvra now | The bar | Gap |
|---|---|---|---|
| Unwrap | Automatic seams, conformal flattening, cut again until every piece lies flat, manual seams. This already goes further than the leading painting tool, which has automatic unwrapping only | Dedicated UV editors add angle-based flattening, relax, straighten and pins. Painting tools add automatic unwrapping tuned for hard-surface models | Medium |
| Pack | Boxes plus outline nesting; UDIM; padding | Per-island density and locking, stacking of overlapping and mirrored islands, grouping | Small |
| Island editing | Move, turn 90° and scale, with no undo; runs on the main thread and freezes the editor | Full transforms, align, stitch, mirror, select in 3D, undo, and work done off the main thread | Medium |
| Texel density | One density everywhere, shown but not settable | Set it, match it across sets, and show it as a heat map | Medium |

### 3.H The engine's materials
| Capability | Auvra now | The bar | Gap |
|---|---|---|---|
| Surface model | Authored materials have metal/rough only. The extra lobes exist only on imported glTF, through three.js, with no UI | A layered physical surface: coat with its own normal, fuzz, thin film, transmission with volume and dispersion, subsurface, anisotropy, specular colour, diffuse roughness, emission. Whole surfaces can be layered and blended | Large |
| Shader graph | 90 nodes; float to vec4 only; no sub-graphs; textures are settings, not wire values; patches three.js shader text | Sub-graphs and functions, textures as values, typed expressions, a cost heat map, previews on the mesh, channel isolation, a view of intermediate values | Large |
| Instances | Values per model only | Instances with promoted parameters and per-placed-object values that scripts can change, plus switch and texture parameters, with a visible count of shader variants | Missing |
| Layered materials | None (terrain has its own) | Layer stacks compiled into one shader, with height-based blending | Missing |
| Height in the engine | Not used: painted and graph height is baked but never read | Parallax occlusion with self-shadowing, displacement and tessellation | Missing |
| Triplanar, detail, anti-tiling | Triplanar for colour and data only (not normals); detail maps built by hand; anti-tiling on terrain only | Triplanar and biplanar mapping for normals too; hex-tiling and histogram-preserving blending as nodes that wrap any input | Medium |
| Decals | Colour, tint and opacity | Decals carrying normal, roughness, metalness and emission | Large |
| Special surfaces | Water, terrain, weather, wind, alpha cards | Also skin, hair, eyes, cloth, glass, and car paint (coat plus flakes) | Large |
| Features working together | Binding a graph drops weather and wind; the compressed-normal hook may drop them on every imported model | Every feature works with every other | Defect (§8) |

### 3.I Texture pipeline
| Capability | Auvra now | The bar | Gap |
|---|---|---|---|
| Import | Browser formats at 8 bits; TGA and TIFF only inside FBX | 16-bit PNG and TIFF, EXR, HDR, TGA, PSD, KTX2 | Large |
| Import settings | None | Per texture: colour space, normal-map flag, compression, size limit, wrap and filter, mips | Missing |
| GPU compression | BC1/BC3/BC5 for model textures on desktop; nothing for material textures or phones | BC7, BC5 and BC6H on desktop; ASTC and ETC2 on phones; KTX2/Basis for downloads. GPU encoders now run in the browser | Large |
| Mips | 2×2 box filter | Better filters, normal-aware mips, roughness widened from normal variance | Medium |
| Streaming | Whole assets per level | Mip streaming; virtual texturing for large terrains and sets | Missing |
| Budgets | Not shown (a compression report is computed and never displayed) | Memory per material and per level, with warnings | Missing |

### 3.J Capture and AI
| Capability | Auvra now | The bar | Gap |
|---|---|---|---|
| Text to tileable material | Describe: colour, normal, roughness, metalness | The leading capture tool has removed its generative features. Cloud models now give five maps including height, with control of tiling direction and output up to 8K | Lead available |
| Photo to material | None | AI photo-to-material, AI lighting removal, make-it-tile and automatic tiling, atlas creation from photos, multi-angle capture to material, 2× and 4× AI upscaling on every channel, and pulling one material out of a photo by label. One open-source painter runs image-to-PBR, upscaling and text-to-image models locally as nodes | Large |
| Texturing a whole mesh | Retexture through cloud models; results are overrides | The same, as non-destructive layers you can paint and mask over | Medium |
| AI-built graphs | None | No product does this well. Research (2025–2026) shows language models writing editable material graphs | Lead available |

### 3.K Automation
| Capability | Auvra now | The bar | Gap |
|---|---|---|---|
| Scripting and batch work | None for materials | A scripting API for graphs, nodes, parameters and presets; command-line cook, render and bake; plugins | Missing |

## 4. Going past the best tools

Ranked by value and by fit with an engine-native, GPU, web-based tool.

1. **Materials that stay procedural in the game.** The player runs texture graphs itself instead of loading 4K pictures.
   - Seed, wear, wetness, snow and damage can vary per object or follow gameplay.
   - Resolution follows level of detail, and results are cached by signature.
   - Graphs share the game's GPU and each object's mesh maps.
   - Downloads shrink to graphs plus small inputs.
   - Published procedural materials in other engines run on the CPU.
2. **Generative nodes in the graph.** Text, a photo, or a photo plus a label become a tileable material, as non-destructive nodes with seeds, masks, tiling direction and caching. AI tiling and upscaling are nodes too. The cloud models are on the account the engine already uses, and the leading capture tool has dropped its own.
3. **An assistant that builds and edits graphs.** It proposes graphs and edits as checked changes that can be rolled back, suggests the next node, and explains a graph. The result is always a graph you can edit, never a pasted bitmap. The graph format is plain JSON, normalised on load, and nodes carry descriptions and keywords.
4. **Photo to editable graph.** The assistant drafts a graph, then the exposed parameters are fitted to the photo, on the Python host first.
5. **Image-level loops.** An Iterate node runs a sub-graph on its own output N times, showing each step. That gives erosion, reaction-diffusion, crack growth and cellular automata. The leading tool's loops work only per pixel.
6. **Seeing inside function graphs.** Every intermediate value can be previewed. This is the leading tool's most cited complaint.
7. **Filters that cross UV seams on models.** Blur, slope blur, distance and streaks work over the surface, using mesh adjacency, so leaks and wear run across seams.
8. **Anything exposable.** Gradients, curves, pictures, text and fonts can all be exposed as parameters.
9. **History you can explore.**
   - a saved, branching history;
   - an A/B wipe between any two states;
   - variation sheets of seeds and parameter sweeps;
   - controlled variations of chosen parameters.
10. **Speed you can see.** A live cost heat map with hints, and a quick low-resolution draw then a sharp one. Changed areas are redrawn alone, and values near a hovered slider can be drawn ahead.
11. **A path-traced reference** beside the live view, using a WebGPU path tracer.
12. **Compression-aware authoring.** Each output previews BC1, BC5, BC7 and ASTC artefacts and memory use. Results are compressed on the GPU in the browser.
13. **Painting at 8K inside the app.** Only changed areas are recombined, using sparse tiles. The leading painting tool stops at 4K inside the app.
14. **Web-first output.** A glTF template that writes the material extensions, packed and KTX2-compressed pictures, and a preview that matches what a glTF viewer shows. The leading painting tool has no glTF template.
15. **Painting and graphs in one document.**
    - A layer stack becomes a node in a graph.
    - A graph becomes a brush.
    - Strokes survive changes to the mesh and UVs.
16. **Anti-tiling and mapping as wrapper nodes.** Hex-tiling, histogram-preserving blending and biplanar mapping wrap any input, in both the texture and the shader graph.
17. **Animated materials.** A time input in texture graphs, and flipbook and sheet export. The leading tool has no animation.
18. **Texture growth from examples.** Histogram-preserving synthesis, guided patches, and exact tiling of photos.
19. **WebGPU compute.** Atomics for histograms and scatter, FFTs for spectral noise and large blurs, island labelling on the GPU.
20. **Neural texture compression.** It needs WebGPU access to matrix hardware, so it comes later.

## 5. The UI and UX standard

Every screen in this area is judged on the real editor at an ordinary window size, as a person using it, not by whether its functions run. The standard:

- **Shared controls and one look.** Use the editor's shared fields, menus, colour picker and sliders. Keep one accent colour, with the main action always in view. No native dropdowns, raw catalogs, model ids or internal status words on screen.
- **Plain words.** Every label, tooltip and message is written for an artist. Node and setting names say what they do.
- **Instant feedback.** A setting change shows on the node, in the 2D and 3D views and on the model, with no visible stall at working sizes. Slow nodes say so, and their cost shows on the canvas.
- **Find anything fast.** One node finder, opened from the keyboard or by dragging from a pin, that:
  - matches loosely;
  - shows a picture of what each node makes;
  - keeps favourites and recent nodes;
  - connects the new node as it lands, including onto an existing wire.
- **Direct manipulation.** Positions, angles, gradients, curves, scatter areas and spline points are dragged in the 2D view or on the model, not typed as numbers. Colours can be picked from any image or from the model.
- **The canvas carries big graphs.** Hundreds of nodes pan and zoom smoothly, with:
  - frames and reroute points;
  - named links that jump across the graph;
  - align and distribute;
  - bypass and collapsed nodes;
  - find in graph and a minimap;
  - opening a sub-graph in place, with a path back out.
- **Safe to explore.** Undo everything, and keep undo when switching tabs. Keep a branching history with before-and-after comparison, and a variation sheet. Nothing destructive without a way back.
- **Help in place.** Each node has a description and an example picture. Starter templates come with pictures, and annotated sample graphs show how good materials are made.
- **Room to work.** Panels resize, collapse and remember their layout. The 2D and 3D views can fill the screen, and nothing important sits below the fold.

**Gaps against this standard today:**
| Area | What is missing |
|---|---|
| Canvas (both graphs) | Minimap, named links, align and distribute, snapping, find in graph, bypass, renaming, colouring and collapsing nodes, a node menu, dragging textures onto the canvas, editing sub-graphs in place. Comments can't be titled or coloured in the texture graph. There are two separate canvases, node lists and editing modules. |
| Node finder | No pictures, favourites, recent nodes or dropping onto a wire. It can open partly off the canvas. |
| Widgets | Angles and positions are plain numbers. There are no handles in any 2D view. Sliders in Paint are read-only. The texture picker has no thumbnails. Code fields have no highlighting or inline errors. The curve editor has no histogram behind it. |
| 2D views | No pixel values (the help text promises them), histogram, colour pins, compare wipe, exposure or lit normal view. |
| 3D views | Not the engine's material path. One studio environment, with no HDRI choice. No shadows in Paint. Displacement on shapes only. No anti-aliasing in Paint. |
| Look | The Materials tab and Material Overrides use raw greys, native selects and fixed widths, while Retexture and Paint use the shared kit, so there are two visual languages. Panels in Paint can't be resized. |
| Wording | "x/y/z/w/tint", "$size", raw driver logs, internal node ids, "16-bit" meaning half float, "Other", "N shader statements", "Swizzle", "Lerp", "Saturate", and Color and Colour mixed. The empty Materials list points to the wrong place for assigning materials. |
| Undo | Lost on switching material or tab, in both graph editors and in Paint. Parameter edits are not recorded. UV edits have no undo. |
| Library | A plain list of names: no thumbnails, search, folders, tags, duplicate, where-used or safe delete. |
| Help | Two starter graphs; no shortcut sheet; the formula function list is never shown. |

## 6. Order of work

Each stage adds something an artist can use, and each is checked in the running editor (§7). Later stages build on earlier ones. Where a stage can run alongside another, it says so.

### Stage 0 — Fix what is broken
Fix the defects in §8 that lose work, give wrong results or mislead, before building on them. The key ones:
- the "one picture per channel" output dropping roughness, metallic and AO;
- weather and wind lost on graph-shaded and compressed-normal materials;
- 8-bit normals in baking and painting;
- the position map scaled per axis;
- Vector 2 parameters not saving;
- non-materials offered as materials;
- mesh-map nodes showing stand-ins in Materials;
- the likely triangle-edge marks in soft strokes;
- deleted layers' pictures left on the GPU;
- "Pack the current islands" re-unwrapping instead of packing;
- unknown node types dropped silently;
- copies of one sub-graph looking identical;
- kernels stepping by the wrong pixel size;
- undo lost on switching tabs.

**Checked by:** each fix shown in the editor on the Khronos helmets and a Poly Haven model, before and after.

### Stage 1 — Professional graph editing

**Landed in round 2:** both graphs on one canvas, with frames, reroute points, align, snap, bypass, folding, rename and colour, menus, find, an overview map, sub-graphs opened in place, pin groups, and a node finder with pictures, favourites and recent nodes. Undo works anywhere in the workspace. Still to come: the 2D and 3D views, widgets, a cost heat map, named links, and shader errors marked on their node.

**Landed in round 3:**
- **2D view:** a histogram with range selection, colour pins, an A/B wipe, exposure, a lit normal view, and drag handles for transforms, the tile sampler, gradients and shapes.
- **3D view:** it draws through the engine's material path, with lighting choices, shadows, channel views, and wireframe and UV views.
- **Widgets:** an angle dial, a position pad, eyedroppers from the views, a gradient eyedropper along a line, curves over a histogram, and code fields that mark errors.
- **Canvas:** a cost map, named links, tidy layout, and shader errors marked on the node that caused them.

**Landed in round 4:** a Custom GLSL node's error marks its code in the inspector; the error panel leads with a plain message per node and keeps the compiler's lines behind Details; named links work in shader graphs too.

- **One canvas.** A single canvas, node finder and editing module for both the texture and the shader graph, fast with 1,000 nodes.
- **The canvas tools in §5.** Pictures in the finder, insertion onto wires, named links, frames, align, bypass, collapse, find, minimap, editing sub-graphs in place, a cost heat map, and errors marked on the right node.
- **2D view:** pixel values, histogram with range selection, colour pins, compare wipe, exposure, and handles for transforms, the tile sampler, gradients and shapes.
- **3D view:** the engine's own material path, a choice of HDRI, shadows, displacement on models, channel isolation, and a UV and wireframe view.
- **Widgets:**
  - typed fields with sliders, soft and hard ranges, and arithmetic;
  - an angle dial and a position pad;
  - an eyedropper from the 2D and 3D views;
  - a gradient eyedropper along a line drawn on an image;
  - a curve editor over a histogram;
  - a code editor with highlighting and inline errors.
- **One look** across Materials, Material Overrides and Paint, with resizable panels that remember their layout, plain wording throughout, and undo that survives switching tabs.

**Can run alongside:** Stage 2's engine work.
**Checked by:** a 300-node graph built and edited at an ordinary window size, judged as a user would judge it.

### Stage 2 — One material, one physical surface

**Landed in round 2:** the physical surface on the shader graph's output (specular, coat, sheen, thin film, transmission and emission strength), drawn in WebGL2 and only when used. It also brought starter graphs, preview lighting, and physical values in Material Overrides. Still to come: WebGPU, one material asset, instances, parallax, triplanar normals and full decals.

**Landed in round 3:**
- **Instances:** per-object material values, texture and switch parameters, a shader version count, and blueprint nodes that set values during play.
- **Height:** a Parallax node with self-shadowing; generated materials wire their height through it.
- **Mapping and decals:** a triplanar node for normal maps, and decals that carry a whole material.
- **Still to come:** WebGPU, one material asset, and script-API access to material values.

**Landed in round 5:**
- **One material document:**
  - a material keeps its pictures by name beside its surface, read through Material Picture nodes;
  - Update material and Paint's apply rewrite only the pictures, so a surface edited by hand keeps its edits;
  - older projects move over when they load.
- **Painted copies:**
  - Retexture and the mask tool write a copy owned by the model, with "Keep the model's own maps" on, so only what was painted changes;
  - Reset Textures removes the copy;
  - the material lists don't show copies.
- **Deleting a material** names what uses it and can be undone.

**Landed in round 7: WebGPU parity.**
- **Checked on main:** weather and wind, the shape-keyed shader cache and the vertex-colour rule already worked on WebGPU.
- **Fixed:**
  - specular, index of refraction and thin film now draw there, as an approximation, since WebGPU's surface buffer keeps only albedo, normal, roughness and metalness;
  - "Keep the model's own maps" works there;
  - one-channel BC4 textures upload.
- **Covered:** a picture-test scene for physical lobes, picture-reading materials and painted copies runs on both renderers.
- **Still to come:** anisotropy on WebGPU, and specular below 4% there.

**Designed in round 4: one material document.**
- Each material holds its surface (today's shader graph, always there), plus an optional texture graph and an optional paint stack. Each of those writes named outputs, such as base colour, normal and height, as textures.
- The surface reads those outputs by name through Material Picture nodes, not by fixed texture ids. So Update material and Paint's apply rewrite only the outputs.
- Material Overrides keeps per-model and per-object values but points at one document. Retexture and the mask tool write a painted copy owned by the model, so Reset Textures drops the copy.
- Old projects move over when they load, with nothing lost; the host reads both shapes for a while before the old fields go.

- **One material asset.** It holds the surface model, plus optional texture graphs, a paint stack and parameters. The Materials tab, Paint, Retexture and Material Overrides all edit that asset rather than writing side channels.
- **A physical surface model** with an OpenPBR vocabulary, implemented in both renderers on one shader path that works alongside weather, wind and compressed normals:
  - base colour, metalness and diffuse roughness;
  - specular roughness, IOR, colour and anisotropy;
  - coat with colour, roughness, IOR and its own normal;
  - fuzz and thin film;
  - transmission with volume absorption and dispersion;
  - an approximation of subsurface;
  - emission (colour and strength);
  - opacity and thin walls.
- **The shader graph's output** takes these inputs. glTF material extensions import into it and become editable.
- **Material instances:** per-placed-object values, texture and switch parameters, values changed at runtime from scripts, and a visible count of shader variants.
- **Height in the engine:** parallax occlusion with self-shadowing, and displacement where the renderer allows. Also triplanar mapping for normals, and decals carrying a full material.

**Depends on:** the WebGPU renderer (#154) merged first, or this stage built on top of it. Decide whether the surface builds on an upgraded three.js physical material or on Auvra's own shader path; patching r164's shader text is brittle.
**Checked by:**
- car paint, frosted glass, velvet, skin and lacquered wood, built in the editor and compared with photos;
- identical looks in the 3D preview, the level view and a built game, on both renderers.

### Stage 3 — The graph engine grows up

**Landed in round 3:** wires that carry a whole material, with make, split, blend, height blend, multi-blend, switch, transform and adjust nodes. Still to come: the scatter pass, inheritance and tiling modes, function graphs, loops and GPU flood fill.

**Landed in round 4:**
- **Scatter pass:** every copy is drawn in one instanced pass, with the higher, the brightest, the sum or the last copy winning where they overlap. On it:
  - the tile sampler at full strength: up to 6 patterns, maps for size, turn, place, mask, colour and pattern choice, random mirroring, and Copy ID, Random value and Local UV outputs;
  - shape scatter: placed by Poisson disc, a density map or a placement picture; built-in shapes, a picture or raised heights; tilted in 3D, sized and flipped at random;
  - a tile generator and atlas scatter.
- **Inheritance and tiling:** a node's size, bit depth, tiling and seed come from its input, from the graph, or are fixed. Graphs and nodes tile both ways, across only, down only or not at all. The graph has its own bit depth and a physical size.
- **Flood fill on the GPU,** with followers to bounding box, index and position, and a mapper that turns, scales and flips at random.
- **Material wires through graphs used as nodes,** and finder pictures for the material nodes.
- **Still to come:** function graphs with previews of every value, a value processor, a pixel processor with named settings, the Iterate node, and normals that use the physical size.

**Landed in round 5:**
- **Function graphs:**
  - compiled through a list of steps that names no shading language, then to GLSL;
  - opened in place of the canvas, with every node previewed: a picture in a pixel processor, numbers in a value processor;
  - wires that don't fit are refused in plain words.
- **Value processor:** works out one value on the GPU. Any number, colour or switch setting on any node can show as a pin and follow it.
- **Pixel processor named settings,** each one exposable as a graph parameter.
- **Iterate:** runs a graph up to 64 times. Each output feeds the input of the same name, and every pass has its own number and seed.
- **Size in the world:** normals, curvature, occlusion and emboss measure slopes per metre of the graph's size.
- **Leftovers:**
  - the finder puts an exact name first;
  - new nodes land in free space;
  - cavity, bent normal and transferred maps are mesh-map nodes in Materials and in Paint's fills;
  - flood fill boxes are right across a tiling edge.
- **Still to come:** a WGSL writer for function graphs, material wires through Iterate, and opening Iterate's graph in place.

- **Material wires:** one wire carries a whole surface, with material blend, height blend, multi-blend, switch, transform and adjust nodes. Smart materials become material graphs.
- **A scatter pass:** a placement pass, then instanced drawing with height-aware stacking. It gives the tile sampler at full strength (6 pattern inputs, maps for every property, per-copy ID, random value and UV), shape scatter (Poisson, density and custom placement; 3D and SDF shapes), a tile generator, atlas scatter and grid atlas.
- **Inheritance and tiling:**
  - size, bit depth, tiling and seed taken from the input or the parent;
  - tiling modes;
  - non-square sizes in the editor;
  - physical size on the graph;
  - sub-graph copies vary their seeds.
- **Programmable nodes:**
  - node-based function graphs compiled to GLSL/WGSL, with every intermediate value previewable;
  - a value processor that stays on the GPU;
  - a pixel processor with named settings that can be exposed;
  - an Iterate node for image-level loops.
- **Flood fill on the GPU,** with full random values and the complete set of followers.

**Checked by:** a brick wall, a stone path, a parquet floor and a scattered-leaves ground, each built in a few nodes and compared side by side with photos.

### Stage 4 — Parameters, presets and the material library

**Landed in round 6:**
- **Exposed parameters:**
  - groups with descriptions, which fold;
  - descriptions on hover, and reset;
  - "Shown" conditions on parameters, and on graph inputs and outputs;
  - an option editor for choices;
  - limits, slider ends and steps;
  - every setting kind exposable, fonts included, through a new Text node.

  Fills and smart masks in Paint use the same panel.
- **Presets** kept in the graph or shared in the project, and a variation sheet: a grid of the output with one parameter, or the seed, changed across it.
- **My library:**
  - materials kept for every project with their pictures, shown as balls drawn on the engine's material path;
  - search, folders and tags, duplicate, delete with undo, and where each one went;
  - "Use in this project" brings in a copy with its pictures.
- **Still to come:**
  - renaming a parameter's formula name;
  - balls in the project's own material list;
  - library entries carrying the graphs they use as nodes;
  - templates and starter content.

**Landed in round 7:** balls beside every material in the project's list, redrawn when a material changes; library entries that carry the graphs they use as nodes; and the Materials sidebar's buttons as icons that fit a narrow window.
- **Exposed parameters:**
  - groups and descriptions;
  - show/hide conditions on parameters, inputs and outputs;
  - editable choice options, steps, and soft and hard ranges;
  - every setting kind exposable, including ramps, curves, pictures, text and fonts.
- **Presets** per graph, embedded or shared. Variation sheets and controlled variations.
- **A material library across projects:**
  - thumbnails rendered on the engine path;
  - search, tags, folders, duplicate, where-used, and delete with undo.
- **Templates and starter content:**
  - a template gallery with pictures;
  - annotated sample graphs;
  - a starter library of materials and smart materials, authored clean-room.

**Checked by:** a new user finds, picks and adjusts a ready material onto a model without opening a graph.

### Stage 5 — Node library breadth
One family per pull request, each with picture tooltips and the wrap-edge tiling check:
1. Noises and grunges, with a non-tiling option.
2. Patterns.
3. Adjustments and colour.
4. Blurs, warps and transforms, including safe transform.
5. Geometry effects and normal tools.
6. Mesh-based weathering, also usable in Materials with real baked maps.
7. Photo and scan processing.
8. Splines and paths, edited in the 2D view.
9. Text and vector shapes.
10. SDF shapes.
11. PBR checks.

**Can run alongside:** Stages 4 and 6.
**Checked by:** each family's nodes drawn on real inputs, plus one finished material per family.

**Landed in round 6:** a Safe transform that keeps tiling at any turn and size, by snapping or by blending the seams; "Keep it seamless" on Transform; and a Bitmap node that reads 16-bit and float files at their depth, with colour handling, crop and fitting.

**Landed in round 7: families 1 to 6, 91 new nodes.** Every one has a finder picture, a plain description and a tiling test where it makes a tiling picture.
1. **Noises and grunges:**
   - clouds, simplex, blue noise, dirt, spots, crystal, fibres, moisture, liquid, plasma, caustics;
   - directional noise and scratches;
   - 14 grunge looks;
   - a disorder setting.
2. **Patterns:** stripes, starburst, arc pavement, triangle grid, a weave generator, and radial, axial and circular gradients.
3. **Adjustments and colour:** histogram select, shift and equalize, channel mixer, colour match, colour lookup, palette, quantize colours, ID to mask, and levels per channel.
4. **Blurs, warps and transforms:**
   - anisotropic, non-uniform, radial and median blurs, and edge-preserving smoothing;
   - multi-directional and map-driven directional warps, and vector morph;
   - skew, symmetry, trapezoid, quad transform, rotate by map, auto crop, clone and noise upscale.
5. **Geometry and normals:**
   - smooth bevel, directional distance, smooth curvature, traced occlusion and shadows from height;
   - glow, shape outline, glow and shadow;
   - reaction-diffusion and diffusion;
   - normal uncombine, rotation and transform, bent normals from height, and a higher-quality height from normal.
6. **Weathering from mesh maps:**
   - edge wear, damage, notches, crevice dirt;
   - cloth, leather and metal wear;
   - dust, grease, leaks, dripping rust, sun bleach;
   - a mask builder.

   They read wired maps, then baked ones, then stand-ins.

**Still to come:** families 7 to 11 (photo processing, splines, vector shapes, SDF shapes, PBR checks), fur, lighting removal and the HDR range view.

**Landed in round 8: families 7 to 11.**
7. **Photo and scan processing:**
   - make it tile by cutting along the best-matching joins, with no ghosting;
   - smart auto tile, clone patch with handles, colour equalizer, atlas splitter;
   - lighting removal from occlusion and fitted shading.
8. **Splines and paths, placed in the 2D view:** curve (stroke, fill, gradient), bridge between curves, picture along a curve, scatter along curves, points, and mask to paths.
9. **Vector shapes:** polygons, stars, rounded boxes and ellipses from exact distances, shape booleans, and SVG shapes.
10. **SDF shapes:** up to three primitives combined hard or smooth, twisted, bent and repeated, giving height, normal, ID and a 3D view.
11. **PBR checks:** albedo-safe, metal and roughness ranges, and measured F0 references, striped over the 2D view.

**Also:**
- fur;
- an HDR range view;
- nodes that leave notes as they draw;
- edge-based weathering that reads stand-in panels when no curvature is wired.

**Still to come:**
- splines as wires that carry curves between nodes, and path tools such as offset;
- SDF shapes beyond three, with materials per shape;
- SVG strokes, clips and text.

### Stage 6 — Painting at full depth

**Landed in round 2:** painting with whole materials; filter layers; fills and masks that read the layers below; layer opacity and folder blends; saved smart materials, opened as texture graph copies, with rendered previews; recombining only changed areas; sparse pictures; and unwrapping in a worker. Still to come: new mask kinds, the brush engine (alphas, paths, clone, smudge, particles), projections, the 2D painting view and 8K.

**Landed in round 3:**
- **Masks and fills:** masks and fills by mesh part, UV piece, polygon, edge loop or ID colour, with a polygon fill tool.
- **Brushes:** a brush and alpha library with presets, pressure curves and tilt, lazy mouse, mirror planes and turned copies, and blur, sharpen, smudge and clone brushes.
- **Paths and fills:** editable paths with ribbons, stitches and text along them, and fills cast along an axis, round a ball or tube, or mirrored.
- **Still to come:** projections for brushes, warp grids, decals wrapped onto the mesh, the 2D painting view, and particle brushes.

**Landed in round 4:** part and ID colour masks pick whenever their effect is selected, with any tool, and laying a path on again replaces its copy.

**Landed in round 5:**
- **2D painting view:** paint on the UV layout instead of, or beside, the 3D view, with the same brushes, layers and masks. Island edges are drawn, and a faint wireframe can be turned on.
- **Brush projections:** flat along an axis, cast through like a decal, and from three sides.
- **Still to come:** symmetry and the stencil in the 2D view, warp grids, decals wrapped onto the mesh, and particle brushes.

**Landed in round 7:**
- **A history panel:** every step named by what it did, such as Drips or Lay decal. Click a step to go back to it.
- **Particle brushes:** particles that run down, fall or bounce, with Drips, Leaks, Dust and Splashes presets.
- **Wrapped decals:** a picture placed on the model and dragged; it follows the surface over curves and across UV seams, and is laid on as one step.
- **2D painting:** symmetry, the stencil, polygon fills and paths.
- **Still to come:** warp grids, particles in the 2D view and along any gravity, and particle paths that run over time.

**Landed in round 8:**
- **Paint stacks as graph nodes:** a painted set, or a folder of it, is a node with a picture per channel, reading the graph's mesh maps or the set's own bake.
- **Graphs as brushes:** each dab stamps a graph output's brightness.
- **Filters across UV seams:** blur, sharpen and smudge, as layers, mask effects and brushes, read across seams through the mesh's adjacency.
- **Retexture results as layers:** fill layers to mask and paint over.
- **Particles:** they run in the 2D view and fall along a chosen axis.

- **Paint with anything:** materials, textures and smart materials in every channel. Extended channels follow Stage 2.
- **Layers:**
  - layers that read the stack below (anchors);
  - generator and filter layers;
  - instanced layers;
  - layers that change the result beneath them.
- **Masks:** ID-colour, mesh, UV-island and polygon masks; reorderable mask stacks; saved smart masks and smart materials, opened in the graph editor.
- **Brush engine:**
  - an alpha library and presets; pressure curves and tilt;
  - lazy mouse and additive strokes;
  - editable paths with size and opacity per point, filled paths, ribbons, and text along a path;
  - curve brushes, and strokes driven by a graph (stitches);
  - radial symmetry;
  - clone, smudge, and blur and sharpen brushes;
  - particle brushes;
  - a visible, movable stencil.
- **Projections:** UV, planar, triplanar, spherical and cylindrical; warp grids; projections wrapped onto the mesh; symmetry on fills.
- **Fills and filters:** polygon fills by triangle, quad, mesh, UV piece and edge loop. A library of finishing filters: metal finishes, wear effects, stylisation and PBR checks.
- **Views and history:** painting in a 2D view; a history panel.
- **Speed and size:** only changed areas are recombined, with sparse tiles, so 8K sets with dozens of layers stay responsive inside the app.

**Checked by:** a worn sci-fi helmet and a hand-painted prop painted end to end, on a clean model and on a messy imported one.

### Stage 7 — Baking and UVs at full depth

**Landed in round 4:**
- **Baking:**
  - a bake size of its own and supersampling, held to what the graphics card safely takes, and averaged back so island edges don't darken;
  - cages by distance, automatic or from a model, and rays along averaged normals;
  - bake groups matched by name;
  - a choice of normal map frame and green direction;
  - cavity, bent normals, and colour, opacity and material carried over from the high-poly model.
- **UVs:** relax, straighten, and texel density shown, evened out and set.
- **Still to come:**
  - fixing bakes in place: painting skew and cage offset, a view of the rays, rebaking only a changed region, one undo history with painting;
  - supersampled bakes in strips, so big sets are not held back;
  - pins you place, angle-based flattening, a texel density heat map, and density matched between sets.

**Landed in round 5:**
- **Supersampling in strips:** a bake too large for the graphics card runs in strips, each averaged into the set's maps, with progress and Stop. For example, 2×2 at 2048 with every map bakes at 4096 in 5 strips.
- **Fixing bakes in place:**
  - paint skew correction and cage offset onto the model, kept with the bake;
  - rebake only the changed region;
  - bakes are steps in the paint history;
  - the bake rays show where the model is clicked.
- **UVs:**
  - pins placed by Alt-click, which Relax keeps;
  - angle-based flattening as an unwrap choice;
  - a texel density heat map;
  - density matched to another texture set.
- **Baking:**
  - cages by distance, automatic or from a mesh, and averaged normals;
  - automatic grouping of meshes into bake sets, matching by name, and a choice of tangent space;
  - supersampling;
  - bent normals, opacity, colour and material transfer, and cavity;
  - 16-bit normals;
  - bake size chosen per bake;
  - fixing bakes in place: painting the skew and the cage offset, a view of the bake rays, live rebake of only the changed region, and one undo history for painting and baking.
- **UVs:**
  - relax, straighten, pins, and angle-based flattening;
  - texel density set and matched across sets;
  - island tools with undo;
  - all heavy work off the main thread.

**Checked by:** a high-to-low bake of a hard-surface model with no ray gaps at hard edges, compared map by map with a trusted reference.

### Stage 8 — Export, interchange and the pipeline

**Landed in round 4:**
- **Import:** 16-bit PNG, TIFF, OpenEXR, Radiance HDR, TGA and flattened PSD, decoded at their own depth in a worker. Each texture keeps its settings: colour or data, normal map, compression, size limit, edges, filter and mip levels.
- **Compression:** material textures compress by what they are, with BC7 for colour, BC5 for normal maps and BC4 for one channel of data, and Kaiser-filtered mip levels. Floating-point maps that stay within white compress too; light beyond white stays in half floats.
- **Seeing the cost:** Texture Settings shows the picture before and after compression with the memory each takes, and a Texture memory view gives the total per level against the game's asset memory and per material.
- **Still to come:** ASTC and ETC2 for phones, built games carrying compressed textures, a cache for compressed results, override, terrain and decal textures on the deep path, a compressed format for light beyond white, and KTX2.

**Landed in round 5:**
- **Kept compressed:** a compressed texture is kept in the project under a signature of its file, role and settings. Reopening loads it as it is, and built games carry it.
- **Deep path:** Material Overrides' and decals' textures load like material textures, at full depth and compressed by role. Terrain layers are decoded at full depth.
- **Recognised by name:** normal maps (`_n`, `_nrm`, `_normal`, `_nor`, `_nor_gl`, `_nor_dx`, with DirectX green flipped) and data maps such as roughness, metallic, occlusion and height.
- **Still to come:** ASTC and ETC2, compressed terrain arrays, a compressed format for light beyond white, and KTX2.

**Landed in round 6:**
- **Export templates:**
  - file names with tokens, what goes in each channel, file kind and bit depth, normal convention, padding and sizes;
  - three built in (glTF for the web, packed ORM, one picture per channel), plus the project's own;
  - batches by size and by UDIM tile.
- **File kinds:** PNG at 8 or 16 bits, TGA, TIFF at 8, 16 or 32-bit float, and EXR at half or full float, from Paint and from the texture graph.
- **glTF export:**
  - a painted set as a .glb, with its maps and the material's own values;
  - KHR extensions only where used: clearcoat, sheen, transmission and volume, specular, thin film, anisotropy, emission strength;
  - read back by Auvra's own importer in a test.
- **Phones:** ASTC 4×4 and ETC2 encoders for graphics cards without BC. Each texture's phone versions are kept with the project, so built games carry them.
- **MaterialX:** a material's surface exports as Standard Surface or OpenPBR with its pictures, and a .mtlx file imports into a material.
- **Terrain:** layer arrays compress by role, as colour, normals, and height with roughness.
- **Still to come:**
  - glTF export of a whole model with all its materials and skinning;
  - MaterialX from a zip;
  - keeping compressed terrain arrays in the project;
  - a compressed format for light beyond white;
  - KTX2.

**Landed in round 7:** glTF export of a whole model: every mesh with its skin and clips, every material, and its painted sets. Bake undo now reaches older bakes within a memory cap.

**Landed in round 8:** cage rays reach the bake shaders by triangle lookup, the way decals do, instead of a per-vertex attribute.
- **Export:**
  - templates per target (file names, packing, bit depth, normal convention, padding), starting with a web-first glTF template;
  - EXR, TGA and TIFF;
  - UDIM batches and size batches.
- **Interchange:** glTF export with material extensions; MaterialX import and export; USD materials through the host.
- **Import:** 16-bit and EXR textures, with per-texture import settings.
- **Compression:**
  - GPU compression for every material texture (BC7 and BC5 on desktop, ASTC and ETC2 on phones);
  - KTX2 for downloads;
  - a compression preview and a budget view.

**Checked by:** a material made in Auvra opened in another glTF viewer and a MaterialX viewer, looking the same.

### Stage 9 — Materials alive in the game
- The player runs texture graphs itself.
- Per-object seeds and parameters, set by gameplay or scripts.
- Resolution follows level of detail.
- Results are cached by signature, with a baked fallback for weak devices.

**Checked by:** a level where weathering, wetness and damage change live on many objects at a steady frame rate, with smaller downloads than baked pictures.

**Landed in round 8:**
- **Games cook texture graphs on their own GPU:**
  - with the editor's evaluator, at the material's baked size;
  - kept by signature in the game's cache;
  - with the baked pictures as fallback;
  - a game setting chooses Cook when the device can, Always or Never.
- **Download size:** Texture 2's graph is about 4 KB against 6.2 MB of baked pictures, and a game that always cooks leaves the baked pictures out.
- **Per-object seeds and values:** set in a placed object's "Picture variation", by blueprints or by `object.setMaterialValue` in scripts. Objects with the same values share one cook, and the last cook stays on screen until the next is ready.
- **Resolution follows how large a material shows,** with hysteresis.
- **A Living Materials Lab template:** a row per seed, a wetness row, and a row whose wetness a blueprint steps over time.
- **Still to come:** level of detail in the editor's level views, and cooked pictures compressed for the GPU.

**Landed in round 9:**
- Cooked pictures move to GPU compression once shown, without a bare frame.
- An animated graph cooks as a flipbook, or again at a set rate as it plays.

### Stage 10 — Capture and AI
- **Photo to material:** lighting removal, tiling, pulling a material out of a photo by label, and multi-angle capture.
- **Generative nodes** in the graph.
- **Mesh texturing** as non-destructive layers.
- **The assistant** that builds and edits graphs as checked changes.
- **Photo to editable graph,** with parameters fitted to the photo.

**Checked by:** real photos of brick, bark and concrete turned into graphs, judged side by side.

**Landed in round 9: photo to editable graph, procedural.**
- New › From a photo, or a photo dropped on the material list or on Paint, builds a texture graph of ordinary nodes:
  - tiled, with lighting removed (from a soft occlusion and fitted shading) and colour evened out;
  - height from brightness and fine detail, inverted when the bright parts are thin lines such as mortar;
  - a normal from a lightly smoothed height, roughness from a curve, and metal by colour.
- A Strength row of exposed parameters: tiling width, lighting removed, height depth, invert, and roughness range.
- **Still to come:** pulling one material out of a photo by label, multi-angle capture, generative nodes, the assistant, and the AI matching-maps step on the tiled colour.

### Stage 11 — Further past the best tools
- Filters that cross UV seams.
- A branching history with comparison.
- Compression-aware authoring.
- Layer stacks as graph nodes, and graphs as brushes.
- Animated materials.
- Texture growth from examples.
- WebGPU compute paths.
- A scripting API and command-line batch work.

**Landed by round 9:**
- **Painting:** filters across seams (round 8), layer stacks as graph nodes, and graphs as brushes (round 8, in colour since round 9).
- **A branching history:** going back and painting keeps the replaced steps as a branch; Compare splits the view with a wipe.
- **Animated materials:**
  - a Time node with a loop length, and a play bar in the 2D view;
  - Update material lays a flipbook out, which a Flipbook Frames node plays.
- **Grow from example:** a larger tiling picture grown from patches of a small example, joined along their least visible cuts.
- **A WGSL writer for function graphs,** matching the GLSL one step for step, with a CPU reference for noise.
- **Compression-aware authoring:** a badge under a material's preview says what its textures take as the game keeps them, and where compression hurts, with a one-click fix.
- **Command line and scripts:**
  - `python -m Auvra.project.material_commands` lists materials, sets texture-graph values and applies presets on a closed project;
  - `object.applyMaterialPreset` sets a preset on one object in play.
- **Still to come:**
  - WebGPU compute paths;
  - headless cooking, balls and bakes from the command line;
  - editing materials from an editor script.
## 7. How each stage is checked

- **In the running editor first.** Each stage is used end to end in a lab built for it, under `C:\Users\Admin\AuvraLabs`, and judged by looking. Screenshots go in the pull request. Full test suites run once, at the end.
- **Real assets.** Use the Khronos sample models (helmets, lantern), Poly Haven CC0 models and scans, and Mixamo Remy. Never AI-generated models. Assets are never committed.
- **Both renderers.** Anything that changes how a material draws is checked in WebGL2 and in WebGPU.
- **Against a reference.** Each new material type is checked side by side with a photo of the real surface, or against a measured range: base colours and roughness of real metals, dielectrics and foliage.
- **Tiling and precision.** Each new node passes the wrap-edge check, and height and normal paths stay 16-bit or float end to end.
- **Speed.** Live edits at 2K stay interactive. A node that cannot is marked as slow on the canvas, with its cost shown.

## 8. Known defects

File references are relative to `fbx-viewer (1)/`.

### Fixed in round 1 (Stage 0)
- **Texture graph:**
  - Mesh-map nodes show real maps in the Materials tab: worked out for the preview shapes, or read from a model's Paint bake.
  - Unknown node types are kept as placeholders, and large graphs are no longer cut.
  - Copies of one sub-graph vary their seeds; named outputs can be grey.
  - The pixel processor is drawn in bands.
  - Kernels step by their input's pixel size.
  - Flood fill keeps a distinct random value per island and needs far less memory at 8K.
  - The gradient map keeps its alpha.
  - Undo keeps its history per material, records parameters and picture settings, and never stores NaN.
  - Values are clamped to their hard limits.
  - The UI offers every node size, including non-square.
  - Comments take titles and colours; the 2D view shows pixel values; the node list stays on the canvas.
  - Seeds are hashed; `-2^2` is −4; only changed nodes redraw.
  - On the shader graph canvas, right-drag pans and Tab moves focus.
- **Painting, baking and UVs:**
  - Soft strokes no longer show the UV triangles.
  - Baked and painted normals, painted height, and saved AO and thickness are 16-bit.
  - Position is measured in one even space per model, and older bakes are flagged.
  - Deleted layers free their pictures.
  - A relayout keeps coverage and the mesh's own tangents.
  - "Pack the current islands" packs without unwrapping again.
  - UV edits have their own undo, and islands can be kept in place.
  - A lost GPU context can no longer cost painting work.
  - The stencil is drawn and keeps its proportions.
  - UV stretch shows the current layout, and the 2D UV view shows each tile.
  - Colour picking wraps UVs.
  - The paint view has smooth edges and mipmapped pictures.
  - Mask effects can be reordered; undo has a memory cap.
- **Material graph and engine materials:**
  - Shader patches compose: graph-shaded materials and imported models with compressed normal maps take weather and wind.
  - "One picture per channel" outputs draw correctly.
  - UDIM atlases hold only the tiles in use, with gutters.
  - Vector 2 parameters save.
  - Only materials that can draw are offered.
  - The empty list points to Material Overrides.
  - Bounced light takes a graph-shaded material's colour.
  - Undo survives switching tabs.
  - Value edits update in place without recompiling.
  - Unlit and Phong materials say why they can't take an asset.
  - Material Overrides shows every map, and Retexture uses one base-map path.
  - The Time node says what its clock counts, and vertex colours are applied once.
  - Retexture, the mask tool and the host all use the one base-map path, and Reset Textures takes painted base maps off again.
  - The mask tool's Update Material works again. It fetched a data URL, which the editor's security policy refuses.

### Fixed in round 2
- Undo works anywhere in the texture graph workspace.
- 16-bit pictures are read into half floats.
- Position gradient runs along each axis of the model.
- Unwrapping and packing run in a worker.
- A stroke recombines only the area it touched.
- "Use this layout" is all-or-nothing.

### Fixed in round 3
- Graphs made from smart materials can be tidied into columns.
- Long names wrap in the Add menu and the material picker.
- The material preview balls render; since round 2 they had fallen back to flat swatches.

### Fixed in round 4
- Flood fill labels islands on the GPU, reading back one pixel a check instead of the whole mask.
- Material wires cross into graphs used as nodes, and named links work in shader graphs.
- A part mask picks whenever its effect is selected; the toolbar's polygon mode no longer competes with it.
- Laying a path on again replaces its copy.
- The shader error panel leads with a plain message; the compiler's lines sit behind Details.
- Material textures are compressed.
- Found while checking round 4:
  - Supersampled bakes no longer reset the graphics card, and the cavity map reads mid-grey instead of nearly black.
  - EXR normal and data maps compress instead of being kept as light beyond white, and the BC5 preview no longer shows black.
- Graph and painted height draw through the Parallax node (since round 3).

### Fixed in round 5
- **Graph:**
  - The graph's physical size is used: slopes are measured per metre.
  - The finder puts an exact name first.
  - New nodes land in free space.
  - The shader graph's Receive hides its unused input pin.
  - Flood fill boxes are right across a tiling edge for islands up to about three quarters of the picture.
- **Baking:** supersampling runs in strips instead of being held to one pass, and cavity, bent normal and transferred maps are mesh-map nodes.
- **Materials and textures:**
  - Deleting a material asks first and can be undone.
  - Override and decal textures are decoded at full depth and compressed.
  - Compressed textures are kept in the project, and built games carry them.
  - Normal maps are recognised by their file name.
- **Found while checking round 5:**
  - Update material removed the old pictures before the material's save landed, so they were kept and an error logged. The old pictures now go only after a save that went through.
  - The 2D painting view drew every triangle edge.
  - A UV panel slider was given NaN after unwrapping.
  - The bake rays were unreadable head-on.

### Fixed in round 6
- **Graph:**
  - There is a safe transform, and the Bitmap node reads deep files with crop and colour options.
  - Choice parameters have an option editor; steps, groups and descriptions have a UI.
- **Baking and painting:**
  - Strip bakes build their ray structures once.
  - Symmetry and the stencil work in the 2D painting view.
- **Materials and textures:**
  - Terrain arrays compress by role.
  - The host writes painted copies, and Material Overrides previews through them.
  - There is ASTC and ETC2 compression for phones.
- **Found while checking round 6:** Paint's export templates showed as a material in the lists.

### Fixed in round 7
- **Graph:**
  - Long parameter labels wrap, the description field says "Description", and a variation sheet of identical cells says why.
  - Graphs from smart materials group their parameters by layer.
- **Painting and baking:**
  - Paths and polygon fills work in 2D painting.
  - glTF export writes the whole model.
  - Painted cage offsets move the ray start for every cage kind.
- **Materials:**
  - The Materials sidebar fits a narrow window.
  - Library entries carry their node graphs.
  - The WebGPU items from before #154 merged are checked, and the missing physical inputs added.
- **Found while checking round 7:**
  - The wrapped decal at first painted most of the model a flat colour.
  - The decal tool stopped answering after "Give it up".
  - Arc pavement had straight cuts between rows.
  - The rust grunge was soft cloud.
  - Shape glow's shader didn't compile.
  - A new picture-test scene changed another scene on WebGPU when run before it; it now runs last.

### Fixed in round 8
- **Graph:**
  - Make it tile cuts along the best joins instead of one cross-fade.
  - Edge-based weathering shows on stand-ins and says why.
- **Painting and baking:**
  - The first decal click after picking a deep picture waits for it.
  - Mesh-cage bakes no longer use a per-vertex attribute.
  - Particles run in 2D and along any axis.
- **Found while checking round 8:**
  - The UDIM atlas pass declared the size every pass already has, so UDIM sets couldn't be laid on one atlas. It had been that way since round 1; a test now guards it.
  - In play, cooked crates looked different from the editor's, flashed black when their values changed, and missed steps.

### Fixed in round 9
- **Graph:**
  - Function graphs have a WGSL writer, and noise has a CPU reference.
  - Iterate carries materials, opens in place, and redraws only what each pass reaches.
  - A parameter's formula name can be renamed.
  - A finder picture that failed once is drawn again.
- **Painting:**
  - The paint stack node is named plainly and reuses the open set.
  - Graph brushes lay colour.
  - Particles move with time as the stroke is drawn.
- **Materials:**
  - Compressed terrain slices are kept in the project.
  - Cooked pictures are compressed once shown.
  - The level view's toolbar fits a narrow window.
- **Found while checking round 9:**
  - The texture store named every picture .png, so a JPEG photo failed to upload.
  - The photo graph's colour was speckled white, because its occlusion was noise and Lighting removal divided by it. Lighting removal now limits how much it brightens and says when its occlusion is speckled.
  - Its normal map was noise.
  - Its height raised the mortar.

### Still open
**Texture graph**
1. Update material draws mesh-reading nodes with stand-ins, because a material can go on any model. Per-model results come with cooking.
2. A flood fill box is approximate for an island covering more than about three quarters of a tiling axis.
3. Nothing runs the WGSL writer yet: texture graphs still draw on WebGL2.
4. Leaks and dripping rust are placed by noise and slope, not run down the model.
5. Read-around filters are checked for tiling by reading their shaders, not by measuring pixels.
6. Renaming a parameter doesn't reach other graphs using the graph, or objects' material values.
7. Flipbook frames may bleed slightly at cell edges with texture filtering.

**Painting, baking and UVs**
8. The paint view's smoothing draws into a render target marked as an XR target. Recheck this when three.js is upgraded (`components/Texturing/Paint/PaintViewport.tsx`).
9. A triangle that crosses a UDIM tile edge can pick a too-coarse mip at that edge.
10. The whole-model glTF keeps only the main maps of the model's other painted sets, and a UDIM set's vertex exactly on a tile edge can land in the wrong cell.
11. A paint stack folder always builds its own stack, and a stack node redraws only when its set saves.
12. Comparison in the history works only in the Material view.
13. Photo to material doesn't yet use the AI matching-maps step, and its starting guesses (invert, roughness) come from simple measures.

**Material graph, engine materials and textures**
14. Unlit and Phong materials can't take a material asset (a message says so). Converting them is a later step.
15. The surface has no coat tint, and car paint has no metal flakes.
16. BC7 uses one block mode, and ASTC and ETC2 use simple block modes, so some blocks blur a little more than with full encoders.
17. A texture never drawn in the editor has nothing kept, so a built game compresses it as it loads.
18. My library lives in the editor's own storage on this machine; painted copies and painting presets can't be added.
19. MaterialX can't be imported from a zip, and image tiling is ignored.
20. On WebGPU, anisotropy isn't drawn and specular can't go below 4%; both need a wider surface buffer.
21. On WebGPU, a scene drawn before a ray-traced one can still change it slightly (a leak across scenes on one device), seen in local picture runs.
22. The compression badge shows only on shader-graph materials, not in a texture graph's Material tab.
23. Cooking, balls and mesh-map bakes can't run headless from the command line.

## 9. Sources and references

- **Standards:**
  - OpenPBR Surface 1.1.x;
  - MaterialX 1.39.x, which generates WGSL from 1.39.4;
  - the glTF 2.0 material extensions (ratified: anisotropy, clearcoat, dispersion, emissive_strength, ior, iridescence, sheen, specular, transmission, unlit, volume; near-final: diffuse_transmission, retroreflection; drafts: volume_scatter, texture_procedurals);
  - OpenUSD with UsdPreviewSurface and MaterialX;
  - KTX2 with Basis Universal.
- **Techniques:**
  - hex-tiling ("Practical Real-Time Hex-Tiling", JCGT 2022);
  - histogram-preserving blending for stochastic texturing (2018);
  - biplanar mapping;
  - periodic-plus-smooth decomposition for exact tiling;
  - jump flooding for distance fields;
  - pointer-jumping connected-component labelling on the GPU.
- **Research directions for §4:**
  - language models that write editable procedural material graphs (2025–2026);
  - differentiable procedural graphs for fitting parameters to photos;
  - generative tileable PBR models (2024–2026);
  - neural texture compression.
- **Earlier reviews:** the 2026-11-04 texture graph review (its fixes are in #162), and `ENGINE_COMPLETION_ROADMAP.md` EDIT-06, which is out of date: a material system exists.
