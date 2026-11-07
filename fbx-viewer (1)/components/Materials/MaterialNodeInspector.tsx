import React, { useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '../UI/Icons';
import { Select } from '../UI/Select';
import { CodeField, ParamField } from './MaterialParamField';
import {
    MAX_PARAMETER_NAME_LENGTH,
    MATERIAL_PICTURE_NODE_TYPE,
    OUTPUT_NODE_TYPE,
    PARAMETER_NODE_PARAMS,
    getMaterialNodeDefinition,
    materialGraphSettings,
    readParam,
    type MaterialGraphNode,
    type MaterialParamDef,
} from '../../runtime/materials/materialGraph';

/**
 * The Materials tab's inspector for one shader graph node: its settings, then its values under a
 * collapsible header for each group (the Material Output's Base, Specular, Coat... open once used), and
 * its parameter name where it can have one. With nothing selected it shows the Material Output as the
 * material's own settings.
 */

/** Groups of the Material Output open from the start; the rest open once they are used. */
const OPEN_GROUPS = new Set(['Base', 'Emission', 'Opacity']);

/** A selected node's settings, or with nothing selected the material's own (the Material Output's). */
export const NodeInspector: React.FC<{
    node: MaterialGraphNode;
    textures: { id: string; name: string }[];
    title?: string;
    /** Inputs of the node that are wired: their values come from the wire. */
    wired?: ReadonlySet<string>;
    /** What is wrong with the node's code, when the shader did not compile there (marked on its code). */
    error?: string;
    onChangeNode: (node: MaterialGraphNode, coalesce?: string) => void;
}> = ({ node, textures, title, wired, error, onChangeNode }) => {
    const definition = getMaterialNodeDefinition(node.type)!;
    const [toggled, setToggled] = useState<Record<string, boolean>>({});
    const blendMode = node.type === OUTPUT_NODE_TYPE ? materialGraphSettings({ nodes: [node], links: [] }).blendMode : null;
    const field = (param: MaterialParamDef) => {
        // The clip only matters to a masked material.
        if (param.key === 'alphaClip' && blendMode !== 'masked') return null;
        // Filled from the material's own pictures, by name: nothing to pick.
        if (param.key === 'texture' && (node.type === MATERIAL_PICTURE_NODE_TYPE || (node.type === 'parallax' && node.params.heightFrom === 'height'))) return null;
        if (wired?.has(param.key)) {
            return (
                <div key={param.key} className="flex items-center justify-between text-2xs">
                    <span className="text-gray-500">{param.label}</span>
                    <span className="text-gray-400">Set by its wire</span>
                </div>
            );
        }
        if (param.kind === 'code') {
            return (
                <CodeField key={param.key} label={param.label} code={readParam(param, node.params[param.key]) as string} error={error ?? null}
                    onChange={(value) => onChangeNode({ ...node, params: { ...node.params, [param.key]: value } }, `${node.id}:${param.key}`)} />
            );
        }
        if (param.kind === 'text') {
            return (
                <label key={param.key} className="block space-y-1">
                    <span className="text-2xs text-gray-500">{param.label}</span>
                    <input aria-label={param.label} value={String(node.params[param.key] ?? '')} maxLength={64}
                        onChange={(event) => onChangeNode({ ...node, params: { ...node.params, [param.key]: event.target.value } }, `${node.id}:${param.key}`)}
                        className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-white" />
                </label>
            );
        }
        if (param.kind === 'select') {
            return (
                <div key={param.key} className="space-y-1">
                    <span className="block text-2xs text-gray-500">{param.label}</span>
                    <Select
                        value={readParam(param, node.params[param.key]) as string}
                        options={(param.options ?? []).map(option => ({ value: option.value, label: option.label }))}
                        placeholder={param.label}
                        onChange={(value: string) => onChangeNode({ ...node, params: { ...node.params, [param.key]: value } }, `${node.id}:${param.key}`)}
                        className="w-full"
                    />
                </div>
            );
        }
        return (
            <ParamField
                key={param.key}
                param={param}
                value={node.params[param.key]}
                textures={textures}
                onChange={(value) => onChangeNode({ ...node, params: { ...node.params, [param.key]: value } }, `${node.id}:${param.key}`)}
            />
        );
    };
    // Settings first, then the values of each group under a header of its own.
    const loose = definition.params.filter(param => !param.group);
    const groups = [...new Set(definition.params.flatMap(param => (param.group ? [param.group] : [])))];
    const used = (group: string) => definition.params.some(param => param.group === group
        && (wired?.has(param.key) || JSON.stringify(readParam(param, node.params[param.key])) !== JSON.stringify(param.default)));
    return (
        <div className="space-y-2 rounded border border-gray-800 bg-gray-900/60 p-2">
            <div className="text-2xs font-bold text-gray-200">
                {title ?? node.name ?? definition.label}
                {!title && node.name && <span className="ml-1 font-normal text-gray-500">{definition.label}</span>}
            </div>
            <p className="text-2xs leading-snug text-gray-500">{definition.description}</p>
            {definition.params.length === 0 && <p className="text-2xs text-gray-500">No settings.</p>}
            {loose.map(field)}
            {groups.map((group) => {
                const open = toggled[group] ?? (OPEN_GROUPS.has(group) || used(group));
                return (
                    <div key={group} className="border-t border-gray-800 pt-1.5">
                        <button
                            type="button"
                            aria-expanded={open}
                            onClick={() => setToggled((current) => ({ ...current, [group]: !open }))}
                            className="flex w-full items-center gap-1 text-left text-2xs font-semibold text-gray-300 hover:text-white"
                        >
                            {open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />}
                            {group}
                            {!open && used(group) && <span className="ml-auto text-2xs font-normal text-gray-500">In use</span>}
                        </button>
                        {open && <div className="mt-1.5 space-y-2">{definition.params.filter(param => param.group === group).map(field)}</div>}
                    </div>
                );
            })}
            {PARAMETER_NODE_PARAMS[node.type] && (
                <label className="block space-y-1" title="Name this value to let each model material using the asset set its own">
                    <span className="text-2xs text-gray-500">Parameter name</span>
                    <input
                        aria-label="Parameter name"
                        value={node.parameter ?? ''}
                        placeholder="Not a parameter"
                        maxLength={MAX_PARAMETER_NAME_LENGTH}
                        onChange={(event) => {
                            const { parameter: _previous, ...rest } = node;
                            // Kept as typed (a trailing space included) and trimmed when read back.
                            onChangeNode(event.target.value ? { ...rest, parameter: event.target.value } : rest, `${node.id}:parameter`);
                        }}
                        className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-white"
                    />
                </label>
            )}
        </div>
    );
};
