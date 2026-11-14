import type { AvatarContactStats } from './avatarContact';
import type { SelfContactStats } from './selfContact';

export type GarmentContactStatus = 'live' | 'cache' | 'missing-avatar' | 'missing-bone';
export interface GarmentContactSample {
    readonly status: GarmentContactStatus;
    readonly seconds: number;
    readonly body: string;
    readonly detail: string;
    readonly sameLayer: boolean;
    readonly solved?: boolean;
    readonly orderedLayers: boolean;
    readonly self: Readonly<SelfContactStats> | null;
    readonly avatar: Readonly<AvatarContactStats> | null;
}
export enum GarmentContactLimit {
    ClothBroadPhase = 1, ClothFeatures = 2, ClothAdvancement = 4, LayerCapacity = 8,
    AvatarVertices = 16, AvatarFeatureVisits = 32, AvatarFeaturePairs = 64, AvatarGeometry = 128,
    InvalidAvatar = 256,
}
type Self = Readonly<SelfContactStats> | null;
type Avatar = Readonly<AvatarContactStats> | null;
function limitFlags(self: Self, avatar: Avatar): number {
    let flags = 0;
    if (self?.broadPhaseLimited) flags |= GarmentContactLimit.ClothBroadPhase;
    if (self?.featureCapacityLimited) flags |= GarmentContactLimit.ClothFeatures;
    if (self?.advancementLimited) flags |= GarmentContactLimit.ClothAdvancement;
    if (self?.layerCapacityLimited) flags |= GarmentContactLimit.LayerCapacity;
    if (avatar?.vertexPhaseLimited) flags |= GarmentContactLimit.AvatarVertices;
    if (avatar?.featureNodesLimited) flags |= GarmentContactLimit.AvatarFeatureVisits;
    if (avatar?.featurePairsLimited) flags |= GarmentContactLimit.AvatarFeaturePairs;
    if (avatar?.limited && !avatar.vertexPhaseLimited && !avatar.featureNodesLimited && !avatar.featurePairsLimited)
        flags |= GarmentContactLimit.AvatarGeometry;
    if (avatar?.invalid) flags |= GarmentContactLimit.InvalidAvatar;
    return flags;
}
export interface GarmentContactView {
    readonly id: number;
    readonly sample: GarmentContactSample;
    /** Union of work-limit reasons across observed accepted ticks since the previous sample. */
    readonly limits: number;
}
type Snapshot = readonly GarmentContactView[];
const NONE: Snapshot = Object.freeze([]);
export const CONTACT_SAMPLE_INTERVAL_MS = 250;
export interface GarmentContactSource {
    observed(): boolean;
    /** Call before copying counters. Binding or display-mode changes publish immediately. */
    due(status?: GarmentContactStatus, mesh?: string, bone?: string): boolean;
    recordTick(self: Self, avatar: Avatar, mesh: string, bone: string): void;
    publish(sample: GarmentContactSample): void;
    dispose(): void;
}
interface Group {
    listeners: Set<() => void>;
    samples: Map<number, GarmentContactView>;
    snapshot: Snapshot;
    live: number;
    observation: number;
}

/** Local inspector transport. Owner reference scopes duplicate project/object IDs; the
 * component ID distinguishes multiple garment components; each editor viewport mounts
 * an independent producer. The standalone player never registers a producer. */
class ContactTelemetry {
    private readonly owners = new WeakMap<object, Map<string, Group>>();
    private nextId = 0;

    private group(owner: object, component: string): Group {
        let components = this.owners.get(owner);
        if (!components) this.owners.set(owner, components = new Map());
        let group = components.get(component);
        if (!group) {
            group = { listeners: new Set(), samples: new Map(), snapshot: NONE, live: 0, observation: 0 };
            components.set(component, group);
        }
        return group;
    }

    private cleanup(owner: object, component: string, group: Group): void {
        if (group.live || group.listeners.size) return;
        const components = this.owners.get(owner);
        if (components?.get(component) !== group) return;
        components.delete(component);
        if (!components.size) this.owners.delete(owner);
    }

    private notify(group: Group): void {
        group.snapshot = group.samples.size ? Array.from(group.samples.values())
            .sort((a, b) => a.id - b.id) : NONE;
        for (const listener of group.listeners) listener();
    }

    get(owner: object, component: string): Snapshot {
        return this.owners.get(owner)?.get(component)?.snapshot ?? NONE;
    }

    observe(owner: object, component: string, listener: () => void): () => void {
        const group = this.group(owner, component);
        if (!group.listeners.size) group.observation++;
        const notify = () => listener();
        group.listeners.add(notify);
        return () => {
            if (!group.listeners.delete(notify)) return;
            if (!group.listeners.size) {
                group.samples.clear();
                group.snapshot = NONE;
            }
            this.cleanup(owner, component, group);
        };
    }

    attach(owner: object, component: string): GarmentContactSource {
        const group = this.group(owner, component);
        group.live++;
        const id = ++this.nextId;
        let observation = -1, dueAt = 0, active = true;
        let limitObservation = -1, limits = 0, limitMesh = '', limitBone = '';
        let lastStatus: GarmentContactStatus | undefined, lastMesh = '', lastBone = '';
        const beginWindow = (mesh: string, bone: string) => {
            if (limitObservation !== group.observation || mesh !== limitMesh || bone !== limitBone) {
                limits = 0;
                limitObservation = group.observation;
                limitMesh = mesh;
                limitBone = bone;
            }
        };
        return {
            observed: () => active && group.listeners.size > 0,
            recordTick: (self, avatar, mesh, bone) => {
                if (!active || !group.listeners.size) return;
                beginWindow(mesh, bone);
                limits |= limitFlags(self, avatar);
            },
            due: (status, mesh = '', bone = '') => {
                if (!active || !group.listeners.size) return false;
                const now = performance.now();
                const changed = status !== lastStatus || mesh !== lastMesh || bone !== lastBone;
                if (observation === group.observation && !changed && now < dueAt) return false;
                beginWindow(mesh, bone);
                lastStatus = status;
                lastMesh = mesh;
                lastBone = bone;
                observation = group.observation;
                dueAt = now + CONTACT_SAMPLE_INTERVAL_MS;
                return true;
            },
            publish: sample => {
                if (!active || !group.listeners.size || observation !== group.observation) return;
                // The simulation reuses mutable counter objects on every tick.
                const copy = { ...sample, self: sample.self ? { ...sample.self } : null,
                    avatar: sample.avatar ? { ...sample.avatar } : null };
                group.samples.set(id, { id, sample: copy, limits: sample.status === 'live'
                    ? limits | limitFlags(sample.self, sample.avatar) : 0 });
                limits = 0;
                this.notify(group);
            },
            dispose: () => {
                if (!active) return;
                active = false;
                group.live--;
                if (group.samples.delete(id)) this.notify(group);
                this.cleanup(owner, component, group);
            },
        };
    }
}
export const garmentContacts = new ContactTelemetry();
