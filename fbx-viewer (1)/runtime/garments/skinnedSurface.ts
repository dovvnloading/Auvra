import * as THREE from 'three';
import { AVATAR_CONTACT_LIMITS, type GarmentAvatarSurface } from './avatarContact';
import { isDescendantOf } from '../ik';

type Attribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
const revision = (a: Attribute) => 'data' in a ? a.data.version : a.version;

/** Find one exact, case-sensitive mesh name on this instance, excluding child level objects. */
function findOwnerMesh(owner: THREE.Object3D, garment: THREE.Object3D, objectId: string, name: string): THREE.SkinnedMesh {
    const pending = [owner];
    let found: THREE.SkinnedMesh | null = null;
    while (pending.length) {
        const node = pending.pop()!;
        if (node === garment || (node !== owner && node.userData.levelObjectId !== undefined &&
            node.userData.levelObjectId !== objectId)) continue;
        if (node.name === name && (node as THREE.SkinnedMesh).isSkinnedMesh) {
            if (found) throw new Error('ambiguous');
            found = node as THREE.SkinnedMesh;
        }
        for (const child of node.children) pending.push(child);
    }
    if (!found) throw new Error('missing');
    return found;
}

/** One bounded animated collision mesh, its two last frame samples and two fixed-tick endpoints. */
class PoseSamples {
    readonly mesh: THREE.SkinnedMesh;
    private readonly owner: THREE.Object3D;
    private readonly index: THREE.BufferAttribute | null;
    private readonly indexVersion: number;
    private readonly vertex: Attribute;
    private readonly joint: Attribute;
    private readonly weight: Attribute;
    private readonly jointRevision: number;
    private readonly weightRevision: number;
    private readonly skeleton: THREE.Skeleton;
    private readonly localMatrix = new THREE.Matrix4();
    private readonly vertexPoint = new THREE.Vector3();
    private readonly from: Float32Array;
    private readonly to: Float32Array;
    private readonly surface: GarmentAvatarSurface;
    private first = true;
    private committed = true;
    private mirrored = false;
    private readonly originalIndices: Uint32Array;
    private reversedIndices?: Uint32Array;

    constructor(owner: THREE.Object3D, mesh: THREE.SkinnedMesh) {
        this.owner = owner;
        this.mesh = mesh;
        const geometry = mesh.geometry;
        const position = geometry.getAttribute('position');
        const joint = geometry.getAttribute('skinIndex');
        const weight = geometry.getAttribute('skinWeight');
        const index = geometry.getIndex();
        const count = index?.count ?? position?.count ?? 0;
        const vertexCount = position?.count ?? 0;
        if (vertexCount > AVATAR_CONTACT_LIMITS.vertices || count > 3 * AVATAR_CONTACT_LIMITS.triangles)
            throw new Error('over_budget');
        if (!position || position.itemSize !== 3 || vertexCount < 3 || count < 3 || count % 3 !== 0 ||
            !joint || !weight || joint.itemSize !== 4 || weight.itemSize !== 4 || joint.count !== vertexCount ||
            weight.count !== vertexCount || !mesh.skeleton?.bones.length) throw new Error('invalid_geometry');
        this.skeleton = mesh.skeleton;
        this.vertex = position;
        this.joint = joint;
        this.weight = weight;
        this.index = index;
        this.indexVersion = index?.version ?? 0;
        this.jointRevision = revision(joint);
        this.weightRevision = revision(weight);
        const indices = new Uint32Array(count);
        for (let i = 0; i < count; i++) {
            const v = index ? index.getX(i) : i;
            if (!Number.isInteger(v) || v < 0 || v >= vertexCount) throw new Error('invalid_index');
            indices[i] = v;
        }
        for (let v = 0; v < vertexCount; v++) {
            let total = 0;
            for (let k = 0; k < 4; k++) {
                const w = weight.getComponent(v, k);
                if (!Number.isFinite(w) || w < 0) throw new Error('invalid_weights');
                if (!w) continue;
                const b = joint.getComponent(v, k);
                if (!Number.isInteger(b) || !mesh.skeleton.bones[b] || !mesh.skeleton.boneInverses[b])
                    throw new Error('invalid_joint');
                total += w;
            }
            if (Math.abs(total - 1) > 0.02) throw new Error('invalid_weights');
        }
        this.originalIndices = indices;
        this.from = new Float32Array(3 * vertexCount);
        this.to = new Float32Array(this.from.length);
        this.surface = { indices, previousPositions: this.from.slice(), positions: this.to.slice() };
    }

