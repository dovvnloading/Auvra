import React, { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react';
import type * as THREE from 'three';
import { useInstanceHandle, useThree } from '@react-three/fiber';
import { EffectComposer } from '@react-three/postprocessing';
import { Effect, EffectAttribute, EffectPass, Pass, type EffectComposer as PostComposer } from 'postprocessing';
import { TemporalStage } from './temporalStage';

/**
 * A composer that takes its buffers with it. The component leaves them behind when it unmounts, and a stack
 * remounts each time its effects or camera change, so at full size they would soon fill the GPU.
 */
export const OwnedComposer = React.forwardRef<PostComposer, { children: React.ReactNode }>(({ children }, ref) => {
    const composer = useRef<PostComposer>(null);
    useImperativeHandle(ref, () => composer.current!, []);
    useLayoutEffect(() => {
        const owned = composer.current;
        return () => owned?.dispose();
    }, []);
    // The component only follows the canvas's size: without this a new pixel ratio never reaches its buffers.
    const pixelRatio = useThree(state => state.viewport.dpr);
    const size = useThree(state => state.size);
    useEffect(() => { composer.current?.setSize(size.width, size.height); }, [pixelRatio, size]);
    return <EffectComposer ref={composer} multisampling={0} enableNormalPass={false}>{children}</EffectComposer>;
});
OwnedComposer.displayName = 'OwnedComposer';

const isConvolution = (effect: Effect) => (effect.getAttributes() & EffectAttribute.CONVOLUTION) === EffectAttribute.CONVOLUTION;

/** What sits under a group as passes: runs of effects merge into one pass, as they do in the display composer. */
const passesOf = (children: unknown[], camera: THREE.Camera): { passes: Pass[]; merged: EffectPass[] } => {
    const passes: Pass[] = [];
    const merged: EffectPass[] = [];
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child instanceof Effect) {
            const effects = [child];
            if (!isConvolution(child)) {
                let next = children[i + 1];
                while (next instanceof Effect && !isConvolution(next)) {
                    effects.push(next);
                    i += 1;
                    next = children[i + 1];
                }
            }
            const pass = new EffectPass(camera, ...effects);
            passes.push(pass);
            merged.push(pass);
        } else if (child instanceof Pass) {
            passes.push(child);
        }
    }
    return { passes, merged };
};

/**
 * A post-process stack with temporal anti-aliasing: `lit` runs on the scene at the render scale, inside the
 * stage; `display` runs on the resolved picture at the display's size.
 */
export const TemporalPipeline: React.FC<{
    renderScale: number;
    sharpness: number;
    lit: React.ReactNode;
    display: React.ReactNode;
}> = ({ renderScale, sharpness, lit, display }) => {
    const gl = useThree(state => state.gl);
    const scene = useThree(state => state.scene);
    const camera = useThree(state => state.camera);
    const stage = useMemo(() => new TemporalStage(gl, scene, camera), [gl, scene, camera]);
    useEffect(() => () => stage.dispose(), [stage]);
    useEffect(() => stage.setOptions({ renderScale, sharpness }), [stage, renderScale, sharpness]);

    const litGroup = useRef<THREE.Group>(null!);
    const litInstance = useInstanceHandle(litGroup);
    useLayoutEffect(() => {
        const { passes, merged } = passesOf((litInstance.current as unknown as { objects: unknown[] }).objects, camera);
        stage.setChain(passes);
        return () => {
            stage.setChain([]);
            // Only the merged shader and its hold on the effects inside, which belong to the components that made them.
            for (const pass of merged) {
                (pass as unknown as { setEffects: (effects: Effect[]) => void }).setEffects([]);
                pass.fullscreenMaterial.dispose();
            }
        };
    }, [stage, lit, camera, litInstance]);

    // The stage's output stands where the display composer's own scene pass would.
    const composer = useRef<PostComposer>(null);
    useLayoutEffect(() => {
        if (composer.current) composer.current.passes[0].enabled = false;
    });

    // The composer rebuilds its passes whenever its children are new, so they stay the same from render to render.
    const composerChildren = useMemo(() => <><primitive object={stage.output} />{display}</>, [stage, display]);

    return (
        <>
            <group ref={litGroup}>{lit}</group>
            {/* Keyed by the stage: a composer swapping one child for another would run that one last. */}
            <OwnedComposer key={stage.id} ref={composer}>
                {composerChildren}
            </OwnedComposer>
        </>
    );
};
