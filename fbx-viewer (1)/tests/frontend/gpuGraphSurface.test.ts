import { beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { OUTPUT_NODE_TYPE, defaultParams, normalizeMaterialGraph, type MaterialGraph } from "../../runtime/materials/materialGraph";
import { bindMaterialGraph, boundMaterialGraph, unbindMaterialGraph } from "../../runtime/materials/graphMaterial";
import { materialLibrary } from "../../runtime/materials/materialLibrary";
import { patchWeatherMaterial } from "../../runtime/weatherSurfaces";
import { GRAPH_FLAG, GRAPH_WIND_AT, compileGraphWgsl, graphLayers } from "../../renderer/gpu/surfaces/materialWgsl";
import { graphFlags, graphSurfaceFor } from "../../renderer/gpu/surfaces/graph";
import { LIT_PHYSICAL_SURFACE, LIT_SURFACE, litSurfaceFor } from "../../renderer/gpu/surfaces/lit";
import { packWind } from "../../renderer/gpu/surfaces/wind";

// Counts how often graphs are put in WGSL, while still doing it.
vi.mock("../../renderer/gpu/surfaces/materialWgsl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../renderer/gpu/surfaces/materialWgsl")>();
  return { ...actual, compileGraphWgsl: vi.fn(actual.compileGraphWgsl) };
});

const node = (id: string, type: string, params: Record<string, unknown> = {}, look: Record<string, unknown> = {}) =>
  ({ id, type, x: 0, y: 0, params: { ...defaultParams(type), ...params }, ...look });
const link = (fromNode: string, fromOutput: string, toNode: string, toInput: string) => ({ fromNode, fromOutput, toNode, toInput });

/** A colour times a noise into the base colour, with the Material Output's own `output` values. */
const tinted = (output: Record<string, unknown> = {}, look: Record<string, unknown> = {}): MaterialGraph => normalizeMaterialGraph({
  nodes: [node("out", OUTPUT_NODE_TYPE, output), node("red", "color", { value: [1, 0, 0] }), node("noise", "noise"), node("mul", "multiply", {}, look)],
  links: [link("red", "out", "mul", "a"), link("noise", "out", "mul", "b"), link("mul", "out", "out", "baseColor")],
});

/** The base colour from the vertex colours. */
const painted = (): MaterialGraph => normalizeMaterialGraph({
  nodes: [node("out", OUTPUT_NODE_TYPE), node("paint", "vertexColor")],
  links: [link("paint", "out", "out", "baseColor")],
});

/** A noise pushing the vertices along their normals. */
const bulging = (): MaterialGraph => normalizeMaterialGraph({
  nodes: [node("out", OUTPUT_NODE_TYPE), node("lift", "vector", { value: [0, 0.1, 0] })],
  links: [link("lift", "out", "out", "worldPositionOffset")],
});

const surfaceBody = (wgsl: string): string => wgsl.slice(wgsl.indexOf("fn surface(in: SurfaceIn)"));
const count = (text: string, find: string): number => text.split(find).length - 1;

