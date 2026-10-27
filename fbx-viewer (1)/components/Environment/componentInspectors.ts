import { registerComponentInspector } from '../../runtime/components/registry';
import { ScriptInspector } from '../Scripting/ScriptInspector';
import { TimelineInspector } from '../Timeline/TimelineInspector';

/**
 * Editor-only Inspectors for component settings a schema field cannot edit. Importing this module
 * attaches them to the shared component definitions; the game player never imports it, so the
 * editor UI they use (scene context, project service) stays out of the player bundle.
 */
registerComponentInspector('script', ScriptInspector);
registerComponentInspector('timeline', TimelineInspector);
