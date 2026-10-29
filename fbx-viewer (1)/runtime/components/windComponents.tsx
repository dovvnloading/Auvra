import React, { useContext, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { LevelComponent } from '../../types';
import { CLOTH_PINS, ClothSimulation, MAX_CLOTH_RESOLUTION, MIN_CLOTH_RESOLUTION, type ClothPin, type ClothSettings } from '../cloth';
import { combat } from '../destructibles';
import { useGameContent } from '../GameContentContext';
import { usePhysicsQueries } from '../physics';
import { DEFAULT_SPRING_BONES, SpringBones, springBoneMatcher } from '../springBones';
import { windAt, windTime, windZones, type WindZoneShape } from '../wind';
import { ComponentHostContext } from './builtins';
import { findDecalTexture } from './decalComponent';
import type { ComponentDefinition, ComponentRenderProps } from './types';

/**
 * WIND COMPONENTS
 *
 * Cloth: a sheet (a flag, a banner, a curtain, a sail, washing on a line) pinned to its object,
 * blowing in the wind and resting against characters and the ground (runtime/cloth.ts).
 * Wind Zone: wind of its own where it reaches, blowing one way or out from its middle (a fan,
 * a downdraft, a gap that funnels the wind). Wind Sway: how much the object's model sways in the
 * wind, for models whose materials do not say they are foliage, or to keep one still. Spring
 * Bones: the loose parts of a rigged model (hair, a tail, straps, a rope) swing as it moves and
 * stream in the wind (runtime/springBones.ts).
 */

const number = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const color = (value: unknown, fallback: string): string =>
    typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

// ---------------------------------------------------------------------------
// Cloth

export const CLOTH_DEFAULTS = {
    width: 2, height: 1.2, resolution: 24, pin: 'left' as ClothPin, color: '#b8322a', texture: '',
    stiffness: 0.9, bend: 0.3, damping: 0.15, weight: 0.25, wind: 1, thickness: 0.03, collide: true,
};

export interface ClothComponentSettings extends ClothSettings {
    color: string;
    /** A texture asset by id or name; blank: the colour alone. */
    texture: string;
    /** Rests against characters (play). */
    collide: boolean;
}

export const readClothSettings = (component: LevelComponent): ClothComponentSettings => {
    const props = component.props;
    return {
        width: number(props.width, CLOTH_DEFAULTS.width, 0.05, 50),
        height: number(props.height, CLOTH_DEFAULTS.height, 0.05, 50),
        resolution: Math.round(number(props.resolution, CLOTH_DEFAULTS.resolution, MIN_CLOTH_RESOLUTION, MAX_CLOTH_RESOLUTION)),
        pin: (CLOTH_PINS as readonly string[]).includes(props.pin as string) ? props.pin as ClothPin : CLOTH_DEFAULTS.pin,
        color: color(props.color, CLOTH_DEFAULTS.color),
        texture: typeof props.texture === 'string' ? props.texture.trim() : '',
        stiffness: number(props.stiffness, CLOTH_DEFAULTS.stiffness, 0.05, 1),
        bend: number(props.bend, CLOTH_DEFAULTS.bend, 0, 1),
        damping: number(props.damping, CLOTH_DEFAULTS.damping, 0, 1),
        weight: number(props.weight, CLOTH_DEFAULTS.weight, 0.01, 20),
        wind: number(props.wind, CLOTH_DEFAULTS.wind, 0, 10),
        thickness: number(props.thickness, CLOTH_DEFAULTS.thickness, 0, 0.5),
        collide: typeof props.collide === 'boolean' ? props.collide : CLOTH_DEFAULTS.collide,
    };
};

/** A mesh drawn where its vertices say in the world, whatever its parent: it keeps an identity transform. */
class WorldSpaceMesh extends THREE.Mesh {
    constructor(geometry: THREE.BufferGeometry, material: THREE.Material) {
        super(geometry, material);
        this.matrixAutoUpdate = false;
        this.matrixWorldAutoUpdate = false;
        this.frustumCulled = false;
    }

    override updateMatrixWorld(): void {}

    override updateWorldMatrix(): void {}
}

const _wind = { x: 0, y: 0, z: 0 };
const clothWind = (x: number, y: number, z: number, out: typeof _wind) => windAt(x, y, z, windTime(), out);
const _origin = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

const ClothRender: React.FC<ComponentRenderProps> = ({ object, component, mode }) => {
    const settings = useMemo(() => readClothSettings(component), [component]);
    const anchor = useRef<THREE.Group>(null);
    const host = useContext(ComponentHostContext);
    const queries = usePhysicsQueries();
    const { textures } = useGameContent();
    const ground = useRef<{ y: number | null; checked: number }>({ y: null, checked: -Infinity });

    const { simulation, mesh, material } = useMemo(() => {
        const sim = new ClothSimulation(settings);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(sim.positions, 3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('uv', new THREE.BufferAttribute(sim.uvs, 2));
        geometry.setIndex(new THREE.BufferAttribute(sim.indices, 1));
        const cloth = new THREE.MeshStandardMaterial({ color: settings.color, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
        cloth.name = 'Cloth';
        const drawn = new WorldSpaceMesh(geometry, cloth);
        drawn.castShadow = true;
        drawn.receiveShadow = true;
        drawn.name = 'Cloth';
        return { simulation: sim, mesh: drawn, material: cloth };
    // The look (colour, texture) changes without rebuilding the sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings.width, settings.height, settings.resolution, settings.pin, settings.stiffness, settings.bend, settings.damping, settings.weight, settings.wind, settings.thickness]);

    useEffect(() => { material.color.set(settings.color); }, [material, settings.color]);

    const url = findDecalTexture(textures, settings.texture)?.url;
    useEffect(() => {
        if (!url) {
            material.map = null;
            material.needsUpdate = true;
            return undefined;
        }
        let live = true;
        let loaded: THREE.Texture | null = null;
        new THREE.TextureLoader().load(url, texture => {
            if (!live) { texture.dispose(); return; }
            texture.colorSpace = THREE.SRGBColorSpace;
            loaded = texture;
            material.map = texture;
            material.color.set('#ffffff');
            material.needsUpdate = true;
        });
        return () => {
            live = false;
            loaded?.dispose();
        };
    }, [url, material]);

    useEffect(() => () => {
        mesh.geometry.dispose();
        material.dispose();
    }, [mesh, material]);

    useFrame((state, delta) => {
        const owner = host?.current ?? anchor.current?.parent;
        if (!owner) return;
        owner.updateWorldMatrix(true, false);
        const matrix = owner.matrixWorld.elements;
        // In play it rests on the ground under it (looked for now and then) and against characters.
        let floor: number | null = null;
        if (mode === 'runtime') {
            const g = ground.current;
            if (state.clock.elapsedTime - g.checked > 1) {
                g.checked = state.clock.elapsedTime;
                _origin.setFromMatrixPosition(owner.matrixWorld);
                const hit = queries.raycast(_origin, _down, 200, { excludeObjectId: object.id, excludeKinematic: true });
                g.y = hit ? hit.point.y : null;
            }
            floor = g.y;
        }
        const colliders = mode === 'runtime' && settings.collide ? combat().characterCapsules() : [];
        simulation.step(Math.min(delta, 0.1), matrix, clothWind, colliders, floor);
        const geometry = mesh.geometry;
        geometry.getAttribute('position').needsUpdate = true;
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
    });

    return (
        <group ref={anchor}>
            <primitive object={mesh} />
        </group>
    );
};

export const CLOTH_COMPONENT: ComponentDefinition = {
    type: 'cloth',
    label: 'Cloth',
    description: 'A sheet of cloth hanging from the object: a flag, banner, curtain, sail or washing. Its top middle is at the object, and it hangs down local -Y across local X. It blows in the wind (the weather and Wind Zones) and rests against characters and the ground in play.',
    props: [
        { key: 'width', label: 'Width (m)', type: 'number', default: CLOTH_DEFAULTS.width, min: 0.05, max: 50, step: 0.1 },
        { key: 'height', label: 'Height (m)', type: 'number', default: CLOTH_DEFAULTS.height, min: 0.05, max: 50, step: 0.1 },
        { key: 'resolution', label: 'Detail', type: 'number', default: CLOTH_DEFAULTS.resolution, min: MIN_CLOTH_RESOLUTION, max: MAX_CLOTH_RESOLUTION, step: 1 },
        {
            key: 'pin', label: 'Held by', type: 'select', default: CLOTH_DEFAULTS.pin,
            options: [
                { label: 'Left edge (a flag)', value: 'left' },
                { label: 'Top edge (a banner, curtain)', value: 'top' },
                { label: 'Top corners (washing, a hammock)', value: 'topCorners' },
                { label: 'All four corners (a tarp, a sail)', value: 'corners' },
                { label: 'Nothing (it falls)', value: 'none' },
            ],
        },
        { key: 'color', label: 'Colour', type: 'color', default: CLOTH_DEFAULTS.color },
        { key: 'texture', label: 'Texture (id or name)', type: 'string', default: CLOTH_DEFAULTS.texture },
        { key: 'stiffness', label: 'Stiffness', type: 'number', default: CLOTH_DEFAULTS.stiffness, min: 0.05, max: 1, step: 0.05 },
        { key: 'bend', label: 'Fold resistance', type: 'number', default: CLOTH_DEFAULTS.bend, min: 0, max: 1, step: 0.05 },
        { key: 'damping', label: 'Air damping', type: 'number', default: CLOTH_DEFAULTS.damping, min: 0, max: 1, step: 0.05 },
        { key: 'weight', label: 'Weight (kg/m²)', type: 'number', default: CLOTH_DEFAULTS.weight, min: 0.01, max: 20, step: 0.05 },
        { key: 'wind', label: 'Catches the wind', type: 'number', default: CLOTH_DEFAULTS.wind, min: 0, max: 10, step: 0.1 },
        { key: 'thickness', label: 'Thickness (m)', type: 'number', default: CLOTH_DEFAULTS.thickness, min: 0, max: 0.5, step: 0.01 },
        { key: 'collide', label: 'Rests against characters', type: 'boolean', default: CLOTH_DEFAULTS.collide },
    ],
    Render: ClothRender,
};

// ---------------------------------------------------------------------------
// Wind Zone

export const WIND_ZONE_DEFAULTS = { shape: 'directional' as WindZoneShape, strength: 8, radius: 6, turbulence: 0.4 };

export const readWindZone = (component: LevelComponent) => ({
    shape: component.props.shape === 'radial' ? 'radial' as const : 'directional' as const,
    strength: number(component.props.strength, WIND_ZONE_DEFAULTS.strength, -100, 100),
    radius: number(component.props.radius, WIND_ZONE_DEFAULTS.radius, 0, 500),
    turbulence: number(component.props.turbulence, WIND_ZONE_DEFAULTS.turbulence, 0, 1),
});

const _forward = new THREE.Vector3();
const _position = new THREE.Vector3();

const WindZoneRender: React.FC<ComponentRenderProps> = ({ component, mode }) => {
    const settings = useMemo(() => readWindZone(component), [component]);
    const anchor = useRef<THREE.Group>(null);
    const host = useContext(ComponentHostContext);

    useEffect(() => () => windZones.remove(component.id), [component.id]);

    useFrame(() => {
        const owner = host?.current ?? anchor.current?.parent;
        if (!owner) return;
        owner.updateWorldMatrix(true, false);
        _position.setFromMatrixPosition(owner.matrixWorld);
        // It blows along the object's forward (local +Z).
        _forward.set(0, 0, 1).transformDirection(owner.matrixWorld);
        windZones.set(component.id, {
            shape: settings.shape, x: _position.x, y: _position.y, z: _position.z,
            dx: _forward.x, dy: _forward.y, dz: _forward.z,
            strength: settings.strength, radius: settings.shape === 'radial' ? Math.max(0.1, settings.radius) : settings.radius,
            turbulence: settings.turbulence,
        });
    });

    // In the editor: an arrow along its wind, and a ring for its reach.
    return (
        <group ref={anchor}>
            {mode === 'editor' && (
                <>
                    {settings.shape === 'directional' && (
                        <arrowHelper args={[new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), Math.max(0.5, Math.min(6, Math.abs(settings.strength) * 0.3)), 0x7dd3fc]} />
                    )}
                    {settings.radius > 0 && (
                        <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
                            <ringGeometry args={[Math.max(0, settings.radius - 0.05), settings.radius, 64]} />
                            <meshBasicMaterial color="#7dd3fc" transparent opacity={0.5} depthWrite={false} side={THREE.DoubleSide} />
                        </mesh>
                    )}
                </>
            )}
        </group>
    );
};

export const WIND_ZONE_COMPONENT: ComponentDefinition = {
    type: 'windZone',
    label: 'Wind Zone',
    description: "Wind of its own, on top of the weather's: Directional blows along the object's forward (blue arrow), everywhere or within Radius; Radial blows out from its middle (negative strength draws in), within Radius. It fades to nothing at its edge. Cloth, rain and snow feel it.",
    props: [
        { key: 'shape', label: 'Shape', type: 'select', default: WIND_ZONE_DEFAULTS.shape, options: [{ label: 'Directional', value: 'directional' }, { label: 'Radial', value: 'radial' }] },
        { key: 'strength', label: 'Strength (m/s)', type: 'number', default: WIND_ZONE_DEFAULTS.strength, min: -100, max: 100, step: 0.5 },
        { key: 'radius', label: 'Radius (m, 0 everywhere)', type: 'number', default: WIND_ZONE_DEFAULTS.radius, min: 0, max: 500, step: 0.5 },
        { key: 'turbulence', label: 'Turbulence', type: 'number', default: WIND_ZONE_DEFAULTS.turbulence, min: 0, max: 1, step: 0.05 },
    ],
    Render: WindZoneRender,
};

// ---------------------------------------------------------------------------
// Wind Sway

export const readWindSway = (component: LevelComponent) => ({
    sway: number(component.props.sway, 1, 0, 5),
    flutter: number(component.props.flutter, 0.5, 0, 1),
});

const WindSwayRender: React.FC<ComponentRenderProps> = ({ component }) => {
    const settings = useMemo(() => readWindSway(component), [component]);
    const anchor = useRef<THREE.Group>(null);
    const host = useContext(ComponentHostContext);

    useEffect(() => {
        const owner = host?.current ?? anchor.current?.parent;
        if (!owner) return undefined;
        owner.userData.windSway = settings.sway > 0 ? { sway: settings.sway, flutter: settings.flutter } : null;
        return () => { delete owner.userData.windSway; };
    }, [host, settings.sway, settings.flutter]);

    return <group ref={anchor} />;
};

export const WIND_SWAY_COMPONENT: ComponentDefinition = {
    type: 'windSway',
    label: 'Wind Sway',
    description: "How much the object's model sways in the wind, bending from its base: 1 for a tree or grass. Leaves, grass and the like sway by themselves (by their materials' names); use this for other models, to change how much, or with 0 to keep one still.",
    props: [
        { key: 'sway', label: 'Sway', type: 'number', default: 1, min: 0, max: 5, step: 0.05 },
        { key: 'flutter', label: 'Leaf flutter', type: 'number', default: 0.5, min: 0, max: 1, step: 0.05 },
    ],
    Render: WindSwayRender,
};

// ---------------------------------------------------------------------------
// Spring Bones

export const SPRING_DEFAULTS = { bones: DEFAULT_SPRING_BONES, stiffness: 1.5, damping: 0.4, gravity: 6, wind: 0.4 };

export const readSpringSettings = (component: LevelComponent) => ({
    bones: typeof component.props.bones === 'string' && component.props.bones.trim() ? component.props.bones : SPRING_DEFAULTS.bones,
    stiffness: number(component.props.stiffness, SPRING_DEFAULTS.stiffness, 0, 20),
    damping: number(component.props.damping, SPRING_DEFAULTS.damping, 0, 1),
    gravity: number(component.props.gravity, SPRING_DEFAULTS.gravity, -20, 20),
    wind: number(component.props.wind, SPRING_DEFAULTS.wind, 0, 5),
});

const springWind = (x: number, y: number, z: number, out: typeof _wind) => windAt(x, y, z, windTime(), out);

const SpringBonesRender: React.FC<ComponentRenderProps> = ({ component }) => {
    const settings = useMemo(() => readSpringSettings(component), [component]);
    const anchor = useRef<THREE.Group>(null);
    const host = useContext(ComponentHostContext);
    const chains = useRef<{ springs: SpringBones; root: THREE.Object3D; bones: string } | null>(null);
    const search = useRef(0);

    useEffect(() => () => {
        chains.current?.springs.restore();
        chains.current = null;
    }, [settings.bones]);

    useFrame((_, delta) => {
        const owner = host?.current ?? anchor.current?.parent;
        if (!owner) return;
        // The model may load after the component: look for its bones now and then until found.
        if (!chains.current || chains.current.bones !== settings.bones) {
            if (search.current++ % 30 !== 0) return;
            const springs = new SpringBones(owner, springBoneMatcher(settings.bones));
            if (springs.count === 0) return;
            chains.current?.springs.restore();
            chains.current = { springs, root: owner, bones: settings.bones };
        }
        chains.current.springs.update(Math.min(delta, 0.05), settings, springWind);
    });

    return <group ref={anchor} />;
};

export const SPRING_BONES_COMPONENT: ComponentDefinition = {
    type: 'springBones',
    label: 'Spring Bones',
    description: "The loose parts of the object's rigged model (hair, a ponytail, a tail, straps, a rope, a tassel) swing as it moves, sag under gravity and stream in the wind, then settle. Bones whose names contain one of the Bone names words, and the bones below them, take part.",
    props: [
        { key: 'bones', label: 'Bone names (comma separated)', type: 'string', default: SPRING_DEFAULTS.bones },
        { key: 'stiffness', label: 'Stiffness', type: 'number', default: SPRING_DEFAULTS.stiffness, min: 0, max: 20, step: 0.1 },
        { key: 'damping', label: 'Damping', type: 'number', default: SPRING_DEFAULTS.damping, min: 0, max: 1, step: 0.05 },
        { key: 'gravity', label: 'Gravity (m/s²)', type: 'number', default: SPRING_DEFAULTS.gravity, min: -20, max: 20, step: 0.1 },
        { key: 'wind', label: 'Wind', type: 'number', default: SPRING_DEFAULTS.wind, min: 0, max: 5, step: 0.05 },
    ],
    Render: SpringBonesRender,
};

export const WIND_COMPONENTS: ComponentDefinition[] = [CLOTH_COMPONENT, WIND_ZONE_COMPONENT, WIND_SWAY_COMPONENT, SPRING_BONES_COMPONENT];
