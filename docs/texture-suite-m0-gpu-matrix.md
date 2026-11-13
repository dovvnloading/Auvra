# Texture suite GPU capability matrix

Generated from the texture graph registry and the two archived software-adapter captures below. The editor and player WebGL2 columns share the WebGL2 texture evaluator. The player WebGPU column records the same WebGPU evaluator the player calls. These fixture rows establish individual GPU operations. The authoring UI, standalone player and native integration have separate rows.

A verified cell requires a completed fixture on the stated backend. Fallback records a successful cook on a different backend. Unsupported records an explicit implementation rejection. Not-tested identifies an unmeasured path or configuration.

## GPU operations and application flows

| Fixture or flow | Editor WebGL2 | Player WebGL2 | Player WebGPU | Native scaffold |
|---|---|---|---|---|
| 512² brick graph with Perlin, tiles, multiply blend, height-to-normal and graph-mode pixel processor | verified | verified | verified | not-tested |
| Saved BC4 signed · 64 sampled pixels | verified | verified | verified | not-tested |
| Saved BC5 · 64 sampled pixels | verified | verified | verified | not-tested |
| Saved BC7 · 64 sampled pixels | verified | verified | verified | not-tested |
| Saved ETC2 RGB8 · 64 sampled pixels | verified | verified | verified | not-tested |
| Saved ETC2 RGBA8 EAC · 64 sampled pixels | verified | verified | verified | not-tested |
| Saved ASTC 4×4 · 64 sampled pixels | verified | verified | verified | not-tested |
| BC1 red/green stripes · paired WebGL2 and WebGPU readback | verified | verified | verified | not-tested |
| Instanced scatter · four layering modes and wrapped copies | verified | verified | verified | not-tested |
| Applied Paint snapshot · base colour, roughness and metallic samples | verified | verified | verified | not-tested |
| Code-mode GLSL with a user-defined struct · explicit translator rejection | not-tested | not-tested | unsupported | not-tested |
| Pooled target reuse and explicit device destruction/reacquisition · red/green pixels | not-tested | not-tested | not-tested | not-tested |
| Author and repaint layers, masks and multiple UDIM tiles in the editor | not-tested | not-tested | not-tested | not-tested |
| Mesh baking, scan capture and photometric reconstruction | not-tested | not-tested | not-tested | not-tested |
| Publish graph outputs, export a painted GLB and reopen the exported model | not-tested | not-tested | not-tested | not-tested |
| Play a standalone project with painted material overrides or curve subgraphs | not-tested | not-tested | not-tested | not-tested |
| Cross-renderer sampled coat, sheen, anisotropy, specular and thin-film parity | not-tested | not-tested | not-tested | not-tested |
| Cancel a live cook, edit a source image and verify the next presented frame | not-tested | not-tested | not-tested | not-tested |

## Registry coverage

The registry contains 207 node types across 19 families, including the dynamically resolved subgraph. Each row asks whether the entire family has device-backed coverage. The table above records the narrower configurations that have been measured.