    current(owner: THREE.Object3D, resolved: THREE.SkinnedMesh): boolean {
        const { mesh, index } = this;
        return owner === this.owner && mesh === resolved && mesh.skeleton === this.skeleton &&
            mesh.geometry.index === index && (index?.version ?? 0) === this.indexVersion &&
            mesh.geometry.getAttribute('position') === this.vertex && this.vertex.count * 3 === this.to.length &&
            mesh.geometry.getAttribute('skinIndex') === this.joint && revision(this.joint) === this.jointRevision &&
            mesh.geometry.getAttribute('skinWeight') === this.weight && revision(this.weight) === this.weightRevision;
    }

    capture(garment: THREE.Object3D): void {
        // Refresh parents, then let Three update attached/detached bindMatrixInverse with its override.
        // Bones can sit under an armature sibling of the skinned mesh.
        this.owner.updateWorldMatrix(true, false);
        this.owner.updateMatrixWorld(true);
        // Detached/shared skeletons may be mounted outside the level object. The renderer
        // updates them later; physics samples the current local pose before rendering.
        for (const bone of this.skeleton.bones) {
            if (bone && !isDescendantOf(bone, this.owner)) bone.updateWorldMatrix(true, false);
        }
        const ownerDeterminant = garment.matrixWorld.determinant();
        if (!Number.isFinite(ownerDeterminant) || Math.abs(ownerDeterminant) < 1e-14) throw new Error('singular_transform');
        this.localMatrix.copy(garment.matrixWorld).invert().multiply(this.mesh.matrixWorld);
        const det = this.localMatrix.determinant();
        if (!Number.isFinite(det) || Math.abs(det) < 1e-14) throw new Error('singular_transform');
        if ((det < 0) !== this.mirrored) {
            if (!this.reversedIndices) {
                const flipped = this.originalIndices.slice();
                for (let i = 0; i < flipped.length; i += 3) {
                    flipped[i + 1] = this.originalIndices[i + 2];
                    flipped[i + 2] = this.originalIndices[i + 1];
                }
                this.reversedIndices = flipped;
            }
            this.mirrored = det < 0;
            this.surface.indices = this.mirrored ? this.reversedIndices : this.originalIndices;
            this.first = true;
        }
        this.from.set(this.to);
        for (let i = 0; i < this.vertex.count; i++) {
            this.mesh.getVertexPosition(i, this.vertexPoint).applyMatrix4(this.localMatrix).toArray(this.to, 3 * i);
            if (!Number.isFinite(this.to[3 * i] + this.to[3 * i + 1] + this.to[3 * i + 2])) throw new Error('invalid_pose');
        }
        if (this.first) {
            this.from.set(this.to);
            this.surface.positions.set(this.to);
            this.first = false;
        }
    }

    tick(alpha: number): GarmentAvatarSurface {
        const { previousPositions, positions } = this.surface;
        if (this.committed) previousPositions.set(positions);
        const t = Math.max(0, Math.min(1, alpha));
        for (let i = 0; i < positions.length; i++) positions[i] = this.from[i] + (this.to[i] - this.from[i]) * t;
        this.committed = false;
        return this.surface;
    }

    accept(): void { this.committed = true; }
}

/** Detached, missing and invalid proxies suspend their garment until a usable named mesh is present. */
export class SkinnedSurfaceBinding {
    private pose: PoseSamples | null = null;
    private name = '';
    private objectId = '';
    private retry = 0;
    issue = '';

    capture(garment: THREE.Object3D, objectId: string, name: string, dt: number): boolean {
        if (this.name !== name || this.objectId !== objectId) {
            this.name = name;
            this.objectId = objectId;
            this.pose = null;
            this.retry = 0;
            this.issue = '';
        }
        if (!name) return true;
        const owner = garment.parent;
        if (!owner) { this.pose = null; this.issue = 'missing'; return false; }
        try {
            if (!this.pose) {
                this.retry -= dt;
                if (this.retry > 0) return false;
            }
            const resolved = findOwnerMesh(owner, garment, objectId, name);
            if (!this.pose?.current(owner, resolved)) {
                this.pose = new PoseSamples(owner, resolved);
                this.retry = 0;
            }
            this.pose.capture(garment);
            this.issue = '';
            return true;
        } catch (error) {
            this.pose = null;
            this.retry = 0.5;
            this.issue = error instanceof Error ? error.message : 'invalid_geometry';
            return false;
        }
    }

    tick(alpha: number): GarmentAvatarSurface | undefined { return this.pose?.tick(alpha); }
    accept(): void { this.pose?.accept(); }
}
