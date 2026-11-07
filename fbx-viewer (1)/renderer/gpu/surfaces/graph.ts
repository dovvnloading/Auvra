/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { MATERIAL_TIME, boundMaterialGraph } from "../../../runtime/materials/graphMaterial";
import { materialGraphSettings, materialGraphShape, type MaterialGraph } from "../../../runtime/materials/materialGraph";
import { isWeatherPatched } from "../../../runtime/weatherSurfaces";
import { registerSurfaceKind } from "../materialPool";
import { surfaceBufferShader } from "../shaders";
import { textureLayoutEntries, type SurfaceKind } from "../surfaces";
import { hookUniforms } from "./materialHooks";
import { GRAPH_FLAG, GRAPH_WIND_AT, compileGraphWgsl, graphLayers, type CompiledGraphWgsl } from "./materialWgsl";
import { packWind, windSwayOf } from "./wind";
import { deviceOf, worldBindEntries, worldLayoutEntries } from "./world";
import { reportGpu } from "../report";

/**
 * MATERIALS SHADED BY A GRAPH
 *
 * A surface kind per graph shape, as the WebGL path compiles one (runtime/materials/graphMaterial.ts): its wiring and
 * settings, the parts of a physical surface it uses, and whether the material sways in the wind. Materials of one shape
 * share a kind, and only their numbers and textures differ, so a graph edited value by value is compiled once. A graph
 * can hold more numbers than a material's slice of the common buffer, so each material has a small uniform buffer of
 * its own. The numbers and textures are the very uniform objects the WebGL path reads, so editing a constant in the
 * material editor just writes them again, and the time is the one MaterialClock keeps. A kind is drawn only once its
 * shader has been seen to compile: until then, and for good if it does not, the material draws as a plain lit surface
 * rather than taking the frame down with it.
 */

type GraphBuffer = {
  device: GPUDevice;
  buffer: GPUBuffer;
  data: Float32Array;
  words: Uint32Array;
  sent: Float32Array;
};

const buffers = new WeakMap<THREE.Material, GraphBuffer>();

const bufferFor = (material: THREE.Material, device: GPUDevice, bytes: number): GraphBuffer => {
  const known = buffers.get(material);
  if (known && known.device === device && known.data.byteLength === bytes) return known;
  known?.buffer.destroy();
  if (!known) material.addEventListener("dispose", () => {
    buffers.get(material)?.buffer.destroy();
    buffers.delete(material);
  });
  const data = new Float32Array(bytes / 4);
  const made: GraphBuffer = {
    device,
    buffer: device.createBuffer({ label: `gpu graph ${material.name || material.uuid}`, size: bytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    data,
    words: new Uint32Array(data.buffer),
    sent: new Float32Array(bytes / 4).fill(Number.NaN),
  };
  buffers.set(material, made);
  return made;
};

/** Writes a uniform's value at its place. */
const writeField = (data: Float32Array, at: number, kind: string, value: unknown): void => {
  if (value === null || value === undefined) return;
  switch (kind) {
    case "float":
      data[at] = value as number;
      break;
    case "color":
      data[at] = (value as THREE.Color).r;
      data[at + 1] = (value as THREE.Color).g;
      data[at + 2] = (value as THREE.Color).b;
      break;
    case "vec2":
      data[at] = (value as THREE.Vector2).x;
      data[at + 1] = (value as THREE.Vector2).y;
      break;
    case "vec3":
      data[at] = (value as THREE.Vector3).x;
      data[at + 1] = (value as THREE.Vector3).y;
      data[at + 2] = (value as THREE.Vector3).z;
      break;
    case "ramp":
      (value as THREE.Vector4[]).forEach((stop, index) => stop.toArray(data, at + index * 4));
      break;
    default:
      break;
  }
};

const graphUniforms = (material: THREE.Material): Record<string, THREE.IUniform> => hookUniforms(material, boundMaterialGraph(material));

/** The flags a graph's shader reads of the material it draws (materialWgsl.ts GRAPH_FLAG). */
export const graphFlags = (material: THREE.Material): number => {
  const m = material as THREE.MeshStandardMaterial;
  return (m.vertexColors ? GRAPH_FLAG.vertexColors : 0)
    | (m.flatShading ? GRAPH_FLAG.flatShading : 0)
    | (isWeatherPatched(material) ? GRAPH_FLAG.takesWeather : 0)
    | (m.transparent ? GRAPH_FLAG.blended : 0);
};

const makeKind = (compiled: CompiledGraphWgsl): SurfaceKind => {
  const textureCount = compiled.textures.length;
  return {
    id: compiled.id,
    wgsl: compiled.wgsl,
    displaces: compiled.displaces,
    readsVertex: compiled.readsVertex,
    layoutEntries: () => [...textureLayoutEntries(textureCount), ...worldLayoutEntries(compiled.worldBinding)],
    textures: (material) => {
      const uniforms = graphUniforms(material);
      // A map of the material's own (a graph keeping the model's own maps) is read off the material.
      return compiled.textures.map((texture) => ((texture.own ? (material as unknown as Record<string, unknown>)[texture.own] : uniforms[texture.name]?.value) as THREE.Texture | null | undefined) ?? null);
    },
    bindGroupEntries: (input) => {
      const { buffer } = bufferFor(input.material, deviceOf(input.pool), compiled.bytes);
      const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer } }];
      compiled.textures.forEach((texture, index) => {
        const map = input.maps[index] ?? (texture.slot === "normal" ? input.pool.flatNormal : input.pool.white);
        entries.push({ binding: 1 + index * 2, resource: map.view });
        entries.push({ binding: 2 + index * 2, resource: map.sampler });
      });
      return [...entries, ...worldBindEntries(input.pool, compiled.worldBinding)];
    },
    pack(material) {
      const own = buffers.get(material);
      if (!own || own.data.byteLength !== compiled.bytes) return;
      const { data, words, sent, buffer, device } = own;
      const m = material as THREE.MeshStandardMaterial;
      const uniforms = graphUniforms(material);
      data[0] = compiled.animated ? MATERIAL_TIME.value : 0;
      data[1] = m.alphaTest;
      words[2] = graphFlags(material);
      data[4] = m.normalScale.x;
      data[5] = m.normalScale.y;
      if (compiled.sways) packWind(material, data, GRAPH_WIND_AT);
      for (const field of compiled.fields) writeField(data, field.offset / 4, field.kind, field.own ? (material as unknown as Record<string, unknown>)[field.own] : uniforms[field.name]?.value);
      let same = true;
      for (let index = 0; index < data.length; index++) {
        if (data[index] !== sent[index] && !(Number.isNaN(data[index]) && Number.isNaN(sent[index]))) {
          same = false;
          break;
        }
      }
      if (same) return;
      sent.set(data);
      device.queue.writeBuffer(buffer, 0, data);
    },
  };
};

