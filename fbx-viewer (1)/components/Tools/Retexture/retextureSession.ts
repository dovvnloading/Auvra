import { useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { boundMaterialGraph } from '../../../runtime/materials/graphMaterial';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { describeProviderFailure, hostProviderService, type InferenceJob, type ProviderCapability, type ProviderModel } from '../../../services/HostProviderService';
import { estimateJobCost } from '../../../services/providerPricing';
import { picksFor } from '../../../services/providerPicks';
import { textureService } from '../../../services/TextureGenerationService';
import { overrideTextureFlipY, tagOverrideTexture, type MaterialOverrides, type MaterialTextureSlot } from '../../../utils/materialOverrides';
import { DEFAULT_KEEP, OriginalDetail, PaintedMap, ViewedDetail, type DetailMix, type Pixels } from './keepOriginal';
import { bakeNormals, bakePainted, bakeViews, renderViewSheet, SHEET_MEGAPIXELS, type ViewSheet } from './viewSheet';
import { limitMetal, limitSmoothness } from './surfaceLimits';
import { listModelParts, mapIsLaidOutOverObject, texturePicture, usedAreaOfPart, type ModelPart, type PartMaterial, type PictureSize } from './parts';

export type RetextureMode = 'restyle' | 'new' | 'whole';
export type TakeState = 'starting' | 'queued' | 'painting' | 'ready' | 'failed';
export type SurfaceRole = 'normal' | 'roughness' | 'metalness';

export const SURFACE_ROLES: readonly SurfaceRole[] = ['normal', 'roughness', 'metalness'];

/** A surface map that goes with a result. */
export interface SurfaceMap {
  role: SurfaceRole;
  jobId: string;
  previewAssetId: string;
  url: string;
  textureId?: string;
  /** What `url` holds where that is not the picture the model answered with, to keep. */
  finished?: Blob;
}

/** One result: everything asked for, whatever became of it. They stay until removed, to try on and compare. */
export interface Take {
  id: string;
  /** Counts up per part, as people refer to them. */
  number: number;
  partId: string;
  mode: RetextureMode;
  prompt: string;
  modelName: string;
  costMicroUsd: number | null;
  state: TakeState;
  jobId?: string;
  previewAssetId?: string;
  /** The picture as it stands, the original's detail put back. */
  url?: string;
  /** The picture as the model answered. */
  rawUrl?: string;
  /** What `url` holds, to keep. */
  finished?: Blob;
  /** The map a restyle was worked from. */
  source?: PictureSize & { url: string };
  /** The views of the object a model was shown, where it was not shown the map itself. Without `source`, they show its shape alone. */
  sheet?: ViewSheet;
  /** How much of that map's fine detail stays, from 0 to 1. */
  keepOriginal: number;
  size?: PictureSize;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** The project's texture this became, once kept. */
  textureId?: string;
  /** What the take was painted from, when not the part's original. */
  fromTake?: number;
  /** Stopped on request: however the job ends now, it needs no remark. */
  stopping?: boolean;
  maps: SurfaceMap[];
  mapsState: 'none' | 'making' | 'ready' | 'failed';
  mapsError?: string;
}

interface MaterialBaseline {
  material: PartMaterial;
  map: THREE.Texture | null;
  transparent: boolean;
  alphaTest: number;
  side: THREE.Side;
  forceSinglePass: boolean;
  color: THREE.Color | null;
  normalMap: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
  metalnessMap: THREE.Texture | null;
  roughness: number | undefined;
  metalness: number | undefined;
}

export interface SessionPart extends ModelPart {
  baseline: MaterialBaseline[];
  /** What the model's document says for these materials as the session began. */
  baselineOverrides: Record<string, string>;
  baselineMaterialOverrides: MaterialOverrides;
  /** A small picture of the original, and a larger one. */
  thumbnail: string | null;
  preview: string | null;
  size: PictureSize | null;
  takes: Take[];
  /** The take on the model now; null is the original. */
  worn: string | null;
  /** The take saved on the model; null is the original. */
  saved: string | null;
  /** The next take to finish goes on the model, unless another has been picked meanwhile. */
  followNext: boolean;
  nextNumber: number;
  showRequest: number;
  /** Whether its map is laid out across the object, once that has been worked out. */
  laidOut?: boolean;
}

export interface ModelSession {
  modelId: string;
  modelName: string;
  object: THREE.Object3D;
  parts: SessionPart[];
  activePartId: string | null;
  attached: boolean;
}

export interface PartComparison {
  drawBefore: () => void;
  drawAfter: () => void;
  /** Lets go of what only the comparison used. */
  end: () => void;
}

export interface GenerateRequest {
  mode: RetextureMode;
  prompt: string;
  model: ProviderModel | null;
  count: number;
}

/** What a part draws with, whichever result or original that is. */
interface PartLook {
  map: THREE.Texture | null;
  normal: THREE.Texture | null;
  roughness: THREE.Texture | null;
  metalness: THREE.Texture | null;
}

/** A result being mixed with its map: what the slider works on. Only one is held at a time, as they are large. */
interface TakeMix {
  detail: DetailMix;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  frame: ImageData;
  bakeTimer?: ReturnType<typeof setTimeout>;
}

/** What a part wore when this session began: its original, unless it had already been retextured when the project opened. */
export const startingLookName = (part: SessionPart): string => (Object.keys(part.baselineOverrides).length ? 'Current' : 'Original');

/** What a model is told along with the words, so that it edits the map it is given rather than paints a new one. */
export const restyleInstruction = (words: string): string =>
  `This is a flat texture map. Change all of its surface to: ${words.trim()}. Keep the exact same layout, shapes, seams, folds and positions, and keep areas that are darker or lighter than others darker or lighter. No new elements.`;

/** A picture's pixels, at the given size or else at its own. */
const pixelsOf = async (url: string, wantedWidth?: number, wantedHeight?: number): Promise<Pixels> => {
  const image = new Image();
  image.src = url;
  await image.decode();
  const width = wantedWidth ?? image.naturalWidth;
  const height = wantedHeight ?? image.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('The picture could not be read.');
  context.drawImage(image, 0, 0, width, height);
  return { width, height, data: context.getImageData(0, 0, width, height).data };
};

/** What a model is told along with the words when shown views of the object. */
export const viewsInstruction = (words: string): string =>
  `This image shows one object from six sides on a plain grey background. Change its surface to: ${words.trim()}, the same on every side. Keep its exact shape, outline, size and position in each view, and all of its markings and details. Keep the grey background. No new elements.`;

/** What a model is told along with the words when shown a part as a plain shape from every side. */
export const paintInstruction = (words: string): string =>
  `This image shows one object from six sides, as a plain clay model on a plain grey background. Paint its whole surface as: ${words.trim()}, with the real colours and materials that has, the same object on every side. Keep its exact shape, outline, size and position in each view. Even, shadowless light. Keep the grey background. No new elements and no text.`;

/** What a model is told along with the words when painting a picture of a surface for faces that share one map. */
export const surfaceInstruction = (words: string): string =>
  `A seamless texture of ${words.trim()}: the surface alone, seen straight on and filling the whole picture, in even, shadowless light. No objects, no perspective, no text.`;

const instructionOf = (take: Take): string => {
  if (take.mode === 'whole') return take.prompt;
  if (take.mode === 'new') return take.sheet ? paintInstruction(take.prompt) : surfaceInstruction(take.prompt);
  return take.sheet ? viewsInstruction(take.prompt) : restyleInstruction(take.prompt);
};

/** Models that earlier suggested themselves for each job of this tool, which are put aside once for the ones suggested now. */
const SUPERSEDED_MODELS: readonly [ProviderCapability, ReadonlySet<string>][] = [
  ['media.edit', new Set(['fal-ai/flux-2/flash/edit', 'fal-ai/flux-2/edit', 'fal-ai/flux-2-pro/edit', 'alibaba/qwen-image-3/edit', 'fal-ai/flux-2/klein/9b/edit'])],
  ['media.generate', new Set(['fal-ai/flux/schnell', 'fal-ai/flux/dev', 'fal-ai/flux-2', 'fal-ai/flux-2-pro'])],
  ['media.mesh', new Set(['meshy/v6-lite/retexture'])],
];
const CAPABLE_MODEL_NOTED = 'retexture.capableModel';

/** Long enough to let a slider come to rest before writing out the picture. */
const BAKE_DELAY_MS = 250;

/** The largest picture sent as a source. Providers bill by the megapixel and answer at the size they are sent. */
const MAX_SOURCE_EDGE = 2048;
const THUMBNAIL_EDGE = 96;
const PREVIEW_EDGE = 512;
/** What the host asks for a new picture at. */
const NEW_TEXTURE_MEGAPIXELS = 4;
/** The size of a map painted through views of an object. A model's answer is no sharper than its views, whatever this is. */
const PAINTED_MAP_EDGE = 2048;

/** The size a result's map is made at. Painted through views it holds more than a small map could, so that map grows to hold it, laid out as it was. */
export const resultMapSize = (source: PictureSize | undefined, throughViews: boolean): PictureSize => {
  if (!source) return { width: PAINTED_MAP_EDGE, height: PAINTED_MAP_EDGE };
  if (!throughViews) return { width: source.width, height: source.height };
  const grow = Math.max(1, PAINTED_MAP_EDGE / Math.max(source.width, source.height));
  return { width: Math.round(source.width * grow), height: Math.round(source.height * grow) };
};
const MAX_LIBRARY_NAME = 128;
/** Which model makes surface maps, where a provider has one. */
const MAPS_PROVIDER = 'fal';

/** A name for a kept texture that says where it came from. Project names may not hold what a file path could not. */
export const libraryName = (modelName: string, partName: string, prompt: string, suffix = ''): string => {
  const name = `${modelName} ${partName} - ${prompt}`.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const room = MAX_LIBRARY_NAME - suffix.length;
  return `${name.length > room ? `${name.slice(0, room - 1).trimEnd()}…` : name}${suffix}`;
};

const CAPABILITY_OF: Record<RetextureMode, ProviderCapability> = { restyle: 'media.edit', new: 'media.generate', whole: 'media.mesh' };

/** The AI capability a way of working goes through. */
export const capabilityOfMode = (mode: RetextureMode): ProviderCapability => CAPABILITY_OF[mode];

const stateOfJob = (status: InferenceJob['status']): TakeState => (status === 'queued' || status === 'submitting' ? 'queued' : 'painting');

const SLOT_OF: Record<SurfaceRole, MaterialTextureSlot> = { normal: 'normal', roughness: 'roughness', metalness: 'metalness' };
const OVERRIDE_FIELD_OF = { normal: 'normalTextureId', roughness: 'roughnessTextureId', metalness: 'metalnessTextureId' } as const;

/** Puts a look on a part's materials, recompiling only what needs it. */
const applyLook = (part: SessionPart, look: PartLook | null) => {
  for (const base of part.baseline) {
    const material = base.material;
    const map = look ? look.map : base.map;
    const normal = look?.normal ?? base.normalMap;
    const roughness = look?.roughness ?? base.roughnessMap;
    const metalness = look?.metalness ?? base.metalnessMap;
    // As a saved override is put on when the project opens, so what is tried on is what comes back.
    const transparent = look ? true : base.transparent;
    const alphaTest = look ? 0.5 : base.alphaTest;
    const side = look ? THREE.DoubleSide : base.side;
    const needsCompile = Boolean(material.map) !== Boolean(map)
      || Boolean(material.normalMap) !== Boolean(normal)
      || Boolean(material.roughnessMap) !== Boolean(roughness)
      || Boolean(material.metalnessMap) !== Boolean(metalness)
      || material.transparent !== transparent || material.alphaTest !== alphaTest || material.side !== side;
    material.map = map;
    material.normalMap = normal;
    material.roughnessMap = roughness;
    material.metalnessMap = metalness;
    material.transparent = transparent;
    material.alphaTest = alphaTest;
    material.side = side;
    material.forceSinglePass = look ? true : base.forceSinglePass;
    // A plain colour tinted nothing until now; a painted texture shows its own colours.
    if (look && !base.map) material.color?.set(0xffffff);
    else if (base.color) material.color?.copy(base.color);
    if (base.roughness !== undefined) material.roughness = look?.roughness ? 1 : base.roughness;
    if (base.metalness !== undefined) material.metalness = look?.metalness ? 1 : base.metalness;
    if (needsCompile) material.needsUpdate = true;
  }
};

/** The Retexture workspace's state: outlives the tab, so jobs keep running and results stay while working elsewhere. */
class RetextureSessions {
  private sessions = new Map<string, ModelSession>();
  private textures = new Map<string, THREE.Texture>();
  private listeners = new Set<() => void>();
  private version = 0;
  private sequence = 0;
  /** Estimated from catalog prices, as provider accounts cannot be read: only what finished. */
  spentMicroUsd = 0;
  /** What a new result keeps of its map: wherever the slider was last left. */
  keepForNext = DEFAULT_KEEP;
  private mixing: { take: Take; ready: Promise<TakeMix> } | null = null;
  runs = 0;
  /** Finished runs whose price was not known at the time, so the total leaves them out. */
  unpricedRuns = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getVersion = () => this.version;

  private changed() {
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }

  /** The session of a model as it stands. A model loaded anew has new materials, so its old session is over. */
  open(modelId: string, modelName: string, object: THREE.Object3D, overrides: Record<string, string> | undefined, materialOverrides: MaterialOverrides | undefined): ModelSession {
    const existing = this.sessions.get(modelId);
    if (existing?.object === object) return existing;
    if (existing) this.drop(existing);
    const parts = listModelParts(object).map((part): SessionPart => {
      const picture = part.texture ? texturePicture(part.texture, THUMBNAIL_EDGE, 'image/jpeg', overrideTextureFlipY(object)) : null;
      return {
        ...part,
        baseline: part.materials.map((material) => ({
          material,
          map: material.map ?? null,
          transparent: material.transparent,
          alphaTest: material.alphaTest,
          side: material.side,
          forceSinglePass: material.forceSinglePass,
          color: material.color?.clone() ?? null,
          normalMap: material.normalMap ?? null,
          roughnessMap: material.roughnessMap ?? null,
          metalnessMap: material.metalnessMap ?? null,
          roughness: material.roughness,
          metalness: material.metalness,
        })),
        baselineOverrides: Object.fromEntries(part.materialNames.flatMap((name) => (overrides?.[name] ? [[name, overrides[name]]] : []))),
        baselineMaterialOverrides: Object.fromEntries(part.materialNames.flatMap((name) => (materialOverrides?.[name] ? [[name, materialOverrides[name]]] : []))),
        thumbnail: picture?.url ?? null,
        preview: null,
        size: part.texture ? sizeOf(part.texture) : null,
        takes: [],
        worn: null,
        saved: null,
        followNext: false,
        nextNumber: 1,
        showRequest: 0,
      };
    });
    const session: ModelSession = { modelId, modelName, object, parts, activePartId: parts.find((part) => part.texture)?.id ?? parts[0]?.id ?? null, attached: false };
    this.sessions.set(modelId, session);
    return session;
  }

  /** The workspace now shows this model: anything being tried on goes back on. */
  attach(session: ModelSession) {
    session.attached = true;
    for (const part of session.parts) if (part.worn !== part.saved) void this.show(session, part, part.worn);
  }

  /** The model is being shown elsewhere too: only what was saved stays on it. */
  detach(session: ModelSession) {
    session.attached = false;
    for (const part of session.parts) if (part.worn !== part.saved) void this.show(session, part, part.saved);
  }

  setActivePart(session: ModelSession, partId: string) {
    session.activePartId = partId;
    this.changed();
  }

  /** The large picture of a part's original, made when first asked for. */
  previewOf(session: ModelSession, part: SessionPart): string | null {
    if (!part.preview && part.texture) part.preview = texturePicture(part.texture, PREVIEW_EDGE, 'image/jpeg', overrideTextureFlipY(session.object))?.url ?? null;
    return part.preview;
  }

  /** Puts a take on the model, or the original with null. */
  wear(session: ModelSession, part: SessionPart, takeId: string | null, picked = true) {
    part.worn = takeId;
    if (picked) part.followNext = false;
    this.changed();
    if (session.attached) void this.show(session, part, takeId);
  }

  private async load(key: string, url: string, session: ModelSession, colour: boolean): Promise<THREE.Texture> {
    const known = this.textures.get(key);
    if (known) return known;
    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    // The same way round as a stored override is put on when the project opens.
    texture.flipY = overrideTextureFlipY(session.object);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    this.textures.set(key, texture);
    return texture;
  }

  /** The texture a take draws with, loaded once. */
  async textureOf(session: ModelSession, take: Take): Promise<THREE.Texture | null> {
    return take.url ? this.load(take.id, take.url, session, true) : null;
  }

  /** Everything a take draws with, loaded once. */
  private async lookOf(session: ModelSession, take: Take): Promise<PartLook | null> {
    const map = await this.textureOf(session, take);
    if (!map) return null;
    const of = async (role: SurfaceRole) => {
      const surface = take.maps.find((item) => item.role === role);
      return surface ? this.load(`${take.id}:${role}`, surface.url, session, false) : null;
    };
    const [normal, roughness, metalness] = await Promise.all([of('normal'), of('roughness'), of('metalness')]);
    return { map, normal, roughness, metalness };
  }

  private async show(session: ModelSession, part: SessionPart, takeId: string | null) {
    part.showRequest += 1;
    const request = part.showRequest;
    const take = takeId ? part.takes.find((item) => item.id === takeId) : null;
    if (!take) {
      applyLook(part, null);
      return;
    }
    const look = await this.lookOf(session, take);
    if (look && request === part.showRequest) applyLook(part, look);
  }

  /**
   * Both sides of a before and after on a part, drawn within every frame. The before side has materials of its own:
   * changing a material's look makes it recompile, where swapping one for another costs nothing.
   * One shaded by a material asset draws the same either way, so it stays as it is.
   */
  comparison(session: ModelSession, part: SessionPart): PartComparison {
    const before = new Map<THREE.Material, PartMaterial>();
    for (const base of part.baseline) {
      if (boundMaterialGraph(base.material)) continue;
      const copy = base.material.clone() as PartMaterial;
      copy.map = base.map;
      copy.normalMap = base.normalMap;
      copy.roughnessMap = base.roughnessMap;
      copy.metalnessMap = base.metalnessMap;
      copy.transparent = base.transparent;
      copy.alphaTest = base.alphaTest;
      copy.side = base.side;
      copy.forceSinglePass = base.forceSinglePass;
      if (base.color) copy.color?.copy(base.color);
      if (base.roughness !== undefined) copy.roughness = base.roughness;
      if (base.metalness !== undefined) copy.metalness = base.metalness;
      before.set(base.material, copy);
    }
    const meshes: THREE.Mesh[] = [];
    session.object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh && (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some((material) => before.has(material))) meshes.push(mesh);
    });
    const originals = meshes.map((mesh) => mesh.material);
    return {
      drawBefore: () => {
        // Which part is being pointed at shows on both sides.
        for (const [material, copy] of before) {
          const glow = material as PartMaterial;
          if (glow.emissive) copy.emissive?.copy(glow.emissive);
          if (glow.emissiveIntensity !== undefined) copy.emissiveIntensity = glow.emissiveIntensity;
        }
        meshes.forEach((mesh, index) => {
          const own = originals[index];
          mesh.material = Array.isArray(own) ? own.map((material) => before.get(material) ?? material) : before.get(own) ?? own;
        });
      },
      drawAfter: () => { meshes.forEach((mesh, index) => { mesh.material = originals[index]; }); },
      end: () => { before.forEach((copy) => copy.dispose()); },
    };
  }

  /** What a restyle starts from: what is on the part now, at a size that is sensible to send. */
  private async sourceOf(session: ModelSession, part: SessionPart): Promise<{ picture: { url: string; width: number; height: number } | null; fromTake?: number }> {
    const take = part.worn ? part.takes.find((item) => item.id === part.worn && item.state === 'ready') : null;
    const texture = take ? await this.textureOf(session, take) : part.texture;
    return { picture: texture ? texturePicture(texture, MAX_SOURCE_EDGE, 'image/png', overrideTextureFlipY(session.object)) : null, fromTake: take?.number };
  }

  /** What one run of a model would come to, or null while the price is not known. */
  estimate(request: Pick<GenerateRequest, 'mode' | 'model'>, onObject = request.mode === 'restyle'): number | null {
    if (!request.model) return null;
    return estimateJobCost(request.model, onObject ? SHEET_MEGAPIXELS : NEW_TEXTURE_MEGAPIXELS);
  }

  /** Whether painting a part from nothing goes through views of the object, which a model edits, or is one picture of a surface. */
  paintsOnObject(session: ModelSession, part: SessionPart): boolean {
    part.laidOut ??= mapIsLaidOutOverObject(session.object, part);
    return part.laidOut;
  }

  async generate(session: ModelSession, part: SessionPart, request: GenerateRequest): Promise<void> {
    let source: Promise<string | null> = Promise.resolve(null);
    let fromTake: number | undefined;
    let picture: Take['source'];
    let sheet: ViewSheet | undefined;
    if (request.mode === 'restyle') {
      const found = await this.sourceOf(session, part);
      if (!found.picture) throw new Error('This part has no texture to restyle. Paint a new one from a description.');
      fromTake = found.fromTake;
      picture = found.picture;
      // A map that repeats or that faces share is a picture of a surface, which a model can edit as it is; one laid out on a model is not.
      sheet = this.paintsOnObject(session, part) ? renderViewSheet(session.object, part) ?? undefined : undefined;
      source = textureService.ingestLocalAsset(sheet?.picture ?? found.picture.url);
    } else if (request.mode === 'whole') {
      source = textureService.modelFileAsset(session.modelId);
    } else if (this.paintsOnObject(session, part)) {
      sheet = renderViewSheet(session.object, part, { asShape: true }) ?? undefined;
      if (!sheet) throw new Error('This part could not be drawn to paint it.');
      source = textureService.ingestLocalAsset(sheet.picture);
    }
    const cost = this.estimate(request, Boolean(sheet) || request.mode === 'restyle');
    part.followNext = true;
    for (let index = 0; index < request.count; index += 1) {
      this.sequence += 1;
      const take: Take = {
        id: `take-${this.sequence}`,
        number: part.nextNumber,
        partId: part.id,
        mode: request.mode,
        prompt: request.prompt,
        modelName: request.model?.name || request.model?.id || 'Model',
        costMicroUsd: cost,
        state: 'starting',
        startedAt: Date.now(),
        fromTake,
        source: picture,
        sheet,
        keepOriginal: this.keepForNext,
        maps: [],
        mapsState: 'none',
      };
      part.nextNumber += 1;
      part.takes.push(take);
      void this.run(session, part, take, source);
    }
    this.changed();
  }

  private async run(session: ModelSession, part: SessionPart, take: Take, source: Promise<string | null>) {
    try {
      const job = await textureService.submit(await source, instructionOf(take), take.sheet ? 'media.edit' : capabilityOfMode(take.mode));
      take.jobId = job.jobId;
      const preview = await textureService.follow(job, (current) => {
        const state = stateOfJob(current.status);
        if (take.state !== state) { take.state = state; this.changed(); }
      });
      take.previewAssetId = preview.previewAssetId;
      take.rawUrl = preview.previewUrl;
      take.url = preview.previewUrl;
      take.size = preview.dimensions;
      if (take.source || take.sheet) await this.finish(session, part, take);
      // A whole-model job makes the surface maps along with the colour.
      take.maps = surfaceMapsOf(job.jobId, preview.maps);
      take.mapsState = take.maps.length ? 'ready' : 'none';
      take.state = 'ready';
      take.finishedAt = Date.now();
      this.count(take.costMicroUsd);
      if (part.followNext) {
        part.followNext = false;
        this.wear(session, part, take.id, false);
      }
    } catch (error) {
      take.finishedAt = Date.now();
      const code = (error as { code?: string }).code;
      if (code === 'cancelled' || take.stopping) { this.forget(part, take); return; }
      frontendDiagnostics.failure('retexture_take_failed', error);
      take.state = 'failed';
      take.error = describeProviderFailure(error instanceof Error ? error.message : undefined) || 'The texture could not be made.';
    }
    this.changed();
  }

  /** The result and its map, ready to mix: worked out when first asked for, and let go of when another is. */
  private mixOf(session: ModelSession, part: SessionPart, take: Take): Promise<TakeMix> {
    if (this.mixing?.take === take) return this.mixing.ready;
    const ready = (async (): Promise<TakeMix> => {
      if ((!take.source && !take.sheet) || !take.rawUrl) throw new Error('This result can no longer be read.');
      const { width, height } = resultMapSize(take.source, Boolean(take.sheet));
      const original = take.source ? await pixelsOf(take.source.url, width, height) : null;
      const used = original ? usedAreaOfPart(session.object, part, width, height) : null;
      let detail: DetailMix;
      if (take.sheet) {
        const answer = await pixelsOf(take.rawUrl);
        if (original) {
          const baked = bakeViews(session.object, part, take.sheet, answer, width, height);
          if (!baked) throw new Error('The result could not be put back on the map.');
          detail = new ViewedDetail(original.data, baked.broad, baked.before, baked.painted, used, width);
        } else {
          const baked = bakePainted(session.object, part, take.sheet, answer, width, height);
          if (!baked) throw new Error('The result could not be put back on the map.');
          detail = new PaintedMap(baked, width, height);
        }
      } else {
        detail = await OriginalDetail.prepare(original!, await pixelsOf(take.rawUrl, width, height), used);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('The picture could not be made.');
      return { detail, canvas, context, frame: context.createImageData(width, height) };
    })();
    this.mixing = { take, ready };
    return ready;
  }

  private paint(mix: TakeMix, take: Take) {
    mix.detail.mix(take.keepOriginal, mix.frame.data);
    mix.context.putImageData(mix.frame, 0, 0);
  }

  /** Writes out the picture as it stands, for the panels and for keeping. */
  private async bake(mix: TakeMix, take: Take) {
    const blob = await new Promise<Blob | null>((resolve) => { mix.canvas.toBlob(resolve, 'image/png'); });
    if (!blob) throw new Error('The picture could not be made.');
    const before = take.url;
    take.finished = blob;
    take.url = URL.createObjectURL(blob);
    take.size = { width: mix.canvas.width, height: mix.canvas.height };
    if (before && before !== take.rawUrl) URL.revokeObjectURL(before);
  }

  /** Puts the model's answer back over the map it was given. */
  private async finish(session: ModelSession, part: SessionPart, take: Take) {
    const mix = await this.mixOf(session, part, take);
    this.paint(mix, take);
    await this.bake(mix, take);
  }

  /** Changes how much of its map's fine detail a result keeps. Nothing goes to a provider, so this costs nothing. */
  async setKeepOriginal(session: ModelSession, part: SessionPart, take: Take, keep: number) {
    take.keepOriginal = keep;
    this.keepForNext = keep;
    // What was kept before is another picture now.
    take.textureId = undefined;
    this.changed();
    const mix = await this.mixOf(session, part, take);
    this.paint(mix, take);
    const shown = this.textures.get(take.id);
    if (shown?.image === mix.canvas) {
      shown.needsUpdate = true;
    } else {
      const live = new THREE.CanvasTexture(mix.canvas);
      live.colorSpace = THREE.SRGBColorSpace;
      live.flipY = overrideTextureFlipY(session.object);
      live.wrapS = THREE.RepeatWrapping;
      live.wrapT = THREE.RepeatWrapping;
      this.textures.set(take.id, live);
      if (part.worn === take.id && session.attached) await this.show(session, part, take.id);
      shown?.dispose();
    }
    if (mix.bakeTimer) clearTimeout(mix.bakeTimer);
    mix.bakeTimer = setTimeout(() => {
      mix.bakeTimer = undefined;
      void this.bake(mix, take).then(() => this.changed(), (error) => frontendDiagnostics.failure('retexture_bake_failed', error));
    }, BAKE_DELAY_MS);
  }

  /** The picture to keep, with anything still waiting to be written out written. */
  private async finishedPicture(take: Take): Promise<Blob | undefined> {
    if (this.mixing?.take === take) {
      const mix = await this.mixing.ready;
      if (mix.bakeTimer) {
        clearTimeout(mix.bakeTimer);
        mix.bakeTimer = undefined;
        await this.bake(mix, take);
      }
    }
    return take.finished;
  }

  async cancel(take: Take) {
    if (!take.jobId) return;
    take.stopping = true;
    this.changed();
    await textureService.cancel(take.jobId);
  }

  /** Puts each of this tool's jobs on a capable model where it has none, or once where it is on one chosen for it before those were known. */
  async chooseCapableModel() {
    for (const [capability, superseded] of SUPERSEDED_MODELS) {
      try {
        const pick = picksFor(MAPS_PROVIDER, capability, await hostProviderService.listModels(MAPS_PROVIDER, capability))[0];
        if (!pick) continue;
        const route = await hostProviderService.loadConfiguredRoute(capability);
        const key = `${CAPABLE_MODEL_NOTED}.${capability}`;
        let noted = false;
        try { noted = localStorage.getItem(key) === pick.id; } catch { /* Then it is put forward again next time, and that is all. */ }
        if (route && (noted || !superseded.has(route.modelId))) continue;
        await hostProviderService.routeCapability(MAPS_PROVIDER, capability, pick.id);
        try { localStorage.setItem(key, pick.id); } catch { /* As above. */ }
      } catch (error) {
        frontendDiagnostics.failure('retexture_model_choice_failed', error);
      }
    }
  }

  /** The model that makes surface maps where there is one, which the workspace shows the price of. */
  async mapsModel(): Promise<ProviderModel | null> {
    const models = await hostProviderService.listModels(MAPS_PROVIDER, 'media.maps').catch(() => [] as ProviderModel[]);
    return models[0] ?? null;
  }

  /** The size of what a model is shown to make surface maps for a result of this size, for what that comes to. */
  mapsMegapixels(session: ModelSession, part: SessionPart, size: PictureSize | undefined): number | undefined {
    if (this.paintsOnObject(session, part)) return SHEET_MEGAPIXELS;
    return size ? (Math.min(size.width, MAX_SOURCE_EDGE) * Math.min(size.height, MAX_SOURCE_EDGE)) / 1_000_000 : undefined;
  }

  /** Makes the surface maps a model answered with fit the result they are for: put back on the map through the cameras that made a sheet, and held to what its colours can bear. */
  private async finishSurfaces(session: ModelSession, part: SessionPart, take: Take, sheet: ViewSheet | null, maps: readonly SurfaceMap[]) {
    const { width, height } = take.size ?? resultMapSize(take.source, Boolean(sheet));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('The picture could not be made.');
    const frames = new Map<SurfaceMap, ImageData>();
    for (const surface of maps) {
      const frame = context.createImageData(width, height);
      if (sheet) {
        const answer = await pixelsOf(surface.url);
        const bake = surface.role === 'normal' ? bakeNormals : bakePainted;
        const baked = bake(session.object, part, sheet, answer, width, height);
        if (!baked) throw new Error('The surface maps could not be put back on the map.');
        new PaintedMap(baked, width, height).mix(0, frame.data);
      } else {
        frame.data.set((await pixelsOf(surface.url, width, height)).data);
      }
      frames.set(surface, frame);
    }
    const metal = maps.find((surface) => surface.role === 'metalness');
    const metalFrame = metal ? frames.get(metal)!.data : null;
    if (metalFrame && take.url) limitMetal(metalFrame, (await pixelsOf(take.url, width, height)).data);
    const roughness = maps.find((surface) => surface.role === 'roughness');
    if (roughness) limitSmoothness(frames.get(roughness)!.data, metalFrame);
    for (const surface of maps) {
      context.putImageData(frames.get(surface)!, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/png'); });
      if (!blob) throw new Error('The picture could not be made.');
      URL.revokeObjectURL(surface.url);
      surface.finished = blob;
      surface.url = URL.createObjectURL(blob);
    }
  }

  /** Makes normal, roughness and metal maps from a result's colours, for the same parts of the picture to catch the light. */
  async makeMaps(session: ModelSession, part: SessionPart, take: Take, model: ProviderModel) {
    take.mapsState = 'making';
    take.mapsError = undefined;
    this.changed();
    try {
      const texture = await this.textureOf(session, take);
      if (!texture) throw new Error('This result can no longer be read.');
      // As with colour, a map cut into pieces means little as a picture: each piece comes back judged on its own.
      const sheet = this.paintsOnObject(session, part) ? renderViewSheet(session.object, part, { map: texture }) : null;
      const picture = sheet ? null : texturePicture(texture, MAX_SOURCE_EDGE);
      if (!sheet && !picture) throw new Error('This result can no longer be read.');
      const asset = await textureService.ingestLocalAsset(sheet?.picture ?? picture!.url);
      const route = await hostProviderService.loadConfiguredRoute('media.maps');
      if (route?.modelId !== model.id) await hostProviderService.routeCapability(MAPS_PROVIDER, 'media.maps', model.id);
      const job = await textureService.submit(asset, 'Surface maps for this texture', 'media.maps');
      const preview = await textureService.follow(job);
      const maps = surfaceMapsOf(job.jobId, preview.maps);
      await this.finishSurfaces(session, part, take, sheet, maps);
      take.maps = maps;
      take.mapsState = 'ready';
      this.count(estimateJobCost(model, this.mapsMegapixels(session, part, take.size)));
      if (part.worn === take.id && session.attached) void this.show(session, part, take.id);
    } catch (error) {
      frontendDiagnostics.failure('retexture_maps_failed', error);
      take.mapsState = 'failed';
      take.mapsError = describeProviderFailure(error instanceof Error ? error.message : undefined) || 'The surface maps could not be made.';
    }
    this.changed();
  }

  private count(costMicroUsd: number | null) {
    this.runs += 1;
    if (costMicroUsd === null) this.unpricedRuns += 1;
    else this.spentMicroUsd += costMicroUsd;
  }

  private forget(part: SessionPart, take: Take) {
    part.takes = part.takes.filter((item) => item !== take);
    if (this.mixing?.take === take) this.mixing = null;
    if (take.url) URL.revokeObjectURL(take.url);
    if (take.rawUrl && take.rawUrl !== take.url) URL.revokeObjectURL(take.rawUrl);
    this.disposeTextures(take);
    for (const surface of take.maps) URL.revokeObjectURL(surface.url);
    this.changed();
  }

  private disposeTextures(take: Take) {
    for (const key of [take.id, ...SURFACE_ROLES.map((role) => `${take.id}:${role}`)]) {
      this.textures.get(key)?.dispose();
      this.textures.delete(key);
    }
  }

  /** Takes a result out of the strip. One saved on the model stays until something else replaces it. */
  async remove(session: ModelSession, part: SessionPart, take: Take) {
    if (part.saved === take.id) return;
    if (part.worn === take.id) this.wear(session, part, part.saved);
    // Let the host know after the texture is off the model: its preview goes with this, and one kept in the library has none.
    const discardable = take.state === 'ready' && !take.textureId && take.jobId && take.previewAssetId;
    const unkept = take.maps.filter((surface) => !surface.textureId);
    this.forget(part, take);
    if (discardable) await textureService.discard(take.jobId!, take.previewAssetId!).catch(() => undefined);
    await Promise.all(unkept.map((surface) => textureService.discard(surface.jobId, surface.previewAssetId).catch(() => undefined)));
  }

  /** Tells the library of a texture kept here. The workspace sets it. */
  onTextureKept: (id: string, name: string, dimensions: PictureSize) => Promise<void> = async () => undefined;

  /** Keeps a take in the project's texture library, once, with any surface maps it has. */
  async keep(session: ModelSession, part: SessionPart, take: Take): Promise<string> {
    if (!take.jobId || !take.previewAssetId) throw new Error('This result is no longer available.');
    const dimensions = take.size ?? part.size ?? { width: 1024, height: 1024 };
    const name = libraryName(session.modelName, part.name, take.prompt);
    if (!take.textureId) {
      const finished = await this.finishedPicture(take);
      const finishedAssetId = finished ? await textureService.ingestPicture(finished) : null;
      await textureService.commit(take.jobId, take.previewAssetId, { name, ...(finishedAssetId ? { finishedAssetId, textureId: finishedAssetId } : {}) });
      take.textureId = finishedAssetId ?? take.previewAssetId;
      await this.onTextureKept(take.textureId, name, dimensions);
    }
    for (const surface of take.maps) {
      if (surface.textureId) continue;
      const surfaceName = libraryName(session.modelName, part.name, take.prompt, ` ${surface.role}`);
      const finishedAssetId = surface.finished ? await textureService.ingestPicture(surface.finished) : null;
      await textureService.commit(surface.jobId, surface.previewAssetId, { name: surfaceName, ...(finishedAssetId ? { finishedAssetId, textureId: finishedAssetId } : {}) });
      surface.textureId = finishedAssetId ?? surface.previewAssetId;
      await this.onTextureKept(surface.textureId, surfaceName, dimensions);
    }
    this.changed();
    return take.textureId;
  }

  /**
   * Saves a take on the model, or with null what the part had when the session began. `persist` and `persistMaterials`
   * record the model's documents as they should now stand.
   */
  async saveOnModel(
    session: ModelSession,
    part: SessionPart,
    take: Take | null,
    current: { overrides: Record<string, string> | undefined; materials: MaterialOverrides | undefined },
    persist: (overrides: Record<string, string>) => Promise<void>,
    persistMaterials: (overrides: MaterialOverrides) => Promise<void>,
  ) {
    const overrides = { ...(current.overrides ?? {}) };
    const textureId = take ? await this.keep(session, part, take) : null;
    for (const name of part.materialNames) {
      const value = textureId ?? part.baselineOverrides[name];
      if (value) overrides[name] = value;
      else delete overrides[name];
    }
    await persist(overrides);

    const materials = { ...(current.materials ?? {}) };
    let materialsChanged = false;
    for (const name of part.materialNames) {
      const entry = { ...(materials[name] ?? {}) };
      for (const role of SURFACE_ROLES) {
        const field = OVERRIDE_FIELD_OF[role];
        const surface = take?.maps.find((item) => item.role === role);
        const value = surface?.textureId ?? part.baselineMaterialOverrides[name]?.[field];
        if (entry[field] === value) continue;
        materialsChanged = true;
        if (value) entry[field] = value;
        else delete entry[field];
      }
      if (Object.keys(entry).length) materials[name] = entry;
      else delete materials[name];
    }
    if (take) {
      // So that applying the overrides finds them already on the materials, rather than loading them again.
      const flipY = overrideTextureFlipY(session.object);
      for (const surface of take.maps) {
        const texture = this.textures.get(`${take.id}:${surface.role}`);
        if (texture && surface.textureId) tagOverrideTexture(texture, surface.textureId, SLOT_OF[surface.role], flipY);
      }
    }
    if (materialsChanged) await persistMaterials(materials);
    part.saved = take?.id ?? null;
    this.wear(session, part, part.saved);
  }

  /** The project closed or changed: its previews are gone and its models are no longer in use. */
  reset() {
    for (const session of [...this.sessions.values()]) this.drop(session);
    this.sessions.clear();
    this.spentMicroUsd = 0;
    this.runs = 0;
    this.unpricedRuns = 0;
    this.changed();
  }

  private drop(session: ModelSession) {
    for (const part of session.parts) {
      for (const take of part.takes) {
        if (take.url) URL.revokeObjectURL(take.url);
        for (const surface of take.maps) URL.revokeObjectURL(surface.url);
        this.disposeTextures(take);
      }
    }
    this.sessions.delete(session.modelId);
  }
}

const surfaceMapsOf = (jobId: string, maps: readonly { role: string; previewAssetId: string; previewUrl: string }[] | undefined): SurfaceMap[] => (maps ?? [])
  .filter((item): item is { role: SurfaceRole; previewAssetId: string; previewUrl: string } => (SURFACE_ROLES as readonly string[]).includes(item.role))
  .map((item) => ({ role: item.role, jobId, previewAssetId: item.previewAssetId, url: item.previewUrl }));

const sizeOf = (texture: THREE.Texture): PictureSize | null => {
  const image = texture.image as { width?: number; height?: number } | undefined;
  return image?.width && image.height ? { width: image.width, height: image.height } : null;
};

export const retextureSessions = new RetextureSessions();

/** Re-renders when any session changes. The sessions themselves are read directly. */
export const useRetextureSessions = () => {
  useSyncExternalStore(retextureSessions.subscribe, retextureSessions.getVersion);
  return retextureSessions;
};
