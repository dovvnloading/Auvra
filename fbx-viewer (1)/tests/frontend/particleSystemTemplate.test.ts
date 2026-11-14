import { expect, it } from 'vitest';
import { createIonVortexEmitters } from '../../components/Environment/particleSystemTemplate';
import { resolveParticleEffect } from '../../runtime/particleEffect';
import type { LevelObject } from '../../types';
import { copyLevelObjects, pasteLevelObjects } from '../../utils/levelClipboard';
import { createPrefabFromSubtree, instantiatePrefab } from '../../utils/prefabs';
import { overriddenFields, syncInstance } from '../../utils/prefabSync';

it('keeps particle fields and sibling event links independent across duplication and prefab edits', () => {
    const components = createIonVortexEmitters();
    const [stream, sparks] = components;
    const effect = resolveParticleEffect(stream.props);
    expect(effect.forceFields.map(field => field.kind)).toEqual(['radial', 'vortex', 'directional']);
    effect.subEmitters.push({ trigger: 'death', target: sparks.id, count: 2, inheritVelocity: 0.2 });
    stream.props.effect = effect;
    const actor: LevelObject = {
        id: 'vortex', name: 'Ion Vortex', type: 'prop', levelId: 'one', modelId: '',
        position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1], components,
    };
    const prefab = createPrefabFromSubtree([actor], actor.id, actor.name);
    const [instance] = instantiatePrefab(prefab, 'two', [0, 0, 0]);
    const payload = copyLevelObjects([actor], [actor.id])!;
    const [duplicate] = pasteLevelObjects(payload, { levelObjects: [actor], levelId: 'one' }).objects;
    for (const copy of [duplicate, instance]) {
        const [source, target] = copy.components!;
        const copiedEffect = resolveParticleEffect(source.props);
        expect(target.id).not.toBe(sparks.id);
        expect(copiedEffect.subEmitters[0].target).toBe(target.id);
        expect(copiedEffect.forceFields).toEqual(effect.forceFields);
    }
    expect(overriddenFields(instance, prefab)).toEqual([]);
    const edited = structuredClone(prefab);
    edited.objects[0].components![1].props.emitterName = 'Afterglow';
    const changes = syncInstance([instance], instance, prefab, edited).updates[0].changes.components!;
    expect(changes[1].props.emitterName).toBe('Afterglow');
    expect(changes[1].id).toBe(instance.components![1].id);
    expect(resolveParticleEffect(changes[0].props).subEmitters[0].target).toBe(changes[1].id);
    expect(resolveParticleEffect(createIonVortexEmitters()[0].props).subEmitters).toEqual([]);
});
