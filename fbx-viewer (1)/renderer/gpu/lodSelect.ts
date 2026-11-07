/// <reference types="@webgpu/types" />
import { LOD_PIXEL_ERROR } from "../../utils/meshLod";

/**
 * CHOOSING A DETAIL LEVEL ON THE GRAPHICS CARD
 *
 * A mesh with detail levels has one draw per level, and the cull shader sends each instance to the draw of the level
 * its size on the screen calls for, by the same rule as chooseLodLevel in utils/meshLod.ts: the coarsest level whose
 * error, scaled into the world and seen from its distance to the view's lodEye, covers at most LOD_PIXEL_ERROR pixels.
 *
 * `pickSlot(instance, group)` gives the slot to use: the entry of the group-offset table and of the draw table the
 * instance belongs in. A group's full level has slot number equal to the group's number, so a group without levels
 * and any pass that takes no interest in levels go on working with `instance.group` as before. Coarser levels' slots
 * come after all the groups (GpuScene.layout); draw arguments are needed for `gpuScene.slotCount` slots, and each
 * group's slots are listed in `group.slots`.
 *
 * To use it, a compute shader includes LOD_SELECT_WGSL after the view and instance declarations, adds
 * `gpuScene.lodLayout` to its pipeline layout at LOD_BIND_GROUP, and binds `gpuScene.lodBindGroup` there.
 */

export const LOD_BIND_GROUP = 3;

const VISIBILITY_COMPUTE = 4;

export const LOD_LAYOUT_ENTRIES: GPUBindGroupLayoutEntry[] = [
  { binding: 0, visibility: VISIBILITY_COMPUTE, buffer: { type: "read-only-storage" } },
  { binding: 1, visibility: VISIBILITY_COMPUTE, buffer: { type: "read-only-storage" } },
];

export const LOD_LEVEL_WORDS = 2;
export const LOD_GROUP_WORDS = 2;

/** The WGSL, with its tables in bind group `group`, for a shader whose group 3 is taken. */
export const lodSelectWgsl = (group: number = LOD_BIND_GROUP): string => /* wgsl */ `
struct LodLevel { error: f32, slot: u32 }
// For each group: where its levels past the full one start in lodLevels, and how many there are.
@group(${group}) @binding(0) var<storage, read> lodGroups: array<vec2u>;
@group(${group}) @binding(1) var<storage, read> lodLevels: array<LodLevel>;
const LOD_PIXEL_ERROR = ${LOD_PIXEL_ERROR.toFixed(6)};

fn pickSlot(instance: Instance, group: u32) -> u32 {
  let levels = lodGroups[group];
  if (levels.y == 0u || view.params.y <= 0.0) { return group; }
  let column0 = vec3f(instance.world0.x, instance.world1.x, instance.world2.x);
  let column1 = vec3f(instance.world0.y, instance.world1.y, instance.world2.y);
  let column2 = vec3f(instance.world0.z, instance.world1.z, instance.world2.z);
  let scale = sqrt(max(max(dot(column0, column0), dot(column1, column1)), dot(column2, column2)));
  let away = max(length(instance.sphere.xyz - view.lodEye.xyz), 1e-6);
  let pixelsPerError = scale * view.params.y / away;
  for (var level = levels.y; level > 0u; level--) {
    let candidate = lodLevels[levels.x + level - 1u];
    if (candidate.error * pixelsPerError <= LOD_PIXEL_ERROR) { return candidate.slot; }
  }
  return group;
}
`;

export const LOD_SELECT_WGSL = lodSelectWgsl();
