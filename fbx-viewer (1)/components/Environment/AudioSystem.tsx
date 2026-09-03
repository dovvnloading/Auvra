
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { LevelObject, AudioData, AudioConfig } from '../../types';

interface AudioSystemProps {
    levelObjects: LevelObject[];
    audioAssets: AudioData[];
    isMuted: boolean;
}

/**
 * Handles initialization and management of THREE.Audio and THREE.PositionalAudio.
 * This runs inside the Canvas context.
 */
export const AudioSystem: React.FC<AudioSystemProps> = ({ levelObjects, audioAssets, isMuted }) => {
    const { camera, scene } = useThree();
    const listenerRef = useRef<THREE.AudioListener | null>(null);
    // PositionalAudio specializes THREE.Audio with a PannerNode output.  The
    // map intentionally stores both variants behind the common Audio API.
    const sourcesRef = useRef<Map<string, THREE.Audio<any>>>(new Map());
    
    // Store latest config per object ID to access inside async callbacks (avoiding stale closures)
    const latestConfigsRef = useRef<Map<string, AudioConfig>>(new Map());
    
    // Track the audio asset ID currently loaded in each source to detect file swaps
    const sourceAssetIdMap = useRef<Map<string, string>>(new Map());

    // 1. Ensure AudioListener exists on the camera
    useEffect(() => {
        const existing = camera.children.find(c => c.type === 'AudioListener');
        let listener: THREE.AudioListener;
        let ownsListener = false;
        
        if (!existing) {
            listener = new THREE.AudioListener();
            camera.add(listener);
            ownsListener = true;
        } else {
            listener = existing as THREE.AudioListener;
        }
        listenerRef.current = listener;
        
        // Initial mute state check
        listener.setMasterVolume(isMuted ? 0 : 1);
        return () => {
            if (ownsListener) camera.remove(listener);
            if (listenerRef.current === listener) listenerRef.current = null;
        };
    }, [camera]); // Only run when camera changes (e.g. initial mount)

    // 2. Handle Mute Toggle
    useEffect(() => {
        if (listenerRef.current) {
            listenerRef.current.setMasterVolume(isMuted ? 0 : 1);
        }
    }, [isMuted]);

    // 3. Sync Audio Objects
    useEffect(() => {
        const listener = listenerRef.current;
        if (!listener) return;

        const currentIds = new Set<string>();

        if (levelObjects) {
            levelObjects.forEach(obj => {
                if (obj.type === 'audio_emitter' && obj.audioConfig && obj.audioConfig.audioId) {
                    const config = obj.audioConfig;
                    const audioData = audioAssets.find(a => a.id === config.audioId);
                    
                    // Always update the ref with the latest config for this frame
                    latestConfigsRef.current.set(obj.id, config);
                    
                    if (!audioData) return;

                    currentIds.add(obj.id);

                    let sound = sourcesRef.current.get(obj.id);
                    const currentLoadedAssetId = sourceAssetIdMap.current.get(obj.id);
                    
                    // Detect type change (Spatial <-> Global)
                    const isPositional = sound instanceof THREE.PositionalAudio;
                    const typeChanged = sound ? (isPositional !== config.isSpatial) : false;
                    const assetChanged = currentLoadedAssetId !== config.audioId;

                    // Create or Re-create if asset swapped or type mismatch
                    if (!sound || assetChanged || typeChanged) {
                        // Cleanup old if exists
                        if (sound) {
                            if (sound.isPlaying) sound.stop();
                            if (sound.userData.parentGroup) scene.remove(sound.userData.parentGroup);
                        }

                        // Setup new sound
                        if (config.isSpatial) {
                            sound = new THREE.PositionalAudio(listener);
                        } else {
                            sound = new THREE.Audio(listener);
                        }

                        // Create container
                        const dummy = new THREE.Group();
                        dummy.position.set(...obj.position);
                        const createdSound = sound;
                        const createdAssetId = config.audioId;
                        dummy.add(createdSound);
                        scene.add(dummy);
                        createdSound.userData = { parentGroup: dummy };

                        // Load Buffer
                        const loader = new THREE.AudioLoader();
                        loader.load(audioData.url, (buffer) => {
                            // A source ID can survive an asset/type replacement;
                            // require both object and asset identity so a late
                            // decode callback cannot attach to the new source.
                            if (sourcesRef.current.get(obj.id) !== createdSound
                                || sourceAssetIdMap.current.get(obj.id) !== createdAssetId) return;
                            
                            // FETCH LATEST CONFIG FROM REF to avoid stale closure issues
                            const currentConfig = latestConfigsRef.current.get(obj.id) || config;
                            
                            createdSound.setBuffer(buffer);
                            
                            // Apply Spatial Settings safely
                            if (createdSound instanceof THREE.PositionalAudio) {
                                createdSound.setRefDistance(currentConfig.refDistance);
                                createdSound.setMaxDistance(currentConfig.maxDistance);
                                createdSound.setRolloffFactor(currentConfig.rolloffFactor);
                            }
                            
                            createdSound.setLoop(currentConfig.loop);
                            
                            // Set Volume considering local mute
                            createdSound.setVolume(currentConfig.muted ? 0 : currentConfig.volume);
                            
                            // Strict Loop Timing
                            const targetLoopStart = currentConfig.loopStart || 0;
                            createdSound.setLoopStart(targetLoopStart);
                            
                            // If loopEnd is provided and valid, use it. Otherwise use full duration.
                            const targetLoopEnd = (currentConfig.loopEnd && currentConfig.loopEnd > 0) ? currentConfig.loopEnd : buffer.duration;
                            createdSound.setLoopEnd(targetLoopEnd);

                            if (currentConfig.autoplay && !createdSound.isPlaying) {
                                createdSound.play();
                            }
                        });

                        sourcesRef.current.set(obj.id, createdSound);
                        sourceAssetIdMap.current.set(obj.id, config.audioId);

                    } else {
                        // --- UPDATE EXISTING ---
                        const dummy = sound.userData.parentGroup;
                        if (dummy) dummy.position.set(...obj.position);

                        // Volume + Local Mute Check
                        const targetVolume = config.muted ? 0 : config.volume;
                        if (sound.getVolume() !== targetVolume) sound.setVolume(targetVolume);
                        
                        // Loop Update Logic
                        if (sound.getLoop() !== config.loop) {
                            sound.setLoop(config.loop);
                            // FIX: If loop is re-enabled, autoplay is ON, and sound is currently stopped (because it finished), restart it.
                            if (config.loop && config.autoplay && !sound.isPlaying && sound.buffer) {
                                sound.play();
                            }
                        }
                        
                        // Live Update Loop Points
                        // We must check buffer duration to handle the "reset to end" case correctly
                        const buffer = sound.buffer;
                        const duration = buffer ? buffer.duration : 0;
                        
                        // Update Loop Start
                        const targetLoopStart = config.loopStart || 0;
                        const source = sound.source;
                        if (source && 'loopStart' in source && source.loopStart !== targetLoopStart) {
                            sound.setLoopStart(targetLoopStart);
                        }

                        // Use explicit config value. If 0 or undefined, logic below handles it.
                        let targetLoopEnd = config.loopEnd || 0;
                        
                        // If we have a buffer loaded, validate the loop end
                        if (duration > 0) {
                            // If loopEnd is 0 (default/unset) or greater than duration, snap to duration
                            if (targetLoopEnd === 0 || targetLoopEnd > duration) {
                                targetLoopEnd = duration;
                            }
                            // Apply immediately to the playing source node if it exists
                            if (source && 'loopEnd' in source && sound.isPlaying) {
                                const bufferSource = source as AudioBufferSourceNode;
                                bufferSource.loopEnd = targetLoopEnd;
                                bufferSource.loopStart = targetLoopStart;
                            }
                        }
                        
                        // Always set on wrapper too so it persists for next play()
                        sound.setLoopEnd(targetLoopEnd);
                        
                        // Handling Spatial Props
                        if (sound instanceof THREE.PositionalAudio) {
                            if (sound.getRefDistance() !== config.refDistance) sound.setRefDistance(config.refDistance);
                            if (sound.getMaxDistance() !== config.maxDistance) sound.setMaxDistance(config.maxDistance);
                            if (sound.getRolloffFactor() !== config.rolloffFactor) sound.setRolloffFactor(config.rolloffFactor);
                        }
                    }
                }
            });
        }

        // Cleanup removed sources during updates
        sourcesRef.current.forEach((sound, id) => {
            if (!currentIds.has(id)) {
                if (sound.isPlaying) sound.stop();
                if (sound.userData.parentGroup) {
                    scene.remove(sound.userData.parentGroup);
                }
                sourcesRef.current.delete(id);
                sourceAssetIdMap.current.delete(id);
                latestConfigsRef.current.delete(id);
            }
        });

    }, [levelObjects, audioAssets, scene]);

    // 4. Global Cleanup on Unmount
    useEffect(() => {
        return () => {
            sourcesRef.current.forEach((sound) => {
                if (sound.isPlaying) sound.stop();
                // Optionally remove from scene, although scene destruction handles this usually.
                // Stopping the audio context node is the critical part.
            });
            sourcesRef.current.clear();
            sourceAssetIdMap.current.clear();
            latestConfigsRef.current.clear();
        };
    }, []);

    return null;
};
