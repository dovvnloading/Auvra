
import { useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { InteractionMode, PaintMode, PaintSettings, TransformSettings, ViewportLayout, SculptSettings } from '../types';
import { useScene } from '../../../context/SceneContext';
import { projectService } from '../../../utils/projectService';
import { frontendDiagnostics } from '../../../diagnostics/runtime';

export const useEnvironmentState = () => {
    const { cameraState, levelObjects } = useScene();

    // --- State Definitions ---
    const [interactionMode, setInteractionMode] = useState<InteractionMode>('select');
    const [paintMode, setPaintMode] = useState<PaintMode>('add');
    const [selectedBrushId, setSelectedBrushId] = useState<string | null>(null);
    const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [layout, setLayout] = useState<ViewportLayout>('single');
    const [cameraSpeed, setCameraSpeed] = useState<number>(1);
    const [isMuted, setIsMuted] = useState(false);
    
    // Play Mode Camera persistence
    const editorCameraPos = useRef<THREE.Vector3 | undefined>(undefined);
    const projectIdRef = useRef<string | null>(projectService.getStatus().projectId);

    const [transformSettings, setTransformSettings] = useState<TransformSettings>({
        tool: 'translate',
        space: 'world',
        snapEnabled: true,
        snapGrid: 1.0,
        snapAngle: 15
    });

    const [paintSettings, setPaintSettings] = useState<PaintSettings>({
        radius: 2.0,
        density: 0.5,
        scaleMin: 0.8,
        scaleMax: 1.2,
        rotationVariation: 360,
        alignToNormal: true
    });

    const [sculptSettings, setSculptSettings] = useState<SculptSettings>({
        tool: 'raise',
        radius: 5.0,
        strength: 0.5,
        flattenHeight: 0
    });

    // Selection, tools, and play mode are editor-session state. Clear them
    // when the native host switches projects so no transient environment UI
    // can continue pointing at objects from the previous project.
    useEffect(() => projectService.subscribe((status) => {
        if (projectIdRef.current === status.projectId) return;
        projectIdRef.current = status.projectId;
        setSelectedBrushId(null);
        setSelectedObjectId(null);
        setInteractionMode('select');
        setIsPlaying(false);
        editorCameraPos.current = undefined;
    }), []);

    // --- Logic & Effects ---

    // Auto-switch modes based on selection input
    useEffect(() => {
        if (selectedBrushId) {
            if (interactionMode === 'select' || interactionMode === 'mask') {
                setInteractionMode('place');
            }
        } else if (selectedObjectId) {
            // Only switch to select mode if we aren't in specialized object modes
            // If we select a Terrain, we might want to stay in Select or switch to Sculpt manually
            if (interactionMode !== 'sculpt') {
                setInteractionMode('select');
            }
        }
    }, [selectedBrushId, selectedObjectId]);

    // Handle Viewport Selection logic
    const handleViewportSelect = (id: string | null) => {
        if (interactionMode === 'mask') {
            if (id) {
                const obj = levelObjects.find(o => o.id === id);
                if (obj) {
                    setSelectedBrushId(obj.modelId);
                    setSelectedObjectId(null);
                }
            } else {
                setSelectedBrushId(null);
            }
        } else if (interactionMode === 'sculpt') {
            // In sculpt mode, selecting a terrain object makes it the active target
            if (id) {
                const obj = levelObjects.find(o => o.id === id);
                if (obj && obj.type === 'terrain') {
                    setSelectedObjectId(id);
                }
            }
        } else {
            setSelectedObjectId(id);
            if (id) {
                setSelectedBrushId(null);
                if (interactionMode === 'paint') setInteractionMode('select');
            }
        }
    };

    const handlePlayStart = () => {
        editorCameraPos.current = new THREE.Vector3(...cameraState.position);
        setIsPlaying(true);
    };

    const handlePlayStop = () => {
        setIsPlaying(false);
    };

    const toggleMute = () => setIsMuted(prev => !prev);

    // Helper setters for deep state
    const updateTransformSettings = (updates: Partial<TransformSettings>) => 
        setTransformSettings(prev => ({ ...prev, ...updates }));

    return {
        state: {
            interactionMode,
            paintMode,
            selectedBrushId,
            selectedObjectId,
            transformSettings,
            paintSettings,
            sculptSettings,
            isPlaying,
            layout,
            editorCameraPos,
            cameraSpeed,
            isMuted
        },
        actions: frontendDiagnostics.traceActions('environment_editor', {
            setInteractionMode,
            setPaintMode,
            setSelectedBrushId,
            setSelectedObjectId,
            handleViewportSelect,
            handlePlayStart,
            handlePlayStop,
            updateTransformSettings,
            setPaintSettings,
            setSculptSettings,
            setLayout,
            setCameraSpeed,
            toggleMute
        })
    };
};
