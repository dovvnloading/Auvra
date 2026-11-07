import * as THREE from "three";

/**
 * WHAT A MATERIAL'S COMPILE HOOK WOULD HAND THREE
 *
 * Several patched materials keep their numbers and textures where only their compile hook can reach them. Running the
 * hook once over an untouched copy of the physical program, which has every marker a hook looks for, gives back the very
 * uniform objects the WebGL path reads, so both follow the same values. Nothing but the copy is changed.
 */

interface Harvest {
  hook: THREE.Material["onBeforeCompile"];
  /** What else, when it changes, makes the hook hand over different uniforms. */
  revision: unknown;
  uniforms: Record<string, THREE.IUniform>;
}

const harvests = new WeakMap<THREE.Material, Harvest>();
const NONE: Record<string, THREE.IUniform> = {};

export const hasOwnCompileHook = (material: THREE.Material): boolean =>
  material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile;

export const hookUniforms = (material: THREE.Material, revision: unknown = null): Record<string, THREE.IUniform> => {
  if (!hasOwnCompileHook(material)) return NONE;
  const harvest = harvests.get(material);
  if (harvest && harvest.hook === material.onBeforeCompile && harvest.revision === revision) return harvest.uniforms;
  const { vertexShader, fragmentShader } = THREE.ShaderLib.physical;
  const program = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader, fragmentShader };
  try {
    material.onBeforeCompile(program as unknown as THREE.WebGLProgramParametersWithUniforms, null as unknown as THREE.WebGLRenderer);
  } catch {
    program.uniforms = {};
  }
  harvests.set(material, { hook: material.onBeforeCompile, revision, uniforms: program.uniforms });
  return program.uniforms;
};
