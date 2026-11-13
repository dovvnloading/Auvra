# M0.3 — Surface Channel Contract and Paint v1 Migration Design

> **Status:** Design proposal + read-only code catalog. This is **not** an extended painting implementation.
>
> **Milestone:** [M0 #279](https://github.com/dovvnloading/Auvra/issues/279), [M0.3 issue #285](https://github.com/dovvnloading/Auvra/issues/285).
>
> **Compatibility boundary:** Existing `PaintDocument.version === 1` and the seven values of `PAINT_CHANNELS` are authoritative and unchanged.
>
> **Code:** `fbx-viewer (1)/texturing/surfaceChannelCatalog.ts`; invariants: `tests/frontend/surfaceChannelCatalog.test.ts`.

## Purpose

Auvra already has richer shader-surface inputs than its paint document can hold. That difference must be resolved **before** adding coat, sheen, transmission, anisotropy, or thin-film painting. A new channel is usable only when the complete path—document → brush/fill/layers → sparse GPU composition → material graph → renderer → assets → import/export—understands its meaning.

This stage establishes stable naming, physical semantics, non-destructive migration rules, and explicit capability reporting. It does **not** alter saved paint documents or pretend that future channels are available.

## Current paint v1: preserve exactly

| Paint v1 key | Default RGB | Data role | Sparse picture bits/component | Shader socket | Painted glTF texture component |
|---|---|---|---:|---|---|
| `baseColor` | (0.5, 0.5, 0.5) | Colour | 8 | `baseColor` | `baseColorTexture` RGB |
| `roughness` | (0.6, 0.6, 0.6) | Linear scalar | 8 | `roughness` | `metallicRoughnessTexture` G |
| `metallic` | (0, 0, 0) | Linear scalar | 8 | `metalness` | `metallicRoughnessTexture` B |
| `height` | (0.5, 0.5, 0.5) | Linear scalar | 16 | Parallax/height path | No independent slot. Keep a separate height map for displacement workflows. |
| `normal` | (0.5, 0.5, 1) | Tangent-space normal | 16 | `normal` | `normalTexture` RGB |
| `emissive` | (0, 0, 0) | Colour | 8 | `emissive` | `emissiveTexture` RGB |
| `opacity` | (1, 1, 1) | Linear scalar | 8 | `opacity` | `baseColorTexture` A |

Precision here describes an editable sparse picture. The painted GLB writer encodes its exported pictures as PNG8. Occlusion can share the ORM texture's red component as a baked mesh map. The seven editable channels retain their existing identifiers and order.

## Proposed extended physical families (not enabled)

The read-only proposed catalog names existing shader surface outputs. These are **candidate paint channels**, not a promise that every output should be textured.

| Family | Proposed candidate keys | Critical design decisions |
|---|---|---|
| Specular | `specularWeight`, `specularColor`, `ior` | Which are useful as textures versus uniform values; renderer parity and valid IOR bounds |
| Clearcoat | `coat`, `coatRoughness`, `coatColor`, `coatNormal` | Independent tangent normal, quality/precision, and whether coat tint can round-trip in the target |
| Fabric | `sheenColor`, `sheenRoughness` | Gating by material capability; appropriate color/roughness semantics |
| Anisotropy | `anisotropy`, `anisotropyRotation` | Rotation is **degrees** in Auvra; direction needs correct tangent basis and wraps correctly |
| Thin film | `thinFilm`, `thinFilmThickness` | Thickness in **nanometres** in Auvra; export converts units when required |
| Transmission | `transmission`, `thickness`, `attenuationColor`, `attenuationDistance` | Volume distance/scale in world units; preview, support and sorting behavior |
| Dispersion | `dispersion` | Engine-specific behavior and varying target support |
| Flakes | `flakeDensity`, `flakeSize`, `flakeColor` | May remain procedural / per-object rather than high-resolution paint channels |

The catalog intentionally defines **no new brush defaults, PNG encodings or serialized channel values** for these candidates. Those choices need renderer/export capability evidence from M1/M2, not invented constants.

## Proposed descriptor v2

A future paint-enabled channel descriptor should include:

- **Identity:** stable key, version introduced, old key aliases only when required, human-readable label.
- **Values:** scalar / RGB / tangent normal / orientation, default, limits, units, dimensionality and whether higher precision is mandatory.
- **Color/role:** clear distinction between artist-facing color, linear scalar/data and normal vectors; conversions specified at the I/O boundary.
- **Paint policy:** allowed tools, blend algorithm (including normal/tangent combinations), masks and filters, alpha/coverage behavior.
- **Storage:** per-UDIM sparse-page format, working precision, save encoding, compression role and mip-generation rules.
- **Binding:** material graph socket or derived mapping, material instance overrides, WebGL2 and WebGPU capability flags, graceful fallback.
- **Interchange:** glTF extension/picture slot, MaterialX input, supported range and unit conversions, explicit per-target omissions.
- **Upgrade:** migration function, future-unknown field policy, safe rollback/read-only behavior.

Prefer a descriptor registry over another collection of channel-specific switches; however, a **full rewrite of paintStack is out of M0 scope**. First prove a single extended channel end-to-end and then generalize.

## Versioning / migration policy

1. **Paint v1 remains v1.** Keep the legacy seven keys, order, defaults and channel naming. Continue reading existing v1 documents without a different visual result.
2. **No accidental upgrade.** Importing or opening a v1 project does not manufacture default coat/sheen/anisotropy data or change the pictures it applies. An explicit new-channel action is required.
3. **Write v2 only when supported.** A new version (if required) should add descriptors/capability negotiation, per-channel storage metadata, and explicit serialization tests; do not force an upgrade for code that only adds a read-only catalog.
4. **Version and unknown-channel policy.** Versionless records use the v1 reader. For explicit v1 and versionless records, it exposes recognized channels and filters unknown channel names. Producers that add a channel must bump the document version. An explicit unsupported version makes `readPaintDocument` return null. When that set matches the model and material being opened, Paint refuses the edit before creating or saving a replacement. The source remains available to a compatible editor. See [the reader and open guard](../fbx-viewer%20(1)/texturing/paint/paintTypes.ts) and [version compatibility fixtures](../fbx-viewer%20(1)/tests/frontend/paintVersionGuard.test.ts).
5. **One authoritative source.** Source material remains a material asset plus authoring document; per-model painted copies, streamed runtime pages, and temporary GPU targets are not new master authorities.
6. **Undo and save:** changes to channel definitions, layer values, masks, texture assets and presets belong in the same logical undo transaction and complete project save.
7. **Versioned project fixtures:** old v1 layers, sparse-page masks, normal/height workflows, UDIMs, smart materials, paint-as-graph nodes, and import/export use cases must survive before a v2 writer is enabled.

### Non-destructive refusal rule

If a project contains a channel/feature that the current editor or target exporter cannot represent, **do not** silently flatten, substitute a numeric default, or remove that field. Preserve the source where technically safe and show an explicit incompatibility report. If safe preservation cannot be guaranteed, restrict the unsupported editing/export operation.

## Target integration matrix (design, not implementation status)

| Output | Existing coverage to reuse | Additional requirements for extended channels |
|---|---|---|
| WebGL2 editor | Physical material and texture graph shader layers | Multiple independent normal channels, paint composition, authoring UI, back-compat |
| WebGPU editor/runtime | Capability-gated physical material and cooking | Feature matrix per channel and compare images; fallback report for weaker surface buffer |
| Exported material maps | Core color/normal/ORM/height/emission | New channels, adequate depth and compression role, no silent loss |
| glTF 2.0 + extensions | KHR factors in `paint/gltfExport.ts` | Textures where extension schema supports them; coat tint/flakes may not map |
| MaterialX | Standard Surface/OpenPBR mapping in `texturing/materialX.ts` | Unit conversion, image channels, tiling/UV transform, package dependencies |
| `.auvramat` | Package with graph/dependencies | Persist extended channel descriptors and their version when actually implemented |

### Physical texture destinations and omissions

The painted GLB writer currently emits base colour/opacity, ORM, normal and emission pictures. It can also emit constant physical extension factors. All physical **texture** slots below are destinations for a future exporter. It must report each authored varying input it cannot encode. A constant factor cannot preserve spatial variation.

The MaterialX columns describe the current `materialToMaterialX` surface mapping. **Image** means a supported direct image connection can be emitted. **Value** means the writer can export a uniform or derived value and a varying input needs an omission report. The Standard Surface and OpenPBR names are given in that order where they differ.

| Auvra output | glTF extension and texture destination | MaterialX writer input or omission |
|---|---|---|
| `specularWeight` | `KHR_materials_specular.specularTexture` A | Value · `specular` / `specular_weight` |
| `specularColor` | `KHR_materials_specular.specularColorTexture` RGB, sRGB | Image · `specular_color` |
| `ior` | `KHR_materials_ior.ior` is uniform only | Value · `specular_IOR` / `specular_ior` |
| `coat` | `KHR_materials_clearcoat.clearcoatTexture` R | Image · `coat` / `coat_weight` |
| `coatRoughness` | `KHR_materials_clearcoat.clearcoatRoughnessTexture` G | Image · `coat_roughness` |
| `coatColor` | Clearcoat has no tint slot. Report omission. | Image · `coat_color` |
| `coatNormal` | `KHR_materials_clearcoat.clearcoatNormalTexture` RGB, tangent normal | Image via normalmap · `coat_normal` / `geometry_coat_normal` |
| `sheenColor` | `KHR_materials_sheen.sheenColorTexture` RGB, sRGB | Image · `sheen_color` / `fuzz_color` with a separate weight |
| `sheenRoughness` | `KHR_materials_sheen.sheenRoughnessTexture` A | Value · `sheen_roughness` / `fuzz_roughness` |
| `anisotropy` | `KHR_materials_anisotropy.anisotropyTexture` B | Value · `specular_anisotropy` / `specular_roughness_anisotropy` |
| `anisotropyRotation` | Same texture's RG encodes tangent-space direction. Convert degrees to a unit vector, then encode XY into [0, 1]. The uniform rotation uses radians. | Value · Standard `specular_rotation` in turns. OpenPBR uses the surface tangent and this writer reports nonzero rotation as omitted. |
| `thinFilm` | `KHR_materials_iridescence.iridescenceTexture` R | Value · Standard folds weight into `thin_film_thickness`. OpenPBR writes `thin_film_weight`. |
| `thinFilmThickness` | `KHR_materials_iridescence.iridescenceThicknessTexture` G, normalized over the declared minimum and maximum thickness in nm | Value · `thin_film_thickness`, nm for Standard and µm for OpenPBR |
| `transmission` | `KHR_materials_transmission.transmissionTexture` R | Image · `transmission` / `transmission_weight` |
| `thickness` | `KHR_materials_volume.thicknessTexture` G scales the uniform thickness in mesh space | No distance-through-geometry input mapped. Report omission. |
| `attenuationColor` | `KHR_materials_volume.attenuationColor` is uniform only | Value · `transmission_color` |
| `attenuationDistance` | `KHR_materials_volume.attenuationDistance` is uniform only | Value · `transmission_depth` |
| `dispersion` | `KHR_materials_dispersion.dispersion` is uniform only. Current GLB writer omits this extension. | Value · `transmission_dispersion` / `transmission_dispersion_scale` and `transmission_dispersion_abbe_number` |
| `flakeDensity`, `flakeSize`, `flakeColor` | No direct procedural-flake slot in these extensions. Report each authored omission. | No mapped inputs. Report each authored omission. |

The glTF components above follow the [Khronos extension schemas](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos). The implemented output paths are [painted glTF](../fbx-viewer%20(1)/texturing/paint/gltfExport.ts) and [MaterialX](../fbx-viewer%20(1)/texturing/materialX.ts).

## Required M2 vertical slices (before enabling the full catalog)

**Slice A — Coated metal:** preserve existing base color/normal/roughness while painting coat weight, coat roughness and (where the backend permits) independent coat normal. Inspect a realistic coated metal under multiple lighting environments; verify saved pixel depth and glTF/MaterialX target loss reports.

**Slice B — Fabric:** add a sheen color/roughness workflow with separate masks, preview and material output; demonstrate save/reopen, undo, and supported interchange.

**Slice C — Anisotropy:** verify brushing a directional field on mirrored UVs, tangent basis seams, rotation conventions, and renderer equivalence; avoid treating directions as an ordinary normalized scalar without documented conversion.

Only after those slices succeed should M2 convert the proposal catalog into a runtime authoring registry.

## M0.3 acceptance gate

- [x] Legacy seven-channel identifiers/defaults/order locked in a read-only catalog and unit-test assertions.
- [x] Every physical candidate accounted for against the shader graph output list, including eight feature families.
- [x] Sparse picture precision and painted GLB roles recorded for all seven v1 channels.
- [x] Per-output glTF texture destinations, factor-only cases, MaterialX image/value mappings and omission requirements documented.
- [x] No paint-v1 serialization, migration, renderer, compressor or exporter code changed by the catalog.
- [ ] Review/approve physical units, channel default values, and backend-supported texture-vs-uniform decisions.
- [ ] Approve unknown-v2-data behavior with migration and rollback tests.
- [ ] Author and review the first M2 implementation spec for coated metal and fabric.
- [ ] Pass the repository's typechecks and unit suite in CI.

**Deliverable status:** this PR completes a *compatibility-safe first catalog and design draft*, not M0.3 signoff, M0 completion, or M2 functionality. Hold the remaining gates until measured implementation evidence exists.
