import React, { useMemo, useSyncExternalStore } from 'react';
import type { LevelObject } from '../../../types';
import { PaletteIcon } from '../../UI/Icons';
import { useScene } from '../../../context/SceneContext';
import { materialLibrary } from '../../../runtime/materials/materialLibrary';
import { materialGraphParameters } from '../../../runtime/materials/materialGraph';
import { MaterialParameterFields, isReservedMaterialName } from '../../Tools/MaterialEditor';
import { assetShaderVersions, withObjectParameters, type ObjectMaterialOverrides } from '../../../utils/materialInstances';

/**
 * The level inspector's Material values: a placed object's own values for what its model's material assets
 * leave to each use (their graphs' parameters: numbers, colours, textures and switches). They are this
 * object's alone; the model and its other copies keep theirs. Each material shows how many shader
 * versions its asset builds across the model and its copies, one per choice of its switches.
 */
export const ObjectMaterialValues: React.FC<{
    object: LevelObject;
    onCommit: (next: ObjectMaterialOverrides | undefined) => void;
}> = ({ object, onCommit }) => {
    const { models, textures, levelObjects } = useScene();
    const version = useSyncExternalStore((listener) => materialLibrary.subscribe(listener), () => materialLibrary.version);
    const model = models.find(candidate => candidate.id === object.modelId);
    const copies = useMemo(() => levelObjects.filter(candidate => candidate.modelId === object.modelId), [levelObjects, object.modelId]);
    // The model's materials shaded by an asset that leaves values to its uses (`version`: assets change and load later).
    const materials = useMemo(() => (version >= 0 ? Object.entries(model?.materialOverrides ?? {}) : []).flatMap(([name, override]) => {
        const asset = override.materialId ? materialLibrary.get(override.materialId) : undefined;
        if (!asset || isReservedMaterialName(name) || !materialGraphParameters(asset.graph).length) return [];
        return [{ name, materialId: asset.id, inherited: override.parameters }];
    }), [model, version]);
    if (!model || !materials.length) return null;
    return (
        <div className="space-y-2 pt-2 border-t border-gray-800/50">
            <div className="text-2xs font-bold text-gray-500 flex items-center gap-1.5"><PaletteIcon size={12} /> Material values</div>
            <p className="text-2xs leading-snug text-gray-500">For this object alone: the model and its other copies keep theirs.</p>
            {materials.map(({ name, materialId, inherited }) => (
                <MaterialParameterFields
                    key={name}
                    title={name}
                    materialId={materialId}
                    textures={textures}
                    values={object.materialOverrides?.[name]?.parameters}
                    inherited={inherited}
                    versions={assetShaderVersions(materialId, [model], copies)}
                    onChange={(parameters) => onCommit(withObjectParameters(object.materialOverrides, name, parameters))}
                />
            ))}
        </div>
    );
};
