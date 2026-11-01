import { useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { describeProviderFailure, hostProviderService, type InferenceJob, type ProviderCapability, type ProviderModel } from '../../../services/HostProviderService';
import { estimateJobCost } from '../../../services/providerPricing';
import { textureService } from '../../../services/TextureGenerationService';
import { overrideTextureFlipY, tagOverrideTexture, type MaterialOverrides, type MaterialTextureSlot } from '../../../utils/materialOverrides';
import { listModelParts, texturePicture, type ModelPart, type PartMaterial, type PictureSize } from './parts';

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
  url?: string;
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
}

export interface ModelSession {
  modelId: string;
  modelName: string;
  object: THREE.Object3D;
  parts: SessionPart[];
  activePartId: string | null;
  attached: boolean;
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

/** The largest picture sent as a source. Providers bill by the megapixel and answer at the size they are sent. */
const MAX_SOURCE_EDGE = 2048;
const THUMBNAIL_EDGE = 96;
const PREVIEW_EDGE = 512;
const NEW_TEXTURE_MEGAPIXELS = 1.05;
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
      const picture = part.texture ? texturePicture(part.texture, THUMBNAIL_EDGE, 'image/jpeg') : null;
      return {
        ...part,
        baseline: part.materials.map((material) => ({
          material,
          map: material.map ?? null,
          transparent: material.transparent,
          alphaTest: material.alphaTest,
          side: material.side,
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
  previewOf(part: SessionPart): string | null {
    if (!part.preview && part.texture) part.preview = texturePicture(part.texture, PREVIEW_EDGE, 'image/jpeg')?.url ?? null;
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

  /** Draws a part as it was, or with what it wears, within a frame, for before and after. Only with everything already loaded. */
  showNow(part: SessionPart, take: Take | null) {
    if (!take) { applyLook(part, null); return; }
    const map = this.textures.get(take.id);
    if (!map) return;
    const of = (role: SurfaceRole) => this.textures.get(`${take.id}:${role}`) ?? null;
    applyLook(part, { map, normal: of('normal'), roughness: of('roughness'), metalness: of('metalness') });
  }

  /** What a restyle starts from: what is on the part now, at a size that is sensible to send. */
  private async sourceOf(session: ModelSession, part: SessionPart): Promise<{ picture: { url: string; width: number; height: number } | null; fromTake?: number }> {
    const take = part.worn ? part.takes.find((item) => item.id === part.worn && item.state === 'ready') : null;
    const texture = take ? await this.textureOf(session, take) : part.texture;
    return { picture: texture ? texturePicture(texture, MAX_SOURCE_EDGE) : null, fromTake: take?.number };
  }

  private megapixelsOf(part: SessionPart | null): number {
    if (!part?.size) return NEW_TEXTURE_MEGAPIXELS;
    const scale = Math.min(1, MAX_SOURCE_EDGE / Math.max(part.size.width, part.size.height));
    return (part.size.width * scale * part.size.height * scale) / 1_000_000;
  }

  /** What one run of a model would come to on this part, or null while the price is not known. */
  estimate(part: SessionPart | null, request: Pick<GenerateRequest, 'mode' | 'model'>): number | null {
    if (!request.model) return null;
    return estimateJobCost(request.model, request.mode === 'restyle' ? this.megapixelsOf(part) : NEW_TEXTURE_MEGAPIXELS);
  }

  async generate(session: ModelSession, part: SessionPart, request: GenerateRequest): Promise<void> {
    let source: Promise<string | null> = Promise.resolve(null);
    let fromTake: number | undefined;
    if (request.mode === 'restyle') {
      const found = await this.sourceOf(session, part);
      if (!found.picture) throw new Error('This part has no texture to restyle. Paint a new one from a description.');
      fromTake = found.fromTake;
      source = textureService.ingestLocalAsset(found.picture.url);
    } else if (request.mode === 'whole') {
      source = textureService.modelFileAsset(session.modelId);
    }
    const cost = this.estimate(part, request);
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
      const job = await textureService.submit(await source, take.prompt, capabilityOfMode(take.mode));
      take.jobId = job.jobId;
      const preview = await textureService.follow(job, (current) => {
        const state = stateOfJob(current.status);
        if (take.state !== state) { take.state = state; this.changed(); }
      });
      take.previewAssetId = preview.previewAssetId;
      take.url = preview.previewUrl;
      take.size = preview.dimensions;
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

  async cancel(take: Take) {
    if (!take.jobId) return;
    take.stopping = true;
    this.changed();
    await textureService.cancel(take.jobId);
  }

  /** The model that makes surface maps where there is one, which the workspace shows the price of. */
  async mapsModel(): Promise<ProviderModel | null> {
    const models = await hostProviderService.listModels(MAPS_PROVIDER, 'media.maps').catch(() => [] as ProviderModel[]);
    return models[0] ?? null;
  }

  /** Makes normal, roughness and metal maps from a result's colours, for the same parts of the picture to catch the light. */
  async makeMaps(session: ModelSession, part: SessionPart, take: Take, model: ProviderModel) {
    take.mapsState = 'making';
    take.mapsError = undefined;
    this.changed();
    try {
      const texture = await this.textureOf(session, take);
      const picture = texture ? texturePicture(texture, MAX_SOURCE_EDGE) : null;
      if (!picture) throw new Error('This result can no longer be read.');
      const asset = await textureService.ingestLocalAsset(picture.url);
      const route = await hostProviderService.loadConfiguredRoute('media.maps');
      if (route?.modelId !== model.id) await hostProviderService.routeCapability(MAPS_PROVIDER, 'media.maps', model.id);
      const job = await textureService.submit(asset, 'Surface maps for this texture', 'media.maps');
      const preview = await textureService.follow(job);
      take.maps = surfaceMapsOf(job.jobId, preview.maps);
      take.mapsState = 'ready';
      this.count(estimateJobCost(model, (picture.width * picture.height) / 1_000_000));
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
    if (take.url) URL.revokeObjectURL(take.url);
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
      await textureService.commit(take.jobId, take.previewAssetId, { name });
      take.textureId = take.previewAssetId;
      await this.onTextureKept(take.textureId, name, dimensions);
    }
    for (const surface of take.maps) {
      if (surface.textureId) continue;
      const surfaceName = libraryName(session.modelName, part.name, take.prompt, ` ${surface.role}`);
      await textureService.commit(surface.jobId, surface.previewAssetId, { name: surfaceName });
      surface.textureId = surface.previewAssetId;
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
