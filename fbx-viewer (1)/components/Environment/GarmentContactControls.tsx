import { useCallback, useState, useSyncExternalStore } from 'react';
import { garmentContacts, GarmentContactLimit as Limit, type GarmentContactView } from '../../runtime/garments/contactTelemetry';
import type { ComponentInspectorProps } from '../../runtime/components/types';

const row = 'flex justify-between gap-2';
const reasons: readonly [Limit, string][] = [
    [Limit.ClothBroadPhase, 'Cloth face search limit'], [Limit.ClothFeatures, 'Cloth feature test limit'],
    [Limit.ClothAdvancement, 'Cloth swept iteration limit'], [Limit.LayerCapacity, 'Layer contact storage limit'],
    [Limit.AvatarVertices, 'Avatar vertex query limit'], [Limit.AvatarFeatureVisits, 'Avatar feature BVH visit limit'],
    [Limit.AvatarFeaturePairs, 'Avatar feature test limit'], [Limit.AvatarGeometry, 'Avatar geometry limit'],
    [Limit.InvalidAvatar, 'Invalid avatar geometry'],
];
function Reading({ sample, limits }: GarmentContactView) {
    const { status, self, avatar } = sample;
    if (status === 'cache') return <p>Playing a baked clip · {sample.seconds.toFixed(2)} s</p>;
    if (status === 'missing-avatar') return <p className="text-amber-400">Waiting for skinned mesh “{sample.body}” · {sample.detail.replace(/_/g, ' ')}</p>;
    if (status === 'missing-bone') return <p className="text-amber-400">Waiting for bone “{sample.detail}”</p>;
    return <div className="space-y-1">
        <p>Live · {sample.seconds.toFixed(2)} s · {sample.body || 'Fitting torso'}</p>
        {limits !== 0 && <div className="text-amber-400">
            <p>Issues since the last reading</p>
            {reasons.filter(([flag]) => limits & flag).map(([flag, label]) => <p key={flag}>{label}</p>)}
        </div>}
        {sample.solved === false && <p>Waiting for the first simulation tick with this binding.</p>}
        {(self || avatar) && <p>Latest fixed tick</p>}
        {self && <dl>
            <div className={row}><dt>Cloth face pairs / feature tests</dt><dd>{self.facePairs} / {self.testedFeatures}</dd></div>
            {self.advancementLimited > 0 && <div className={row}><dt>Unresolved swept feature tests</dt><dd>{self.advancementLimited}</dd></div>}
            {sample.sameLayer && <div className={row}><dt>Vertex–face / edge–edge corrections</dt><dd>{self.vertexFace} / {self.edgeEdge}</dd></div>}
            {sample.orderedLayers && <>
                <div className={row}><dt>Layer pairs / fallback pairs</dt><dd>{self.layeredPairs} / {self.layerFallbackPairs}</dd></div>
                <div className={row}><dt>Layer contacts / projections</dt><dd>{self.layerContacts} / {self.layerProjections}</dd></div>
                <div className={row}><dt>Blocked by pins</dt><dd>{self.layerBlocked}</dd></div>
                <div className={row}><dt>Largest remaining layer gap deficit</dt><dd>{(1000 * self.maxLayerDeficit).toFixed(2)} mm</dd></div>
            </>}
        </dl>}
        {avatar && <dl>
            <div className={row}><dt>Cloth vertex tests / corrections</dt><dd>{avatar.testedFeatures} / {avatar.corrections}</dd></div>
            <div className={row}><dt>Avatar vertex tests / corrections</dt><dd>{avatar.testedBodyVertices} / {avatar.bodyVertexCorrections}</dd></div>
            <div className={row}><dt>Edge tests / corrections</dt><dd>{avatar.testedEdges} / {avatar.edgeCorrections}</dd></div>
            <div className={row}><dt>Primary / feature BVH visits</dt><dd>{avatar.nodeVisits} / {avatar.featureNodeVisits}</dd></div>
        </dl>}
        {!self && !sample.sameLayer && !sample.orderedLayers && !sample.body && <p>Analytic fitting torso active. Self-collision is off.</p>}
    </div>;
}

function Monitoring({ object, component }: Pick<ComponentInspectorProps, 'object' | 'component'>) {
    const subscribe = useCallback((f: () => void) => garmentContacts.observe(object, component.id, f), [object, component.id]);
    const current = useCallback(() => garmentContacts.get(object, component.id), [object, component.id]);
    const views = useSyncExternalStore(subscribe, current, current);
    const [requested, select] = useState<number | null>(null);
    const view = views.find(v => v.id === requested) ?? views[0];
    if (!view) return <p>Waiting for an editor viewport to display this garment.</p>;
    return <>
        {views.length > 1 && <label>Viewport
            <select aria-label="Garment diagnostics viewport" value={view.id} onChange={e => select(Number(e.target.value))}
                className="ml-2 rounded border border-gray-700 bg-gray-950">
                {views.map((v, i) => <option key={v.id} value={v.id}>View {i + 1}</option>)}
            </select>
        </label>}
        <Reading {...view} />
    </>;
}

export function GarmentContactControls(props: Pick<ComponentInspectorProps, 'object' | 'component'>) {
    const [open, setOpen] = useState(false);
    return <section className="space-y-1 text-2xs text-gray-300">
        <button type="button" aria-expanded={open} className="rounded text-left hover:text-white"
            onClick={() => setOpen(value => !value)}>{open ? '▾ ' : '▸ '}Contact diagnostics</button>
        {open && (props.component.enabled ? <Monitoring {...props} /> : <p>Garment component disabled.</p>)}
    </section>;
}
