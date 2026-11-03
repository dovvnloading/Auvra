/**
 * Which bones move a vertex and how much. Everything here keeps what a skinned mesh needs: at most four
 * bones per vertex, with shares that add up to one.
 */

/** Bones a vertex can follow. */
export const BONES_PER_VERTEX = 4;
/** Smallest share kept: less than this moves nothing you would see. */
export const LEAST_SHARE = 0.01;
/** In a vertex's list of bones, where it has run out. */
export const NO_BONE = -1;

/** The weights of many vertices, four bones and four shares each. */
export interface VertexWeights {
  bones: Int32Array;
  shares: Float32Array;
}

export const shareOf = (weights: VertexWeights, vertex: number, bone: number): number => {
  const at = vertex * BONES_PER_VERTEX;
  for (let slot = 0; slot < BONES_PER_VERTEX; slot += 1) {
    if (weights.bones[at + slot] === bone) return weights.shares[at + slot];
  }
  return 0;
};

/** Shares gathered bone by bone, then written out as one vertex's weights. */
export class WeightMix {
  private readonly pull: Float64Array;
  private readonly touched: Int32Array;
  private touchedCount = 0;
  private readonly keptValues = new Float64Array(BONES_PER_VERTEX);

  constructor(boneCount: number) {
    this.pull = new Float64Array(boneCount);
    this.touched = new Int32Array(boneCount);
  }

  add(bone: number, share: number): void {
    if (!(share > 0)) return;
    if (this.pull[bone] === 0) {
      this.touched[this.touchedCount] = bone;
      this.touchedCount += 1;
    }
    this.pull[bone] += share;
  }

  /** Adds a vertex's shares, each scaled, leaving out one bone if asked. */
  addVertex(weights: VertexWeights, vertex: number, scale = 1, except = NO_BONE): void {
    const at = vertex * BONES_PER_VERTEX;
    for (let slot = 0; slot < BONES_PER_VERTEX; slot += 1) {
      const bone = weights.bones[at + slot];
      if (bone !== NO_BONE && bone !== except) this.add(bone, weights.shares[at + slot] * scale);
    }
  }

  total(): number {
    let total = 0;
    for (let index = 0; index < this.touchedCount; index += 1) total += this.pull[this.touched[index]];
    return total;
  }

  /** Empties this mix into another, scaled. */
  moveInto(other: WeightMix, scale: number): void {
    for (let index = 0; index < this.touchedCount; index += 1) other.add(this.touched[index], this.pull[this.touched[index]] * scale);
    this.clear();
  }

  clear(): void {
    for (let index = 0; index < this.touchedCount; index += 1) this.pull[this.touched[index]] = 0;
    this.touchedCount = 0;
  }

  /**
   * Writes the strongest four as a vertex's weights, shares adding up to one, and empties the mix. What
   * is too small to show goes, unless it is `keep`, which is always among the four: a bone being
   * painted in has to be able to start small. Nothing to write leaves the vertex with no bones.
   */
  write(weights: VertexWeights, vertex: number, keep = NO_BONE): void {
    const at = vertex * BONES_PER_VERTEX;
    const least = this.total() * LEAST_SHARE;
    const values = this.keptValues;
    let kept = 0;
    let sum = 0;
    if (keep !== NO_BONE && this.pull[keep] > 0) {
      weights.bones[at] = keep;
      values[0] = this.pull[keep];
      sum += this.pull[keep];
      this.pull[keep] = -1;
      kept = 1;
    }
    while (kept < BONES_PER_VERTEX) {
      let best = NO_BONE;
      let bestValue = 0;
      for (let index = 0; index < this.touchedCount; index += 1) {
        const bone = this.touched[index];
        if (this.pull[bone] > bestValue) {
          bestValue = this.pull[bone];
          best = bone;
        }
      }
      // Everything spread too thin to keep: the strongest takes it all.
      if (best === NO_BONE || (bestValue < least && kept > 0)) break;
      weights.bones[at + kept] = best;
      values[kept] = bestValue;
      sum += bestValue;
      this.pull[best] = -1;
      kept += 1;
    }
    // Divided before they are rounded to floats, so none can come out above one.
    for (let slot = 0; slot < kept; slot += 1) weights.shares[at + slot] = values[slot] / sum;
    for (let slot = kept; slot < BONES_PER_VERTEX; slot += 1) {
      weights.bones[at + slot] = NO_BONE;
      weights.shares[at + slot] = 0;
    }
    this.clear();
  }
}

/** Moves a vertex `amount` of the way (0 to 1) to following `bone` alone. The other bones shrink in proportion. */
export const addBone = (weights: VertexWeights, vertex: number, bone: number, amount: number, mix: WeightMix): void => {
  const current = shareOf(weights, vertex, bone);
  const next = current + (1 - current) * amount;
  const others = 1 - current;
  mix.addVertex(weights, vertex, others > 1e-6 ? (1 - next) / others : 0, bone);
  mix.add(bone, next);
  mix.write(weights, vertex, bone);
};

/**
 * Hands `share` of a vertex over to whichever bones should take it when `bone` alone moved it. False
 * when no bone can, as a vertex must follow something.
 */
export type WeightHeirs = (mix: WeightMix, vertex: number, bone: number, share: number) => boolean;

/** Takes `amount` (0 to 1) of what `bone` moves a vertex away. The other bones grow in proportion. */
export const removeBone = (weights: VertexWeights, vertex: number, bone: number, amount: number, mix: WeightMix, heirs: WeightHeirs): void => {
  const current = shareOf(weights, vertex, bone);
  if (!(current > 0)) return;
  let next = current * (1 - amount);
  if (next < LEAST_SHARE) next = 0;
  const others = 1 - current;
  if (others > 1e-6) {
    mix.addVertex(weights, vertex, (1 - next) / others, bone);
  } else if (!heirs(mix, vertex, bone, 1 - next)) {
    mix.clear();
    return;
  }
  mix.add(bone, next);
  mix.write(weights, vertex);
};

/**
 * Writes vertex `vertex`, moved `amount` of the way to the average of its neighbours, as vertex
 * `into` of `out`. Every bone is evened out together, so the shares stay in proportion to each other.
 */
export const smoothedVertex = (
  weights: VertexWeights,
  vertex: number,
  neighbours: ArrayLike<number>,
  firstNeighbour: number,
  lastNeighbour: number,
  amount: number,
  mix: WeightMix,
  out: VertexWeights,
  into: number,
): void => {
  const count = lastNeighbour - firstNeighbour;
  mix.addVertex(weights, vertex, count > 0 ? 1 - amount : 1);
  if (count > 0) {
    const each = amount / count;
    for (let link = firstNeighbour; link < lastNeighbour; link += 1) mix.addVertex(weights, neighbours[link], each);
  }
  mix.write(out, into);
};