| Family and registered node types | Editor WebGL2 | Player WebGL2 | Player WebGPU | Native scaffold |
|---|---|---|---|---|
| **Inputs and outputs** · `bitmap`, `curveInput`, `curveOutput`, `input`, `materialInput`, `materialOutput`, `output`, `time` | not-tested | not-tested | not-tested | not-tested |
| **Mesh maps** · `axisGradient`, `blendMeshNormals`, `directionMask`, `meshMap`, `noise3d`, `triplanar` | not-tested | not-tested | not-tested | not-tested |
| **Weathering** · `clothWear`, `damage`, `drippingRust`, `edgeWear`, `grease`, `leatherWear`, `maskBuilder`, `meshDirt`, `meshDust`, `meshLeaks`, `metalWear`, `notches`, `sunBleach` | not-tested | not-tested | not-tested | not-tested |
| **Materials** · `makeMaterial`, `materialAdjust`, `materialBlend`, `materialHeightBlend`, `materialMultiBlend`, `materialSwitch`, `materialTransform`, `paintStack`, `splitMaterial` | not-tested | not-tested | not-tested | not-tested |
| **Photo and scans** · `atlasSplitter`, `clonePatch`, `colourEqualizer`, `growFromExample`, `lightingRemoval`, `makeTile`, `smartAutoTile` | not-tested | not-tested | not-tested | not-tested |
| **Noises** · `anisotropicNoise`, `blueNoise`, `caustics`, `cells`, `clouds`, `crystal`, `directionalNoise`, `directionalScratches`, `dirt`, `fibres`, `fractalSum`, `fur`, `grunge`, `liquid`, `moisture`, `perlinNoise`, `plasma`, `simplexNoise`, `spots`, `whiteNoise` | not-tested | not-tested | not-tested | not-tested |
| **Patterns** · `arcPavement`, `atlasScatter`, `axialGradient`, `checker`, `circularGradient`, `hexTiles`, `radialGradient`, `reactionDiffusion`, `scratches`, `shapeScatter`, `starburst`, `stripes`, `tileGenerator`, `tileSampler`, `tiles`, `triangleGrid`, `weave`, `weaveGenerator` | not-tested | not-tested | not-tested | not-tested |
| **Shapes** · `gradient`, `shape`, `shapeBoolean`, `svgShape`, `text`, `vectorShape` | not-tested | not-tested | not-tested | not-tested |
| **Splines and paths** · `curve`, `curveBridge`, `curveMap`, `curveScatter`, `maskToPaths`, `pathJoin`, `pathOffset`, `pathResample`, `pathSmooth`, `pointList` | not-tested | not-tested | not-tested | not-tested |
| **SDF shapes** · `sdfShapes` | not-tested | not-tested | not-tested | not-tested |
| **Adjustments** · `autoLevels`, `brightnessContrast`, `channelMixer`, `clamp`, `colorToMask`, `colourLookup`, `colourMatch`, `curves`, `gradientMap`, `grayscale`, `histogramEqualize`, `histogramRange`, `histogramScan`, `histogramSelect`, `histogramShift`, `hsl`, `idToMask`, `invert`, `levels`, `levelsPerChannel`, `palette`, `posterize`, `quantize`, `replaceColor`, `threshold` | not-tested | not-tested | not-tested | not-tested |
| **Blending** · `blend`, `heightBlend` | not-tested | not-tested | not-tested | not-tested |
| **Transforms** · `autoCrop`, `clone`, `mapRotation`, `mirror`, `noiseUpscale`, `polar`, `quadTransform`, `safeTransform`, `skew`, `symmetry`, `tile`, `transform`, `trapezoid` | not-tested | not-tested | not-tested | not-tested |
| **Warps** · `directionalWarp`, `mapDirectionalWarp`, `multiDirectionalWarp`, `slopeBlur`, `swirl`, `vectorMorph`, `vectorWarp`, `warp` | not-tested | not-tested | not-tested | not-tested |
| **Blurs and sharpening** · `anisotropicBlur`, `blur`, `directionalBlur`, `highpass`, `medianBlur`, `nonUniformBlur`, `radialBlur`, `sharpen`, `smoothKeepEdges`, `variableBlur` | not-tested | not-tested | not-tested | not-tested |
| **Edges and distance** · `bevel`, `diffusion`, `directionalDistance`, `distance`, `edgeDetect`, `floodBox`, `floodFill`, `floodGradient`, `floodIndex`, `floodMapper`, `floodPosition`, `floodRandomColor`, `floodRandomGray`, `floodSize`, `glow`, `morphology`, `shapeGlow`, `shapeOutline`, `shapeShadow`, `smoothBevel` | not-tested | not-tested | not-tested | not-tested |
| **Height and normals** · `aoFromHeight`, `bentNormalFromHeight`, `curvature`, `emboss`, `heightShadow`, `normalAdjust`, `normalCombine`, `normalFromHeight`, `normalRotation`, `normalToHeight`, `normalToHeightHQ`, `normalTransform`, `normalUncombine`, `smoothCurvature`, `tracedOcclusion` | not-tested | not-tested | not-tested | not-tested |
| **Checks** · `albedoCheck`, `measuredF0`, `pbrRangeCheck` | not-tested | not-tested | not-tested | not-tested |
| **Utility** · `channelShuffle`, `iterate`, `mergeChannels`, `namedReceive`, `namedSend`, `pixelProcessor`, `reroute`, `splitChannels`, `subgraph`, `switch`, `uniformColor`, `uniformValue`, `valueProcessor` | not-tested | not-tested | not-tested | not-tested |

## Captures

### webgl2

- ubuntu-latest · Google Inc. (Google) · ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)
- Browser unavailable in this capture. Chromium driver inventory unavailable in this capture.
- Workflow head `9b47806faa05d11890440ab86eb3dafd3ff87aa5`. Checkout unrecorded. [CI artifact](https://github.com/dovvnloading/Auvra/actions/runs/43510600837/artifacts/14077873652)
- Reference PNG SHA-256 `8c9656d2f1a5f4cd824786bf19c69f3a7dea0ce0df5fa70b1d42aeec490733a4`. Screenshot SHA-256 `8c9656d2f1a5f4cd824786bf19c69f3a7dea0ce0df5fa70b1d42aeec490733a4`.
- Compression flags `EXT_texture_compression_rgtc` (true), `EXT_texture_compression_bptc` (true), `WEBGL_compressed_texture_etc` (true), `WEBGL_compressed_texture_astc` (true).

### webgpu

- windows-latest · google · swiftshader
- Browser unavailable in this capture. Chromium driver inventory unavailable in this capture.
- Workflow head `db253b327e931e0f173027eafa528fe70d545c7a`. Checkout unrecorded. [CI artifact](https://github.com/dovvnloading/Auvra/actions/runs/43511976618/artifacts/14079486796)
- Reference PNG SHA-256 `a3679b82c59ededec5c45bb635e4ad1a16a477189e2cce06fbc39e55018bacae`. Screenshot SHA-256 `a3679b82c59ededec5c45bb635e4ad1a16a477189e2cce06fbc39e55018bacae`.
- Compression flags `texture-compression-bc` (true), `texture-compression-etc2` (true), `texture-compression-astc` (true).

## Reproduce

From `fbx-viewer (1)`, run `npm ci` and `npm run texture:matrix`. Use `npm run texture:matrix -- --check` to detect drift. To replace a capture, first check out the visual reference used in that run and extract its artifact. Run `npm run texture:matrix -- capture <backend> <directory> <workflow-head-sha> <run-id> <artifact-id> <runner-os>` for each backend, then regenerate. Keep a failed run for diagnosis and retain the last successful evidence.

Fixture details, tolerances and remaining hardware gates are in the [GPU capability evidence](texture-suite-m0-gpu-capability-evidence.md). Adapter flags and sampled results are in the [capture records](texture-suite-m0-gpu-captures.json).
