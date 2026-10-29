import React from 'react';
import { Route } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import type { ComponentInspectorProps } from '../../runtime/components/types';
import { findSplineComponent } from '../../runtime/splineRegistry';

const FIELD = 'w-full bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200 focus:outline-none focus:border-orange-500';

/** The Vehicle component's AI path: a Spline object it drives along whenever the player is not driving it. */
export const VehicleInspector: React.FC<ComponentInspectorProps> = ({ object, component, onChangeProps }) => {
    const { levelObjects } = useScene();
    const path = typeof component.props.aiPath === 'string' ? component.props.aiPath : '';
    const choices = levelObjects.filter(candidate => candidate.id !== object.id && findSplineComponent(candidate) !== null);
    const known = !path || choices.some(candidate => candidate.id === path);
    const ownBody = (object.components ?? []).some(entry => entry.enabled && entry.type === 'rigidBody');
    return (
        <div className="space-y-1">
            <label className="flex items-center gap-1 text-[10px] text-gray-400"><Route size={10} /> AI path</label>
            <select aria-label="AI path" value={path} onChange={(event) => onChangeProps({ aiPath: event.target.value })} className={FIELD}>
                <option value="">None (parked until driven)</option>
                {!known && <option value={path}>Missing spline</option>}
                {choices.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
            {path && <p className="text-[10px] text-gray-500">Drives along it at the AI cruise speed whenever the player is not driving it.</p>}
            {ownBody && <p className="text-[10px] text-amber-400">The Rigid Body component on this object sets its mass and body type; the Vehicle's mass is not used.</p>}
            <p className="text-[10px] text-gray-500">Wheels are the model's own nodes named like Wheel_FL, FrontLeftTire or rim_rr; a model without any gets four drawn at the corners of its body.</p>
        </div>
    );
};
