import React, { useRef, useState, useEffect } from 'react';
import { OrbitControls } from '@react-three/drei';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useScene } from '../../context/SceneContext';

const FreeCameraControls: React.FC<{ 
    initialPosition: [number, number, number], 
    initialTarget: [number, number, number],
    onUpdate: (pos: THREE.Vector3, target: THREE.Vector3) => void 
}> = ({ initialPosition, initialTarget, onUpdate }) => {
  const { camera, gl } = useThree();
  const [isRightMouseDown, setIsRightMouseDown] = useState(false);
  
  // Use refs for state accessed in event handlers/render loop
  const isDragging = useRef(false);
  const keys = useRef(new Set<string>());
  
  // Camera parameters
  const moveSpeed = 8.0; 
  const lookSpeed = 0.003;
  
  // Internal rotation state
  const euler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'));
  
  // Target tracking for free cam (virtual target 1 unit ahead)
  const currentTarget = useRef(new THREE.Vector3(...initialTarget));

  useEffect(() => {
    // Set initial
    camera.position.set(...initialPosition);
    camera.lookAt(...initialTarget);
    
    euler.current.setFromQuaternion(camera.quaternion);

    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 2) { // Right Click
        isDragging.current = true;
        setIsRightMouseDown(true);
        gl.domElement.requestPointerLock();
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 2) {
        isDragging.current = false;
        setIsRightMouseDown(false);
        document.exitPointerLock();
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      
      const movementX = e.movementX || 0;
      const movementY = e.movementY || 0;

      euler.current.y -= movementX * lookSpeed;
      euler.current.x -= movementY * lookSpeed;

      // Clamp pitch
      euler.current.x = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, euler.current.x));

      camera.quaternion.setFromEuler(euler.current);
      
      // Update virtual target based on look direction
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      currentTarget.current.copy(camera.position).add(forward);
    };

    const onKeyDown = (e: KeyboardEvent) => keys.current.add(e.code);
    const onKeyUp = (e: KeyboardEvent) => keys.current.delete(e.code);
    const onContextMenu = (e: Event) => e.preventDefault();

    const domEl = gl.domElement;
    
    // Listeners
    domEl.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousemove', onMouseMove);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    domEl.addEventListener('contextmenu', onContextMenu);

    return () => {
      domEl.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      domEl.removeEventListener('contextmenu', onContextMenu);
      if (document.pointerLockElement === domEl) document.exitPointerLock();
      
      // Sync back to context on unmount
      onUpdate(camera.position.clone(), currentTarget.current.clone());
    };
  }, [camera, gl.domElement]);

  useFrame((_, delta) => {
    if (!isDragging.current && keys.current.size === 0) return;

    // Calculate speed
    let speed = moveSpeed * delta;
    if (keys.current.has('ShiftLeft') || keys.current.has('ShiftRight')) {
      speed *= 2.5; 
    }

    const direction = new THREE.Vector3();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0);

    if (keys.current.has('KeyW')) direction.add(forward);
    if (keys.current.has('KeyS')) direction.sub(forward);
    if (keys.current.has('KeyD')) direction.add(right);
    if (keys.current.has('KeyA')) direction.sub(right);
    if (keys.current.has('KeyE')) direction.add(up); 
    if (keys.current.has('KeyQ')) direction.sub(up); 

    if (direction.lengthSq() > 0) {
      direction.normalize().multiplyScalar(speed);
      camera.position.add(direction);
      currentTarget.current.copy(camera.position).add(forward);
      onUpdate(camera.position.clone(), currentTarget.current.clone());
    }
  });

  return null;
};

interface SceneCameraProps {
  mode: 'orbit' | 'free';
  resetTrigger: number;
}

export const SceneCamera: React.FC<SceneCameraProps> = ({ mode, resetTrigger }) => {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const { camera } = useThree();
  const { cameraState, setCameraState } = useScene();

  const handleReset = () => {
    if (mode === 'orbit' && controlsRef.current) {
      controlsRef.current.target.set(0, 1, 0); 
      camera.position.set(4, 4, 8);
      controlsRef.current.update();
    } else {
        camera.position.set(4, 4, 8);
        camera.lookAt(0, 1, 0);
    }
  };

  useEffect(() => {
    if (resetTrigger > 0) {
      handleReset();
    }
  }, [resetTrigger, mode]);

  // Sync state on unmount
  useEffect(() => {
      return () => {
          if (mode === 'orbit' && controlsRef.current) {
              setCameraState({
                  position: camera.position.toArray(),
                  target: controlsRef.current.target.toArray()
              });
          }
      };
  }, [mode, setCameraState, camera]);

  return (
    <>
      {mode === 'orbit' && (
      <OrbitControls
          ref={controlsRef}
          makeDefault 
          target={cameraState.target}
          camera={camera}
          enableDamping={true}
          dampingFactor={0.05}
          enablePan={true}
          panSpeed={1.0}
          onChange={() => {
            const controls = controlsRef.current;
            if (!controls) return;
            const position = camera.position.toArray();
            const target = controls.target.toArray();
            setCameraState((previous) => (
              previous.position[0] === position[0]
                && previous.position[1] === position[1]
                && previous.position[2] === position[2]
                && previous.target[0] === target[0]
                && previous.target[1] === target[1]
                && previous.target[2] === target[2]
                ? previous
                : { position, target }
            ));
          }}
      />
      )}

      {mode === 'orbit' && (
          // Initialize position once for orbit
          <primitive object={camera} position={cameraState.position} />
      )}

      {mode === 'free' && (
        <FreeCameraControls 
            initialPosition={cameraState.position}
            initialTarget={cameraState.target}
            onUpdate={(pos, target) => {
                setCameraState({
                    position: pos.toArray(),
                    target: target.toArray()
                });
            }}
        />
      )}
    </>
  );
};
