import React, { useSyncExternalStore } from 'react';
import { interactKeyLabel } from './components/dialogueComponent';
import type { InputState } from './input';
import { useUiText } from './localization';
import { stepOutOfVehicle, vehicleSession, type VehicleSession, type VehicleSessionState } from './vehicles';

/** The play session's driving state, re-rendering when it changes. */
export const useVehicleSessionState = (session: VehicleSession = vehicleSession): VehicleSessionState =>
    useSyncExternalStore(session.subscribe, session.state, session.state);

const KEY = 'rounded border border-white/40 bg-white/10 px-1.5 py-0.5 font-mono text-xs';

/**
 * Driving on screen: the Interact prompt beside a vehicle the player can get into, and while driving
 * a speedometer (speed, gear, revs) with the way out. Both are buttons for touch screens; the
 * VehicleDriver in the scene handles the Interact action itself.
 */
export const VehicleOverlay: React.FC<{ input: InputState | null; session?: VehicleSession }> = ({ input, session = vehicleSession }) => {
    const state = useVehicleSessionState(session);
    const ui = useUiText();
    const key = input ? interactKeyLabel(input) : state.prompt?.key ?? '';

    if (state.driving) {
        const hud = state.hud;
        return (
            <div className="pointer-events-none absolute inset-x-0 bottom-6 z-30 flex justify-center px-4">
                <div aria-label={ui('ui.vehicle.speedometer')} className="pointer-events-auto flex items-end gap-4 rounded-2xl border border-white/15 bg-black/65 px-5 py-3 text-white shadow-xl backdrop-blur">
                    {hud && (
                        <>
                            <div className="flex flex-col items-center">
                                <span className="text-4xl font-bold tabular-nums leading-none">{hud.speed}</span>
                                <span className="text-[10px] uppercase tracking-wider text-white/60">{ui('ui.vehicle.speedUnit')}</span>
                            </div>
                            <div className="flex flex-col items-center gap-1">
                                <span className="rounded bg-white/15 px-2 font-mono text-lg font-bold">{hud.gear}</span>
                                <div className="h-1.5 w-20 overflow-hidden rounded bg-white/15">
                                    <div className={`h-full ${hud.rpm > 0.9 ? 'bg-red-500' : 'bg-sky-400'}`} style={{ width: `${Math.round(Math.min(1, Math.max(0, hud.rpm)) * 100)}%` }} />
                                </div>
                            </div>
                        </>
                    )}
                    <button type="button" onClick={() => stepOutOfVehicle(session)} className="flex items-center gap-1.5 self-center rounded-full border border-white/20 px-3 py-1 text-xs text-white/80 hover:bg-white/10">
                        {key && <kbd className={KEY}>{key}</kbd>}
                        <span>{ui('ui.vehicle.exit')}</span>
                    </button>
                </div>
            </div>
        );
    }

    const prompt = state.prompt;
    if (!prompt) return null;
    return (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 z-30 flex justify-center px-4">
            <button
                type="button"
                onClick={() => session.enter(prompt.objectId)}
                className="pointer-events-auto flex items-center gap-2 rounded-full border border-white/20 bg-black/70 px-4 py-2 text-sm text-white shadow-lg backdrop-blur"
            >
                {key && <kbd className={KEY}>{key}</kbd>}
                <span>{ui('ui.vehicle.drive')}</span>
            </button>
        </div>
    );
};
