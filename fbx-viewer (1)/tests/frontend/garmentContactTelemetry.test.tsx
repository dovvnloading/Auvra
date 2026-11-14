import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Group } from 'three';
import { GarmentContactControls } from '../../components/Environment/GarmentContactControls';
import { cookComponentGarment, GarmentInstance, readGarmentSettings } from '../../runtime/components/garmentComponent';
import { createComponent } from '../../runtime/components/registry';
import { garmentContacts, GarmentContactLimit as Limit, type GarmentContactSample } from '../../runtime/garments/contactTelemetry';
import { GarmentAvatarContact } from '../../runtime/garments/avatarContact';
import { cookGarment, type GarmentPanel } from '../../runtime/garments/pattern';
import { GarmentSelfContact } from '../../runtime/garments/selfContact';
import { GARMENT_STEP } from '../../runtime/garments/solver';
import type { LevelObject } from '../../types';

const props=()=>{
    const component=createComponent('garment');
    const object:LevelObject={id:'shared',levelId:'level',modelId:'',name:'Actor',type:'prop',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],components:[component]};
    return {object,component};
};
const data=(seconds:number):GarmentContactSample=>({status:'live',seconds,body:'',detail:'',sameLayer:false,orderedLayers:false,self:null,avatar:null});
const changed=()=>{};

