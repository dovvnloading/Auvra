import { createRequire } from 'node:module';
import type { RapierContext } from '@react-three/rapier';

/** The Rapier module the play runtime runs on, as useRapier hands it out. */
export type RuntimeRapier = RapierContext['rapier'];

let loading: Promise<RuntimeRapier> | null = null;

/**
 * Loads and initialises the Rapier build @react-three/rapier uses. The binding pins its own copy,
 * which can differ from the top-level @dimforge/rapier3d-compat other packages pull in (0.14 against
 * 0.12 today: ray hits report `timeOfImpact` rather than `toi`), so it is resolved from the binding's
 * own directory, as Node would for the binding itself.
 */
export const loadRuntimeRapier = (): Promise<RuntimeRapier> => {
  loading ??= (async () => {
    const fromTests = createRequire(import.meta.url);
    const fromBinding = createRequire(fromTests.resolve('@react-three/rapier'));
    // Node's own loader: the CommonJS build runs as it would under the binding, outside the test transform.
    const rapier = fromBinding('@dimforge/rapier3d-compat') as RuntimeRapier;
    await rapier.init();
    return rapier;
  })();
  return loading;
};