describe("a material graph in WGSL", () => {
  it("multiplies the vertex and instance colours in once, as three's shader does", () => {
    const plain = surfaceBody(compileGraphWgsl(tinted()).wgsl);
    expect(plain).toMatch(/out\.albedo = \(.+\) \* mgVertexColor\(\);/);
    // A graph reading the vertex colours uses them as it likes.
    const reading = compileGraphWgsl(painted()).wgsl;
    expect(surfaceBody(reading)).not.toMatch(/out\.albedo = .*\* mgVertexColor\(\);/);
    expect(surfaceBody(reading)).toContain("mgVertexColor()");
    expect(reading).toMatch(/fn mgVertexColor\(\) -> vec3f \{[^}]*\* mgIn\.instanceColor\.rgb;/);
  });

  it("gives emission its strength", () => {
    const { wgsl, fields } = compileGraphWgsl(tinted({ emissive: [1, 0.5, 0], emissiveStrength: 4 }));
    const strength = fields.find((field) => field.name.endsWith("_emissiveStrength"));
    expect(strength).toBeDefined();
    expect(surfaceBody(wgsl)).toMatch(new RegExp(`out\\.emissive = \\(.+\\) \\* \\(material\\.${strength!.name}\\);`));
  });

  it("takes the weather when the material does", () => {
    const body = surfaceBody(compileGraphWgsl(tinted()).wgsl);
    expect(body).toContain(`if ((material.flags & ${GRAPH_FLAG.takesWeather}u) != 0u) { out = applyWeather(in, out); }`);
    // After the surface is worked out, before the baked light.
    expect(body.indexOf("applyWeather")).toBeGreaterThan(body.indexOf("out.normal = mgWorldNormal();"));
    expect(body.indexOf("applyWeather")).toBeLessThan(body.indexOf("applyBakedVolume"));
  });

  it("carries the coat, sheen and transmission a graph uses as layers over the surface", () => {
    expect(graphLayers(tinted())).toEqual([]);
    expect(compileGraphWgsl(tinted()).wgsl).not.toContain("applyPhysicalLayers");

    const coated = compileGraphWgsl(tinted({ coat: 0.8, coatRoughness: 0.1 }));
    expect(coated.layers).toEqual(["coat"]);
    const coatedBody = surfaceBody(coated.wgsl);
    expect(coatedBody).toContain("out = applyPhysicalLayers(in, out, PhysicalLayers(");
    expect(coatedBody).toContain(`(material.flags & ${GRAPH_FLAG.blended}u) != 0u`);
    // The coat comes from the graph; the sheen and transmission it does not use are none.
    expect(coated.fields.some((field) => field.name.endsWith("_coat"))).toBe(true);
    expect(coatedBody).toMatch(/clamp\(material\.\w+_coat, 0\.0, 1\.0\),\s*clamp\(material\.\w+_coatRoughness, 0\.0, 1\.0\),\s*vec3f\(0\.0\),\s*1\.0,\s*0\.0,/);

    const all = compileGraphWgsl(tinted({ coat: 1, sheenColor: [0.5, 0.2, 0.2], transmission: 0.6 }));
    expect(all.layers).toEqual(["coat", "sheen", "transmission"]);
    expect(count(all.wgsl, "struct PhysicalLayers")).toBe(1);

    // Specular and thin film change the reflection rather than lie over it.
    const lobe = compileGraphWgsl(tinted({ ior: 1.8, thinFilm: 0.5 }));
    expect(lobe.layers).toEqual(["specular", "thinFilm"]);
    expect(lobe.wgsl).not.toContain("applyPhysicalLayers");
    expect(surfaceBody(lobe.wgsl)).toContain("out = applyPhysicalLobe(in, out, PhysicalLobe(");

    // An unlit graph shows its colour as it is.
    expect(compileGraphWgsl(tinted({ coat: 1, shading: "unlit" })).layers).toEqual([]);
  });

  it("tints what is under a coloured coat, and works metal flakes into the surface as the WebGL path does", () => {
    const paint = compileGraphWgsl(tinted({ coat: 1, coatColor: [1, 0.5, 0.4], flakeDensity: 0.5 }));
    expect(paint.layers).toEqual(["coat", "flakes"]);
    const body = surfaceBody(paint.wgsl);
    expect(body).toMatch(/clamp\(material\.\w+_coatColor, vec3f\(0\.0\), vec3f\(1\.0\)\),\s*\), \(material\.flags/);
    expect(paint.wgsl).toContain("fn mgMetalFlakes(p: vec3f, size: f32, density: f32) -> vec4f");
    expect(paint.wgsl).toContain("fn mgFlakeNormal(normal: vec3f, flake: vec4f) -> vec3f");
    expect(body).toContain("mgMetalFlakes(");
    // The flakes lean the normal though none is wired.
    expect(body).toContain("mgFlakeNormal(");
    expect(body).toContain("out.normal = mappedNormal(in, out.normal");
  });

  it("draws the specular, index of refraction and thin film a graph works out, under any coat", () => {
    const gem = compileGraphWgsl(tinted({ ior: 2.4, specularColor: [1, 0.9, 0.8], specularWeight: 0.9, thinFilm: 0.7, thinFilmThickness: 450, coat: 0.5 }));
    expect(gem.layers).toEqual(["specular", "coat", "thinFilm"]);
    const body = surfaceBody(gem.wgsl);
    const field = (suffix: string) => gem.fields.find((candidate) => candidate.name.endsWith(suffix))!.name;
    // ((ior - 1) / (ior + 1))^2 times the specular colour and strength, then the film's strength and thickness.
    expect(body).toContain(`((material.${field("_ior")}) - 1.0) / ((material.${field("_ior")}) + 1.0)`);
    expect(body).toContain(`max(material.${field("_specularColor")}, vec3f(0.0))`);
    expect(body).toContain(`clamp(material.${field("_specularWeight")}, 0.0, 1.0)`);
    expect(body).toContain(`clamp(material.${field("_thinFilm")}, 0.0, 1.0)`);
    expect(body).toContain(`max(material.${field("_thinFilmThickness")}, 0.0)`);
    expect(body.indexOf("applyPhysicalLobe")).toBeLessThan(body.indexOf("applyPhysicalLayers"));
    expect(count(gem.wgsl, "fn applyPhysicalLobe")).toBe(1);
    expect(gem.wgsl).toContain("fn thinFilmColour");
    // A film alone reflects as the lighting does otherwise.
    expect(surfaceBody(compileGraphWgsl(tinted({ thinFilm: 1 })).wgsl)).toMatch(/PhysicalLobe\(\s*vec3f\(0\.04\),/);
  });

  it("reads what a graph keeping the model's own maps leaves unwired off the material, as three's own code does", () => {
    const keeping = normalizeMaterialGraph({
      nodes: [node("out", OUTPUT_NODE_TYPE, { ownMaps: true }), node("red", "color", { value: [1, 0, 0] })],
      links: [link("red", "out", "out", "baseColor")],
    });
    const compiled = compileGraphWgsl(keeping);
    const body = surfaceBody(compiled.wgsl);
    // The colour is the graph's; roughness, metalness, normal and emission are the material's own maps and values.
    expect(compiled.textures.filter((texture) => texture.own).map((texture) => [texture.name, texture.own])).toEqual([
      ["mgOwnRoughnessMap", "roughnessMap"], ["mgOwnMetalnessMap", "metalnessMap"], ["mgOwnNormalMap", "normalMap"], ["mgOwnEmissiveMap", "emissiveMap"],
    ]);
    expect(compiled.fields.filter((field) => field.own).map((field) => field.own)).toEqual(["roughness", "metalness", "emissive", "emissiveIntensity"]);
    expect(body).toContain("out.roughness = clamp(material.mgOwnRoughness * textureSample(mgOwnRoughnessMap, mgOwnRoughnessMap_sampler, mgIn.uv0).g, 0.0, 1.0);");
    expect(body).toContain("out.metalness = clamp(material.mgOwnMetalness * textureSample(mgOwnMetalnessMap, mgOwnMetalnessMap_sampler, mgIn.uv0).b, 0.0, 1.0);");
    expect(body).toContain("out.emissive = (material.mgOwnEmissive * textureSample(mgOwnEmissiveMap, mgOwnEmissiveMap_sampler, mgIn.uv0).rgb) * (material.mgOwnEmissiveIntensity);");
    expect(body).toContain("let mgMapped = mgOwnNormal();");
    // Blue is rebuilt from red and green, so a BC5 normal map reads as it does on the WebGL path.
    expect(compiled.wgsl).toMatch(/fn mgOwnNormal\(\) -> vec3f \{[^}]*sqrt\(saturate\(1\.0 - dot\(texel, texel\)\)\)/);
    expect(compiled.wgsl).toContain("mgOwnEmissiveIntensity: f32,");
    expect(compiled.textures.some((texture) => texture.name === "mgOwnMap")).toBe(false);
    // Without the setting, none of it.
    const plain = compileGraphWgsl(tinted());
    expect(plain.textures.some((texture) => texture.own)).toBe(false);
    expect(plain.key).not.toBe(compileGraphWgsl(normalizeMaterialGraph({ ...tinted(), nodes: tinted().nodes.map((each) => (each.id === "out" ? { ...each, params: { ...each.params, ownMaps: true } } : each)) })).key);
  });

  it("keeps the wind's numbers ahead of the graph's own", () => {
    const { wgsl, fields, bytes } = compileGraphWgsl(tinted());
    expect(wgsl).toMatch(/normalScale: vec2f,\s*pad2: vec2f,\s*\/\/[^\n]*\n\s*wind: vec4f,/);
    expect(GRAPH_WIND_AT * 4).toBe(32);
    expect(Math.min(...fields.map((field) => field.offset))).toBeGreaterThanOrEqual(48);
    expect(bytes % 16).toBe(0);
  });

  it("moves the vertices in the wind only for a material that sways, from where the graph's offset left them", () => {
    const still = compileGraphWgsl(tinted());
    expect(still.displaces).toBe(false);
    expect(still.wgsl).not.toContain("windOffset");

    const swaying = compileGraphWgsl(tinted(), { sways: true });
    expect(swaying).toMatchObject({ displaces: true, readsVertex: false, sways: true });
    expect(swaying.key).not.toBe(still.key);
    expect(swaying.wgsl).toContain("return local + instanceLocalDirection(instance, windOffset(local, instance, material.wind.x, material.wind.y, material.wind.z, material.wind.w));");

    const offset = compileGraphWgsl(bulging(), { sways: true });
    expect(offset).toMatchObject({ displaces: true, readsVertex: true });
    expect(offset.wgsl).toContain("return mgOffsetLocal + instanceLocalDirection(instance, windOffset(mgOffsetLocal,");
    expect(compileGraphWgsl(bulging()).wgsl).toContain("return mgOffsetLocal;");
  });

  it("declares what it shares with the vertex offset and the wind once", () => {
    for (const compiled of [compileGraphWgsl(tinted()), compileGraphWgsl(tinted(), { sways: true }), compileGraphWgsl(bulging()), compileGraphWgsl(bulging(), { sways: true })]) {
      expect(count(compiled.wgsl, "fn instanceLocalDirection(")).toBeLessThanOrEqual(1);
      expect(count(compiled.wgsl, "fn windOffset(")).toBe(compiled.sways ? 1 : 0);
      expect(count(compiled.wgsl, "fn applyWeather(")).toBe(1);
    }
  });

  it("marches a Parallax node's height map, and shades toward the first sun without three's lights", () => {
    const bricks = (selfShadow: boolean) => normalizeMaterialGraph({
      nodes: [node("out", OUTPUT_NODE_TYPE), node("height", "parallax", { texture: "bumps", selfShadow }), node("colour", "texture", { texture: "bricks" })],
      links: [link("height", "uv", "colour", "uv"), link("colour", "rgb", "out", "baseColor"), link("height", "shadow", "out", "selfShadow")],
    });
    const { wgsl, textures } = compileGraphWgsl(bricks(true));
    expect(textures.find((texture) => texture.name === "mg_height_texture")?.slot).toBe("data");
    expect(wgsl).toContain("fn mgParallaxUv(heightMap: texture_2d<f32>, heightSampler: sampler,");
    expect(wgsl).toContain("fn mgParallaxShadow(heightMap: texture_2d<f32>, heightSampler: sampler,");
    const body = surfaceBody(wgsl);
    // A texture handed to a helper is its texture and its sampler.
    expect(body).toMatch(/mgParallaxUv\(mg_height_texture, mg_height_texture_sampler, /);
    expect(body).toMatch(/mgParallaxShadow\(mg_height_texture, mg_height_texture_sampler, [^;]*mgSunDirection\(\)/);
    expect(wgsl).not.toMatch(/directionalLights|NUM_DIR_LIGHTS|#if|#endif/);
    expect(wgsl).toContain("fn mgSunDirection() -> vec3f { return surfaceWorld.sun.xyz; }");
    // The shadow shades the direct light only: the surface buffer carries it to the lighting.
    expect(body).toMatch(/out\.selfShadow = clamp\(mg_height_out_shadow_\d+, 0\.0, 1\.0\);/);
    expect(surfaceBody(compileGraphWgsl(bricks(false)).wgsl)).not.toContain("mgParallaxShadow");
    expect(surfaceBody(compileGraphWgsl(tinted()).wgsl)).not.toContain("out.selfShadow");
  });

  it("takes a Triplanar Normal Map's normal in world space, and reads it at the largest level on vertices", () => {
    const rock = (normalSpace: string, into = "normal") => normalizeMaterialGraph({
      nodes: [node("out", OUTPUT_NODE_TYPE, { normalSpace }), node("bumps", "triplanarNormal", { texture: "rock" })],
      links: [link("bumps", "out", "out", into)],
    });
    const world = compileGraphWgsl(rock("world"));
    expect(world.textures).toEqual([{ name: "mg_bumps_texture", slot: "normal" }]);
    const worldBody = surfaceBody(world.wgsl);
    const local = /var (mg_bumps_out_out_\d+): vec3f = mgTriplanarNormal\(mg_bumps_texture, mg_bumps_texture_sampler, /.exec(worldBody)?.[1];
    expect(local).toBeDefined();
    expect(worldBody).toContain(`out.normal = normalize(${local});`);
    expect(worldBody).not.toContain("mappedNormal(");
    const tangent = compileGraphWgsl(rock("tangent"));
    expect(surfaceBody(tangent.wgsl)).toContain("mappedNormal(");
    expect(tangent.key).not.toBe(world.key);

    const offset = compileGraphWgsl(rock("world", "worldPositionOffset"));
    expect(offset.wgsl).toContain("fn mgTriplanarNormalVertex(");
    expect(offset.wgsl).toMatch(/textureSampleLevel\(map, mapSampler, [^;]*, 0\.0\)/);
    const displace = offset.wgsl.slice(offset.wgsl.indexOf("fn displace("), offset.wgsl.indexOf("fn surface(in: SurfaceIn)"));
    expect(displace).toContain("mgTriplanarNormalVertex(mg_bumps_texture, mg_bumps_texture_sampler, ");
    expect(displace).not.toMatch(/mgTriplanarNormal\(/);
  });

  it("reads nothing across the screen where vertices are worked out", () => {
    const lifted = normalizeMaterialGraph({
      nodes: [node("out", OUTPUT_NODE_TYPE), node("noise", "noise"), node("slope", "normalFromHeight")],
      links: [link("noise", "out", "slope", "height"), link("slope", "out", "out", "worldPositionOffset")],
    });
    const wgsl = compileGraphWgsl(lifted).wgsl;
    const displace = wgsl.slice(wgsl.indexOf("fn displace("), wgsl.indexOf("fn surface(in: SurfaceIn)"));
    expect(displace).toContain("vec3f(0.0, 0.0, 1.0)");
    expect(displace).not.toContain("dpdx");
  });

  it("builds only the side a Switch picks", () => {
    const picked = (on: boolean) => normalizeMaterialGraph({
      nodes: [node("out", OUTPUT_NODE_TYPE), node("pick", "switch", { on }), node("noise", "noise"), node("red", "color", { value: [1, 0, 0] })],
      links: [link("noise", "out", "pick", "whenOn"), link("red", "out", "pick", "whenOff"), link("pick", "out", "out", "baseColor")],
    });
    expect(compileGraphWgsl(picked(true)).wgsl).toContain("mgLegacyNoise(");
    expect(compileGraphWgsl(picked(false)).wgsl).not.toContain("mgLegacyNoise(");
  });

  it("calls a Custom GLSL node's own function", () => {
    const custom = normalizeMaterialGraph({
      nodes: [node("out", OUTPUT_NODE_TYPE), node("code", "customGlsl")],
      links: [link("code", "out", "out", "baseColor")],
    });
    const { wgsl } = compileGraphWgsl(custom);
    const name = /fn (mg_code_\w+)\(/.exec(wgsl)?.[1];
    expect(name).toBeDefined();
    expect(surfaceBody(wgsl)).toContain(`${name}(`);
  });

  it("passes a bypassed node's main input straight through", () => {
    const plain = compileGraphWgsl(tinted());
    const bypassed = compileGraphWgsl(tinted({}, { bypass: true }));
    expect(bypassed.key).not.toBe(plain.key);
    // What fed only the bypassed multiply's other input is left out.
    expect(surfaceBody(plain.wgsl)).toContain("mgLegacyNoise(");
    expect(bypassed.wgsl).not.toContain("mgLegacyNoise(");
  });
});

describe("the kind drawing a graph-shaded material", () => {
  const compiles = vi.mocked(compileGraphWgsl);
  beforeEach(() => {
    compiles.mockClear();
  });

  it("is compiled once for a graph edited value by value, and shared by materials of its shape", () => {
    const material = new THREE.MeshStandardMaterial();
    bindMaterialGraph(material, tinted({ roughness: 0.3 }));
    const kind = graphSurfaceFor(material);
    expect(kind).not.toBeNull();
    expect(compiles).toHaveBeenCalledTimes(1);

    bindMaterialGraph(material, tinted({ roughness: 0.7, metalness: 1 }));
    expect(graphSurfaceFor(material)).toBe(kind);
    const other = new THREE.MeshStandardMaterial();
    bindMaterialGraph(other, tinted({ roughness: 0.9 }));
    expect(graphSurfaceFor(other)).toBe(kind);
    expect(compiles).toHaveBeenCalledTimes(1);

    // Rewiring changes the shader.
    bindMaterialGraph(material, tinted({}, { bypass: true }));
    expect(graphSurfaceFor(material)).not.toBe(kind);
    expect(compiles).toHaveBeenCalledTimes(2);
  });

  it("follows the material into the wind and the weather", () => {
    const material = new THREE.MeshStandardMaterial({ name: "Leaves" });
    bindMaterialGraph(material, tinted({ roughness: 0.4 }));
    const still = graphSurfaceFor(material)!;
    expect(still.displaces).toBe(false);
    expect(graphFlags(material) & GRAPH_FLAG.takesWeather).toBe(0);

    expect(patchWeatherMaterial(material)).toBe(true);
    expect(graphFlags(material) & GRAPH_FLAG.takesWeather).toBe(GRAPH_FLAG.takesWeather);
    expect(graphSurfaceFor(material)).toBe(still);

    material.userData.windSway = { sway: 1, flutter: 0.5 };
    material.userData.windShape = { bottom: -0.5, height: 2 };
    const swaying = graphSurfaceFor(material)!;
    expect(swaying).not.toBe(still);
    expect(swaying.displaces).toBe(true);
    const floats = new Float32Array(16);
    packWind(material, floats, GRAPH_WIND_AT);
    expect([...floats.subarray(GRAPH_WIND_AT, GRAPH_WIND_AT + 4)]).toEqual([1, 0.5, -0.5, 2]);

    material.userData.windSway = null;
    expect(graphSurfaceFor(material)).toBe(still);
  });

  it("draws a painted copy with the model's own maps and values", () => {
    const keeping = normalizeMaterialGraph({
      nodes: [node("out", OUTPUT_NODE_TYPE, { ownMaps: true }), node("red", "color", { value: [1, 0, 0] })],
      links: [link("red", "out", "out", "baseColor")],
    });
    const roughnessMap = new THREE.Texture();
    const normalMap = new THREE.Texture();
    const material = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.6, roughnessMap, normalMap, emissive: new THREE.Color(0.2, 0.4, 0.6), emissiveIntensity: 2 });
    bindMaterialGraph(material, keeping);
    const kind = graphSurfaceFor(material)!;
    expect(kind).not.toBeNull();
    const textures = kind.textures(material);
    // In the order the kind lays its textures out: roughness, metalness (none), normal, emission (none).
    expect(textures).toEqual([roughnessMap, null, normalMap, null]);
    unbindMaterialGraph(material);
  });

  it("draws each object's own values through one kind, and a switch an object sets through the kind of its side", () => {
    const graph = normalizeMaterialGraph({
      nodes: [
        node("out", OUTPUT_NODE_TYPE),
        { ...node("tint", "color", { value: [1, 1, 1] }), parameter: "Tint" },
        { ...node("pick", "switch", { on: false }), parameter: "Noisy" },
        node("noise", "noise"),
      ],
      links: [link("noise", "out", "pick", "whenOn"), link("tint", "out", "pick", "whenOff"), link("pick", "out", "out", "baseColor")],
    });
    materialLibrary.replaceAll([{ id: "shared", name: "Shared", graph }]);
    const red = new THREE.MeshStandardMaterial();
    const blue = new THREE.MeshStandardMaterial();
    const noisy = new THREE.MeshStandardMaterial();
    materialLibrary.assign(red, "shared", true, { Tint: [1, 0, 0] });
    materialLibrary.assign(blue, "shared", true, { Tint: [0, 0, 1] });
    materialLibrary.assign(noisy, "shared", true, { Noisy: true });
    expect(graphSurfaceFor(red)).not.toBeNull();
    expect(graphSurfaceFor(blue)).toBe(graphSurfaceFor(red));
    expect(boundMaterialGraph(red)!.nodes.find((each) => each.id === "tint")!.params.value).toEqual([1, 0, 0]);
    expect(boundMaterialGraph(blue)!.nodes.find((each) => each.id === "tint")!.params.value).toEqual([0, 0, 1]);
    expect(graphSurfaceFor(noisy)).not.toBe(graphSurfaceFor(red));
    expect(graphSurfaceFor(noisy)!.wgsl).toContain("mgLegacyNoise(");
    for (const material of [red, blue, noisy]) materialLibrary.assign(material, null);
    materialLibrary.replaceAll([]);
  });

  it("is told a blended material from a solid one", () => {
    const material = new THREE.MeshStandardMaterial({ transparent: true, vertexColors: true });
    expect(graphFlags(material)).toBe(GRAPH_FLAG.blended | GRAPH_FLAG.vertexColors);
  });

  it("leaves the physical parts a graph switches on out of the plain surface drawn until it is ready", () => {
    const material = new THREE.MeshStandardMaterial();
    bindMaterialGraph(material, tinted({ coat: 1, transmission: 0.5 }));
    const physical = material as THREE.MeshPhysicalMaterial;
    expect(physical.isMeshPhysicalMaterial).toBe(true);
    expect(physical.clearcoat).toBe(1);
    expect(litSurfaceFor(material)).toBe(LIT_SURFACE);
    unbindMaterialGraph(material);

    const imported = new THREE.MeshPhysicalMaterial({ clearcoat: 0.5 });
    expect(litSurfaceFor(imported)).toBe(LIT_PHYSICAL_SURFACE);
  });
});