describe('editor garment contact diagnostics',()=>{
    it('gates work on observation, throttles by wall time, and discards stale producer writes',()=>{
        const {object,component}=props(),id=component.id;
        const clock=vi.spyOn(performance,'now').mockReturnValue(100);
        const a=garmentContacts.attach(object,id);
        expect(a.due()).toBe(false);
        expect(clock).not.toHaveBeenCalled();
        const stop=garmentContacts.observe(object,id,changed);
        expect(a.due()).toBe(true);
        a.publish(data(1));
        const snapshot=garmentContacts.get(object,id);
        clock.mockReturnValue(300);
        expect(a.due()).toBe(false);
        expect(garmentContacts.get(object,id)).toBe(snapshot);
        clock.mockReturnValue(350);
        expect(a.due()).toBe(true);
        stop();
        const next=garmentContacts.observe(object,id,changed);
        a.publish(data(9)); // previous observer session
        expect(garmentContacts.get(object,id)).toHaveLength(0);
        expect(a.due()).toBe(true);
        a.publish(data(2));
        a.dispose();
        a.publish(data(3));
        expect(garmentContacts.get(object,id)).toHaveLength(0);
        next();
    });

    it('isolates owner identity and multiple components, handles two mounted viewports and uncovers the surviving sample',()=>{
        const {object,component}=props(),id=component.id, duplicate={...object};
        const a=garmentContacts.attach(object,id),b=garmentContacts.attach(object,id);
        const other=garmentContacts.attach(duplicate,id), secondComponent=garmentContacts.attach(object,id+'-other');
        const unsub=garmentContacts.observe(object,id,changed);
        expect(other.due()).toBe(false);
        expect(secondComponent.due()).toBe(false);
        expect(a.due()).toBe(true);expect(b.due()).toBe(true);
        b.publish(data(2));a.publish(data(1));
        expect(garmentContacts.get(object,id).map(s=>s.sample.seconds)).toEqual([1,2]);
        a.dispose();a.dispose();
        expect(garmentContacts.get(object,id).map(s=>s.sample.seconds)).toEqual([2]);
        unsub();b.dispose();other.dispose();secondComponent.dispose();
    });

    it('reads actual solver counters, snapshots them, and removes live counters for cache and unresolved bindings',()=>{
        const {object,component}=props(), id=component.id;
        const unit=cookComponentGarment(undefined);
        const garment=new GarmentInstance(unit,'cotton',true);
        const settings={...readGarmentSettings(component),wind:0,selfCollision:true};
        let now=0;vi.spyOn(performance,'now').mockImplementation(()=>now);
        const stop=garmentContacts.observe(object,id,changed),writer=garmentContacts.attach(object,id);
        try {
            garment.advance(GARMENT_STEP,settings,object.id,writer);
            garment.publishContacts(writer,settings);
            const result=garmentContacts.get(object,id)[0].sample;
            expect(result.self).toEqual(garment.simulation.selfContactStats);
            expect(result.self).not.toBe(garment.simulation.selfContactStats);
            expect(result.seconds).toBe(GARMENT_STEP);
            expect(result.self).not.toBeNull();
            // A single expensive tick between two 4 Hz publications must still be visible.
            const limited = { ...result.self!, broadPhaseLimited:true, advancementLimited:1, limited:true };
            writer.recordTick(limited,null,'','');
            writer.recordTick(result.self,null,'','');
            now+=250;
            garment.publishContacts(writer,settings);
            const view=garmentContacts.get(object,id)[0];
            expect(view.limits & Limit.ClothBroadPhase).toBeTruthy();
            expect(view.limits & Limit.ClothAdvancement).toBeTruthy();
            writer.recordTick(limited,null,'','');
            // A different binding starts a fresh warning window even within the throttle interval.
            expect(writer.due('live','Other','')).toBe(true);
            writer.publish({...data(0),body:'Other'});
            expect(garmentContacts.get(object,id)[0].limits).toBe(0);
            writer.recordTick(limited,null,'','');
            expect(writer.due('cache','','')).toBe(true);
            writer.publish({...data(.25),status:'cache'});
            expect(garmentContacts.get(object,id)[0].limits).toBe(0);
            now+=300;garment.publishContacts(writer,settings,.75);
            expect(garmentContacts.get(object,id)[0].sample).toMatchObject({status:'cache',seconds:.75,self:null,avatar:null});
            const host=new Group();host.add(garment.root);
            now+=300;
            const broken={...settings,collisionMesh:'Unavailable'};
            garment.advance(GARMENT_STEP,broken,object.id);garment.publishContacts(writer,broken);
            expect(garmentContacts.get(object,id)[0].sample).toMatchObject({status:'missing-avatar',self:null,body:'Unavailable'});
            now+=300;
            const missingBone={...settings,followBone:'missing'};
            garment.advance(GARMENT_STEP,missingBone,object.id);garment.publishContacts(writer,missingBone);
            expect(garmentContacts.get(object,id)[0].sample).toMatchObject({status:'missing-bone',self:null});
        } finally {writer.dispose();stop();garment.dispose();}
    });

    it('renders computed layer projections, identifies an exhausted avatar query, and releases a disabled inspector', () => {
        const { object, component } = props();
        const panel = (id: string, layer: number): GarmentPanel => ({
            id, name: id, layer, boundary: [{ id:'a', x:0, y:0 }, { id:'b', x:.1, y:0 }, { id:'c', x:0, y:.1 }],
            grain:[1, 0], placement:{ origin:[0, 0, 0], u:[1, 0, 0], v:[0, 1, 0] }, pins:[],
        });
        const mesh = cookGarment({ version:1, edgeLength:.2, panels:[panel('under', 0), panel('over', 1)], seams:[] });
        const inverseMass = new Float64Array(mesh.positions.length / 3).fill(1);
        const cloth = new GarmentSelfContact(mesh, inverseMass);
        cloth.solve(mesh.positions, mesh.positions.slice(), .004);
        expect(cloth.stats.layerProjections).toBeGreaterThan(0);
        const body = new GarmentAvatarContact(inverseMass, 0);
        const face = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
        body.prepare({ indices:new Uint16Array([0, 1, 2]), positions:face, previousPositions:face });
        body.solve(mesh.positions, mesh.positions.slice(), .002, changed);
        expect(body.stats.vertexPhaseLimited).toBe(true);

        const view = render(<GarmentContactControls object={object} component={component} />);
        const writer = garmentContacts.attach(object, component.id);
        try {
            fireEvent.click(screen.getByRole('button', { name:/Contact diagnostics/ }));
            act(() => {
                writer.recordTick(cloth.stats, body.stats, 'Body', '');
                if (writer.due('live', 'Body', '')) writer.publish({
                    ...data(1), orderedLayers:true, body:'Body', self:cloth.stats, avatar:body.stats,
                });
            });
            expect(screen.getByText('Avatar vertex query limit')).toBeInTheDocument();
            const projections = screen.getByText('Layer contacts / projections').parentElement;
            expect(projections).toHaveTextContent(cloth.stats.layerContacts + ' / ' + cloth.stats.layerProjections);
            expect(screen.getByText('Avatar vertex tests / corrections')).toBeInTheDocument();
            view.rerender(<GarmentContactControls object={object} component={{ ...component, enabled:false }} />);
            expect(screen.getByText('Garment component disabled.')).toBeInTheDocument();
            expect(writer.observed()).toBe(false);
        } finally { view.unmount(); writer.dispose(); }
    });

    it('unsubscribes when folded and switches to a remaining viewport if the selected one is removed',()=>{
        const {object,component}=props(),id=component.id;
        const view=render(<GarmentContactControls object={object} component={component}/>);
        const a=garmentContacts.attach(object,id),b=garmentContacts.attach(object,id);
        try {
            expect(a.due()).toBe(false);
            fireEvent.click(screen.getByRole('button',{name:/Contact diagnostics/}));
            expect(screen.getByText(/Waiting for an editor viewport/)).toBeInTheDocument();
            act(()=>{if(a.due())a.publish(data(1));if(b.due())b.publish({...data(2),status:'cache'});});
            const select=screen.getByLabelText('Garment diagnostics viewport') as HTMLSelectElement;
            fireEvent.change(select,{target:{value:select.options[1].value}});
            expect(screen.getByText(/Playing a baked clip · 2.00/)).toBeInTheDocument();
            act(()=>b.dispose());
            expect(screen.getByText(/Live · 1.00/)).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button',{name:/Contact diagnostics/}));
            expect(garmentContacts.get(object,id)).toHaveLength(0);
            expect(a.due()).toBe(false);
        } finally {view.unmount();a.dispose();b.dispose();}
    });
});