/** A kind is only drawn when "ready": it has been compiled on the device. */
interface GraphEntry {
  kind: SurfaceKind;
  state: "pending" | "ready" | "failed";
}

/**
 * The entries by the graph's shape as drawn (null for one that cannot be put in WGSL), and by the code they compile to,
 * so that shapes compiling alike share one. Graphs are never changed in place, so each graph's entries, still and
 * swaying, are looked up once.
 */
const entriesByShape = new Map<string, GraphEntry | null>();
const entriesByKey = new Map<string, GraphEntry>();
const entriesByGraph = new WeakMap<MaterialGraph, { still?: GraphEntry | null; wind?: GraphEntry | null }>();

let device: GPUDevice | null = null;

/** The device new graph kinds are checked on. */
export const setGraphDevice = (current: GPUDevice): void => {
  device = current;
};

const checkEntry = (entry: GraphEntry): void => {
  if (!device) {
    entry.state = "ready";
    return;
  }
  const module = device.createShaderModule({ label: `gpu check ${entry.kind.id}`, code: surfaceBufferShader(entry.kind) });
  void module.getCompilationInfo().then((info) => {
    const errors = info.messages.filter((message) => message.type === "error");
    if (!errors.length) {
      entry.state = "ready";
      return;
    }
    entry.state = "failed";
    reportGpu(`[gpu] A material graph's shader does not compile, so it draws plain: ${errors[0].message}`);
  });
};

const compileEntry = (graph: MaterialGraph, sways: boolean): GraphEntry | null => {
  try {
    const compiled = compileGraphWgsl(graph, { sways });
    const known = entriesByKey.get(compiled.key);
    if (known) return known;
    const made: GraphEntry = { kind: makeKind(compiled), state: "pending" };
    entriesByKey.set(compiled.key, made);
    registerSurfaceKind((material) => graphSurfaceFor(material) === made.kind, made.kind);
    checkEntry(made);
    return made;
  } catch (error) {
    reportGpu("[gpu] A material graph cannot be put in WGSL, so it draws plain:", error);
    return null;
  }
};

const entryFor = (graph: MaterialGraph, sways: boolean): GraphEntry | null => {
  let entries = entriesByGraph.get(graph);
  if (!entries) entriesByGraph.set(graph, entries = {});
  const known = sways ? entries.wind : entries.still;
  if (known !== undefined) return known;
  const shape = `${materialGraphShape(graph)}#${graphLayers(graph).join(",")}#${materialGraphSettings(graph).keepOwnMaps ? "own" : "-"}#${sways ? "wind" : "still"}`;
  let entry = entriesByShape.get(shape);
  if (entry === undefined) {
    entry = compileEntry(graph, sways);
    entriesByShape.set(shape, entry);
  }
  if (sways) entries.wind = entry;
  else entries.still = entry;
  return entry;
};

/** The kind that draws a graph-shaded material now; null when it has no graph, or its kind is not fit to draw yet. */
export const graphSurfaceFor = (material: THREE.Material): SurfaceKind | null => {
  const graph = (material as THREE.MeshStandardMaterial).isMeshStandardMaterial ? boundMaterialGraph(material) : null;
  if (!graph) return null;
  const entry = entryFor(graph, windSwayOf(material) !== null);
  return entry?.state === "ready" ? entry.kind : null;
};
