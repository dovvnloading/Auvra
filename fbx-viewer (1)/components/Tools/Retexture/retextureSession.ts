import { useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { describeProviderFailure, type InferenceJob, type ProviderModel } from '../../../services/HostProviderService';
import { estimateJobCost } from '../../../services/providerPricing';
import { textureService } from '../../../services/TextureGenerationService';
import { overrideTextureFlipY } from '../../../utils/materialOverrides';
import { listModelParts, texturePicture, type ModelPart, type PartMaterial, type PictureSize } from './parts';

export type RetextureMode = 'restyle' | 'new';
export type TakeState = 'starting' | 'queued' | 'painting' | 'ready' | 'failed';

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
}

interface MaterialBaseline {
  material: PartMaterial;
  map: THREE.Texture | null;
  transparent: boolean;
  alphaTest: number;
  side: THREE.Side;
  color: THREE.Color | null;
}

export interface SessionPart extends ModelPart {
  baseline: MaterialBaseline[];
  /** What the model's document says for these materials as the session began. */
  baselineOverrides: Record<string, string>;
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

/** The largest picture sent as a source. Providers bill by the megapixel and answer at the size they are sent. */
const MAX_SOURCE_EDGE = 2048;
const THUMBNAIL_EDGE = 96;
const PREVIEW_EDGE = 512;
const NEW_TEXTURE_MEGAPIXELS = 1.05;
const MAX_LIBRARY_NAME = 128;

/** A name for a kept texture that says where it came from. Project names may not hold what a file path could not. */
export const libraryName = (modelName: string, partName: string, prompt: string): string => {
  const name = `${modelName} ${partName} - ${prompt}`.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return name.length > MAX_LIBRARY_NAME ? `${name.slice(0, MAX_LIBRARY_NAME - 1).trimEnd()}…` : name;
};

const stateOfJob = (status: InferenceJob['status']): TakeState => (status === 'queued' || status === 'submitting' ? 'queued' : 'painting');

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
  open(modelId: string, modelName: string, object: THREE.Object3D, overrides: Record<string, string> | undefined): ModelSession {
    const existing = this.sessions.get(modelId);
    if (existing?.object === object) return existing;
    if (existing) this.drop(existing);
    const parts = listModelParts(object).map((part): SessionPart => {
      const picture = part.texture ? texturePicture(part.texture, THUMBNAIL_EDGE, 'image/jpeg') : null;
      return {
        ...part,
        baseline: part.materials.map((material) => ({ material, map: material.map ?? null, transparent: material.transparent, alphaTest: material.alphaTest, side: material.side, color: material.color?.clone() ?? null })),
        baselineOverrides: Object.fromEntries(part.materialNames.flatMap((name) => (overrides?.[name] ? [[name, overrides[name]]] : []))),
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

  /** The texture a take draws with, loaded once. */
  async textureOf(session: ModelSession, take: Take): Promise<THREE.Texture | null> {
    const loaded = this.textures.get(take.id);
    if (loaded) return loaded;
    if (!take.url) return null;
    const texture = await new THREE.TextureLoader().loadAsync(take.url);
    texture.colorSpace = THREE.SRGBColorSpace;
    // The same way round as a stored override is put on when the project opens.
    texture.flipY = overrideTextureFlipY(session.object);
    this.textures.set(take.id, texture);
    return texture;
  }

  private async show(session: ModelSession, part: SessionPart, takeId: string | null) {
    part.showRequest += 1;
    const request = part.showRequest;
    const take = takeId ? part.takes.find((item) => item.id === takeId) : null;
    if (!take) {
      for (const base of part.baseline) {
        const needsCompile = Boolean(base.material.map) !== Boolean(base.map) || base.material.transparent !== base.transparent || base.material.alphaTest !== base.alphaTest || base.material.side !== base.side;
        base.material.map = base.map;
        base.material.transparent = base.transparent;
        base.material.alphaTest = base.alphaTest;
        base.material.side = base.side;
        if (base.color) base.material.color?.copy(base.color);
        if (needsCompile) base.material.needsUpdate = true;
      }
      return;
    }
    const texture = await this.textureOf(session, take);
    if (!texture || request !== part.showRequest) return;
    for (const base of part.baseline) {
      const material = base.material;
      // As a saved override is put on when the project opens, so what is tried on is what comes back.
      if (!base.map) material.color?.set(0xffffff);
      const needsCompile = !material.map || !material.transparent || material.alphaTest !== 0.5 || material.side !== THREE.DoubleSide;
      material.map = texture;
      material.transparent = true;
      material.alphaTest = 0.5;
      material.side = THREE.DoubleSide;
      if (needsCompile) material.needsUpdate = true;
    }
  }

  /** What a restyle starts from: what is on the part now, at a size that is sensible to send. */
  private async sourceOf(session: ModelSession, part: SessionPart): Promise<{ picture: { url: string; width: number; height: number } | null; fromTake?: number }> {
    const take = part.worn ? part.takes.find((item) => item.id === part.worn && item.state === 'ready') : null;
    const texture = take ? await this.textureOf(session, take) : part.texture;
    return { picture: texture ? texturePicture(texture, MAX_SOURCE_EDGE) : null, fromTake: take?.number };
  }

  /** What one run of a model would come to on this part, or null while the price is not known. */
  estimate(part: SessionPart | null, request: Pick<GenerateRequest, 'mode' | 'model'>): number | null {
    if (!request.model) return null;
    if (request.mode === 'new' || !part?.size) return estimateJobCost(request.model, NEW_TEXTURE_MEGAPIXELS);
    const scale = Math.min(1, MAX_SOURCE_EDGE / Math.max(part.size.width, part.size.height));
    return estimateJobCost(request.model, (part.size.width * scale * part.size.height * scale) / 1_000_000);
  }

  async generate(session: ModelSession, part: SessionPart, request: GenerateRequest): Promise<void> {
    const { picture, fromTake } = request.mode === 'restyle' ? await this.sourceOf(session, part) : { picture: null, fromTake: undefined };
    if (request.mode === 'restyle' && !picture) throw new Error('This part has no texture to restyle. Paint a new one from a description.');
    const cost = this.estimate(part, request);
    part.followNext = true;
    const source = picture ? textureService.ingestLocalAsset(picture.url) : Promise.resolve(null);
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
      };
      part.nextNumber += 1;
      part.takes.push(take);
      void this.run(session, part, take, source);
    }
    this.changed();
  }

  private async run(session: ModelSession, part: SessionPart, take: Take, source: Promise<string | null>) {
    try {
      const job = await textureService.submit(await source, take.prompt);
      take.jobId = job.jobId;
      const preview = await textureService.follow(job, (current) => {
        const state = stateOfJob(current.status);
        if (take.state !== state) { take.state = state; this.changed(); }
      });
      take.previewAssetId = preview.previewAssetId;
      take.url = preview.previewUrl;
      take.size = preview.dimensions;
      take.state = 'ready';
      take.finishedAt = Date.now();
      this.runs += 1;
      this.spentMicroUsd += take.costMicroUsd ?? 0;
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

  private forget(part: SessionPart, take: Take) {
    part.takes = part.takes.filter((item) => item !== take);
    if (take.url) URL.revokeObjectURL(take.url);
    this.textures.get(take.id)?.dispose();
    this.textures.delete(take.id);
    this.changed();
  }

  /** Takes a result out of the strip. One saved on the model stays until something else replaces it. */
  async remove(session: ModelSession, part: SessionPart, take: Take) {
    if (part.saved === take.id) return;
    if (part.worn === take.id) this.wear(session, part, part.saved);
    // Let the host know after the texture is off the model: its preview goes with this, and one kept in the library has none.
    const discardable = take.state === 'ready' && !take.textureId && take.jobId && take.previewAssetId;
    this.forget(part, take);
    if (discardable) await textureService.discard(take.jobId!, take.previewAssetId!).catch(() => undefined);
  }

  /** Keeps a take in the project's texture library, once. */
  async keep(session: ModelSession, part: SessionPart, take: Take): Promise<string> {
    if (take.textureId) return take.textureId;
    if (!take.jobId || !take.previewAssetId) throw new Error('This result is no longer available.');
    await textureService.commit(take.jobId, take.previewAssetId, { name: libraryName(session.modelName, part.name, take.prompt) });
    take.textureId = take.previewAssetId;
    this.changed();
    return take.textureId;
  }

  /**
   * Saves a take on the model, or with null what the part had when the session began. `persist` records the model's
   * overrides as they should now stand.
   */
  async saveOnModel(session: ModelSession, part: SessionPart, take: Take | null, current: Record<string, string> | undefined, persist: (overrides: Record<string, string>) => Promise<void>) {
    const overrides = { ...(current ?? {}) };
    const textureId = take ? await this.keep(session, part, take) : null;
    for (const name of part.materialNames) {
      const value = textureId ?? part.baselineOverrides[name];
      if (value) overrides[name] = value;
      else delete overrides[name];
    }
    await persist(overrides);
    part.saved = take?.id ?? null;
    this.wear(session, part, part.saved);
  }

  /** The project closed or changed: its previews are gone and its models are no longer in use. */
  reset() {
    for (const session of this.sessions.values()) this.drop(session);
    this.sessions.clear();
    this.spentMicroUsd = 0;
    this.runs = 0;
    this.changed();
  }

  private drop(session: ModelSession) {
    for (const part of session.parts) {
      for (const take of part.takes) {
        if (take.url) URL.revokeObjectURL(take.url);
        this.textures.get(take.id)?.dispose();
        this.textures.delete(take.id);
      }
    }
    this.sessions.delete(session.modelId);
  }
}

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
