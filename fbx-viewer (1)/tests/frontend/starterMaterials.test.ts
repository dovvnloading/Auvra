import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { compileMaterialGraph, materialGraphFeatures } from '../../runtime/materials/materialGraph';
import { bindMaterialGraph } from '../../runtime/materials/graphMaterial';
import { STARTER_MATERIALS } from '../../runtime/materials/starterMaterials';

const starter = (key: string) => STARTER_MATERIALS.find(candidate => candidate.key === key)!;

describe('starter materials', () => {
    it('are offered by name, each with a few plain words', () => {
        expect(STARTER_MATERIALS.map(candidate => candidate.name)).toEqual(['Car paint', 'Frosted glass', 'Velvet', 'Lacquered wood', 'Rubber']);
        for (const candidate of STARTER_MATERIALS) expect(candidate.description.length).toBeGreaterThan(10);
    });

    it('use only the physical parts their look needs', () => {
        expect(materialGraphFeatures(starter('carPaint').graph())).toEqual(['coat']);
        expect(materialGraphFeatures(starter('frostedGlass').graph())).toEqual(['specular', 'transmission']);
        expect(materialGraphFeatures(starter('velvet').graph())).toEqual(['sheen']);
        expect(materialGraphFeatures(starter('lacqueredWood').graph())).toEqual(['coat']);
        expect(materialGraphFeatures(starter('rubber').graph())).toEqual([]);
    });

    it('compile, and are drawn by the material they need', () => {
        for (const candidate of STARTER_MATERIALS) {
            const graph = candidate.graph();
            expect(compileMaterialGraph(graph).unused, candidate.name).toEqual([]);
            const material = new THREE.MeshStandardMaterial();
            bindMaterialGraph(material, graph);
            expect(material.type, candidate.name).toBe(candidate.key === 'rubber' ? 'MeshStandardMaterial' : 'MeshPhysicalMaterial');
        }
    });

    it('make a fresh graph each time, so editing one leaves the starter as it was', () => {
        const first = starter('velvet').graph();
        first.nodes[0].params.roughness = 0.1;
        expect(starter('velvet').graph().nodes[0].params.roughness).toBe(0.9);
    });
});
