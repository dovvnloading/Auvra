import { registerComponentInspector } from '../../runtime/components/registry';
import { DialogueInspector } from '../Dialogue/DialogueInspector';
import { ScriptInspector } from '../Scripting/ScriptInspector';
import { TimelineInspector } from '../Timeline/TimelineInspector';
import { AbilitiesInspector } from './AbilitiesInspector';
import { LevelStreamingInspector } from './LevelStreamingInspector';
import { ParticlesInspector } from './ParticlesInspector';
import { ProceduralRigInspector } from './ProceduralRigInspector';
import { ReachIKInspector } from './ReachIKInspector';
import { ScatterInspector } from './ScatterInspector';
import { FollowSplineInspector, SplineInspector, SplineModelInspector } from './SplineInspectors';
import { VehicleInspector } from './VehicleInspector';

/**
 * Editor-only Inspectors for component settings a schema field cannot edit. Importing this module
 * attaches them to the shared component definitions; the game player never imports it, so the
 * editor UI they use (scene context, project service) stays out of the player bundle.
 */
registerComponentInspector('script', ScriptInspector);
registerComponentInspector('timeline', TimelineInspector);
registerComponentInspector('levelStreaming', LevelStreamingInspector);
registerComponentInspector('dialogue', DialogueInspector);
registerComponentInspector('twoBoneIK', ReachIKInspector);
registerComponentInspector('spline', SplineInspector);
registerComponentInspector('splineMesh', SplineModelInspector);
registerComponentInspector('splineScatter', SplineModelInspector);
registerComponentInspector('followSpline', FollowSplineInspector);
registerComponentInspector('vehicle', VehicleInspector);
registerComponentInspector('particles', ParticlesInspector);
registerComponentInspector('abilities', AbilitiesInspector);
registerComponentInspector('proceduralScatter', ScatterInspector);
registerComponentInspector('proceduralRig', ProceduralRigInspector);
