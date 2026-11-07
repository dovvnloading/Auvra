import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..', '..');
const ignoredDirectories = new Set(['dist', 'node_modules', 'scripts', 'tests']);
const generatedPrefixes = ['host/generated/'];

// These modules are intentionally observed through a parent boundary. The list
// is exact so a new runtime module cannot silently inherit an exemption.
const EXEMPT = new Map(Object.entries({
  'components/AnimationGraph/hooks/useAnimationMixer.ts': 'hot-loop',
  'components/Scene/useMeshLod.ts': 'hot-loop',
  'renderer/gpu/probes.ts': 'hot-loop',
  'renderer/gpu/particles/effectParts.ts': 'hot-loop',
  'renderer/gpu/clusters/clusterPass.ts': 'hot-loop',
  'renderer/gpu/GpuRenderer.ts': 'hot-loop',
  'renderer/gpu/buffers.ts': 'hot-loop',
  'renderer/gpu/builtinPasses.ts': 'hot-loop',
  'renderer/gpu/clusters/clusterBuild.ts': 'hot-loop',
  'renderer/gpu/clusters/clusterFormat.ts': 'hot-loop',
  'renderer/gpu/device.ts': 'hot-loop',
  'renderer/gpu/effects/common.ts': 'hot-loop',
  'renderer/gpu/effects/decals.ts': 'hot-loop',
  'renderer/gpu/effects/fatLines.ts': 'hot-loop',
  'renderer/gpu/effects/precipitation.ts': 'hot-loop',
  'renderer/gpu/effects/skidMarks.tsx': 'hot-loop',
  'renderer/gpu/effects/surfaceDraw.ts': 'hot-loop',
  'renderer/gpu/effects/surfaceKinds.ts': 'hot-loop',
  'renderer/gpu/effects/surfaceWeather.ts': 'hot-loop',
  'renderer/gpu/effects/water.tsx': 'hot-loop',
  'renderer/gpu/frame.ts': 'hot-loop',
  'renderer/gpu/frameTimings.ts': 'hot-loop',
  'renderer/gpu/geometryPool.ts': 'hot-loop',
  'renderer/gpu/gi/GpuBakedLighting.tsx': 'hot-loop',
  'renderer/gpu/gi/GpuDynamicGi.tsx': 'hot-loop',
  'renderer/gpu/gi/giScreen.ts': 'hot-loop',
  'renderer/gpu/gi/giShared.ts': 'hot-loop',
  'renderer/gpu/gi/giSystem.ts': 'hot-loop',
  'renderer/gpu/gi/giWgsl.ts': 'hot-loop',
  'renderer/gpu/gi/lightBaker.ts': 'hot-loop',
  'renderer/gpu/gi/lightVolume.ts': 'hot-loop',
  'renderer/gpu/gi/lightVolumeWgsl.ts': 'hot-loop',
  'renderer/gpu/gi/rayTables.ts': 'hot-loop',
  'renderer/gpu/gi/rayWgsl.ts': 'hot-loop',
  'renderer/gpu/gi/textureMeans.ts': 'hot-loop',
  'renderer/gpu/gpuScene.ts': 'hot-loop',
  'renderer/gpu/lightingWgsl.ts': 'hot-loop',
  'renderer/gpu/lodSelect.ts': 'hot-loop',
  'renderer/gpu/materialPool.ts': 'hot-loop',
  'renderer/gpu/particles/computeEmitter.ts': 'hot-loop',
  'renderer/gpu/particles/particlePipelines.ts': 'hot-loop',
  'renderer/gpu/particles/particleWgsl.ts': 'hot-loop',
  'renderer/gpu/particles/particleWorld.ts': 'hot-loop',
  'renderer/gpu/particles/vectorField.ts': 'hot-loop',
  'renderer/gpu/passes/deferredLighting.ts': 'hot-loop',
  'renderer/gpu/passes/depthPyramid.ts': 'hot-loop',
  'renderer/gpu/passes/forward.ts': 'hot-loop',
  'renderer/gpu/passes/lightClusters.ts': 'hot-loop',
  'renderer/gpu/passes/shadows.ts': 'hot-loop',
  'renderer/gpu/passes/skinning.ts': 'hot-loop',
  'renderer/gpu/passes/surfaces.ts': 'hot-loop',
  'renderer/gpu/passes/virtualShadows.ts': 'hot-loop',
  'renderer/gpu/post/GpuPostStack.tsx': 'hot-loop',
  'renderer/gpu/post/looks.ts': 'hot-loop',
  'renderer/gpu/post/postImages.ts': 'hot-loop',
  'renderer/gpu/post/postSettings.ts': 'hot-loop',
  'renderer/gpu/post/postShaders.ts': 'hot-loop',
  'renderer/gpu/post/postStack.ts': 'hot-loop',
  'renderer/gpu/post/present.ts': 'hot-loop',
  'renderer/gpu/post/temporalShaders.ts': 'hot-loop',
  'renderer/gpu/report.ts': 'hot-loop',
  'renderer/gpu/screen/GpuScreenLighting.tsx': 'hot-loop',
  'renderer/gpu/screen/screenPasses.ts': 'hot-loop',
  'renderer/gpu/screen/screenShaders.ts': 'hot-loop',
  'renderer/gpu/shaders.ts': 'hot-loop',
  'renderer/gpu/sky/GpuSkySystem.tsx': 'hot-loop',
  'renderer/gpu/sky/SkyPass.ts': 'hot-loop',
  'renderer/gpu/sky/atmosphereTables.ts': 'hot-loop',
  'renderer/gpu/sky/cloudMap.ts': 'hot-loop',
  'renderer/gpu/sky/dome.ts': 'hot-loop',
  'renderer/gpu/sky/skyCapture.ts': 'hot-loop',
  'renderer/gpu/sky/skyOverlay.ts': 'hot-loop',
  'renderer/gpu/sky/skySettings.ts': 'hot-loop',
  'renderer/gpu/sky/skyVisibility.ts': 'hot-loop',
  'renderer/gpu/surfaces.ts': 'hot-loop',
  'renderer/gpu/surfaces/bakedVolume.ts': 'hot-loop',
  'renderer/gpu/surfaces/glslToWgsl.ts': 'hot-loop',
  'renderer/gpu/surfaces/graph.ts': 'hot-loop',
  'renderer/gpu/surfaces/builtinLooks.ts': 'hot-loop',
  'renderer/gpu/surfaces/impostor.ts': 'hot-loop',
  'renderer/gpu/surfaces/index.ts': 'hot-loop',
  'renderer/gpu/surfaces/lit.ts': 'hot-loop',
  'renderer/gpu/surfaces/materialHooks.ts': 'hot-loop',
  'renderer/gpu/surfaces/materialWgsl.ts': 'hot-loop',
  'renderer/gpu/surfaces/terrain.ts': 'hot-loop',
  'renderer/gpu/surfaces/water.ts': 'hot-loop',
  'renderer/gpu/surfaces/physicalLayers.ts': 'hot-loop',
  'renderer/gpu/surfaces/weather.ts': 'hot-loop',
  'renderer/gpu/surfaces/wind.ts': 'hot-loop',
  'renderer/gpu/surfaces/world.ts': 'hot-loop',
  'renderer/gpu/texturePool.ts': 'hot-loop',
  'workers/clusterBuild.worker.ts': 'hot-loop',
  'components/AnimationGraph/GraphRuntime.tsx': 'hot-loop-controller',
  'components/AnimationGraph/hooks/useGraphAnimator.ts': 'hot-loop',
  'components/AnimationGraph/hooks/useGraphConnections.ts': 'pure-derived-state',
  'components/AnimationGraph/hooks/useGraphContext.ts': 'context-adapter',
  'components/AnimationGraph/hooks/useGraphLocomotion.ts': 'hot-loop',
  'components/AnimationGraph/hooks/useGraphNodeDrag.ts': 'input-adapter',
  'components/AnimationGraph/hooks/useGraphRuntime.ts': 'hot-loop',
  'components/AnimationGraph/hooks/useGraphViewport.ts': 'input-adapter',
  'components/AnimationGraph/hooks/useInputHandler.ts': 'input-adapter',
  'services/providerPicks.ts': 'pure-utility',
  'components/Materials/graphFromTextures.ts': 'pure-utility',
  'components/Materials/previewLighting.ts': 'pure-utility',
  'components/Tools/Retexture/keepOriginal.ts': 'pure-utility',
  'components/Tools/paintedPictures.ts': 'pure-utility',
  'components/Texturing/graphEditing.ts': 'pure-utility',
  'components/Texturing/view2d.ts': 'pure-utility',
  'components/Texturing/codeText.ts': 'pure-utility',
  'components/Texturing/eyedropper.ts': 'input-adapter',
  'components/NodeGraph/arrange.ts': 'pure-utility',
  'components/NodeGraph/finder.ts': 'pure-utility',
  'components/NodeGraph/frames.ts': 'pure-utility',
  'components/NodeGraph/layout.ts': 'pure-utility',
  'components/NodeGraph/model.ts': 'pure-utility',
  'components/NodeGraph/types.ts': 'data-model',
  'components/NodeGraph/wires.ts': 'pure-utility',
  'components/Materials/materialNodeViews.ts': 'pure-utility',
  'texturing/gpu/glslLibrary.ts': 'pure-utility',
  'texturing/graph/document.ts': 'data-model',
  'texturing/graph/evaluator.ts': 'hot-loop',
  'texturing/graph/expressions.ts': 'pure-utility',
  'texturing/graph/nodeKit.ts': 'pure-utility',
  'texturing/graph/nodes/adjust.ts': 'pure-utility',
  'texturing/graph/nodes/distance.ts': 'pure-utility',
  'texturing/graph/nodes/generators.ts': 'pure-utility',
  'texturing/graph/nodes/io.ts': 'pure-utility',
  'texturing/graph/nodes/materials.ts': 'pure-utility',
  'texturing/graph/material.ts': 'pure-utility',
  'texturing/graph/namedLinks.ts': 'pure-utility',
  'texturing/graph/scatter.ts': 'pure-utility',
  'texturing/graph/nodes/scatter.ts': 'pure-utility',
  'texturing/graph/inherit.ts': 'pure-utility',
  'texturing/graph/flood.ts': 'pure-utility',
  'texturing/graph/functionGraph.ts': 'pure-utility',
  'texturing/graph/parameters.ts': 'pure-utility',
  'texturing/graph/safeTransform.ts': 'pure-utility',
  'texturing/graph/noiseMath.ts': 'pure-utility',
  'texturing/graph/nodes/noises.ts': 'pure-utility',
  'texturing/graph/nodes/patterns.ts': 'pure-utility',
  'texturing/graph/nodes/colour.ts': 'pure-utility',
  'texturing/graph/nodes/filters.ts': 'pure-utility',
  'texturing/graph/nodes/geometry.ts': 'pure-utility',
  'texturing/graph/nodes/weathering.ts': 'pure-utility',
  'texturing/graph/nodes/photo.ts': 'pure-utility',
  'texturing/graph/seamCut.ts': 'pure-utility',
  'texturing/graph/curves.ts': 'pure-utility',
  'texturing/graph/nodes/splines.ts': 'pure-utility',
  'texturing/graph/nodes/vector.ts': 'pure-utility',
  'texturing/graph/svgPaths.ts': 'pure-utility',
  'texturing/graph/nodes/text.ts': 'pure-utility',
  'texturing/graph/iterate.ts': 'pure-utility',
  'texturing/graph/nodes/processors.ts': 'pure-utility',
  'components/NodeGraph/tidy.ts': 'pure-utility',
  'texturing/graph/nodes/transform.ts': 'pure-utility',
  'texturing/graph/registry.ts': 'data-model',
  'texturing/graph/stored.ts': 'data-model',
  'texturing/graph/types.ts': 'data-model',
  'texturing/materialOutput.ts': 'pure-utility',
  'texturing/zip.ts': 'pure-utility',
  'texturing/png.ts': 'pure-utility',
  'texturing/bake/meshBaker.ts': 'hot-loop',
  'texturing/bake/meshTracer.ts': 'pure-utility',
  'texturing/bake/uvRaster.ts': 'hot-loop',
  'texturing/mesh/partMesh.ts': 'pure-utility',
  'texturing/mesh/picker.ts': 'pure-utility',
  'texturing/paint/paintTypes.ts': 'data-model',
  'texturing/paint/paintStack.ts': 'hot-loop',
  'texturing/paint/strokes.ts': 'hot-loop',
  'texturing/paint/smartLibrary.ts': 'data-model',
  'texturing/paint/regions.ts': 'pure-utility',
  'texturing/paint/sparsePicture.ts': 'hot-loop',
  'texturing/paint/materialPresets.ts': 'data-model',
  'texturing/paint/smartMaterials.ts': 'pure-utility',
  'texturing/paint/selection.ts': 'pure-utility',
  'texturing/paint/brushLibrary.ts': 'data-model',
  'texturing/paint/paths.ts': 'pure-utility',
  'texturing/paint/projections.ts': 'pure-utility',
  'texturing/bake/bakeSetup.ts': 'pure-utility',
  'texturing/uv/relax.ts': 'pure-utility',
  'texturing/paint/exportTemplates.ts': 'data-model',
  'texturing/paint/pictureFiles.ts': 'pure-utility',
  'texturing/paint/gltfExport.ts': 'pure-utility',
  'texturing/paint/channelDownload.ts': 'pure-utility',
  'texturing/paint/uvSurface.ts': 'pure-utility',
  'texturing/paint/history.ts': 'pure-utility',
  'texturing/paint/particles.ts': 'pure-utility',
  'texturing/paint/decals.ts': 'pure-utility',
  'components/Texturing/Paint/openMaterial.ts': 'pure-utility',
  'components/Texturing/Paint/graphPictures.ts': 'pure-utility',
  'components/Texturing/Paint/pathLaying.ts': 'pure-utility',
  'texturing/uv/uvTopology.ts': 'pure-utility',
  'texturing/uv/lscm.ts': 'pure-utility',
  'texturing/uv/unwrap.ts': 'pure-utility',
  'texturing/uv/overlap.ts': 'pure-utility',
  'texturing/uv/pack.ts': 'pure-utility',
  'texturing/uv/uvLayout.ts': 'pure-utility',
  'texturing/uv/transfer.ts': 'hot-loop',
  'texturing/uv/uvWork.ts': 'protocol-model',
  'texturing/uv/uvWork.worker.ts': 'worker-protocol',
  'components/Texturing/Paint/uvSession.ts': 'direct',
  'components/Environment/renderBundle.ts': 'pure-utility',
  'components/Tools/Retexture/surfaceLimits.ts': 'pure-utility',
  'components/Tools/Retexture/viewSheet.ts': 'pure-utility',
  'components/Environment/renderCapture.ts': 'pure-utility',
  'runtime/materials/captureMaterial.ts': 'pure-utility',
  'runtime/frameLook.ts': 'pure-utility',
  'utils/projectRecords.ts': 'pure-utility',
  'utils/clipRanges.ts': 'pure-utility',
  'utils/clipTakes.ts': 'pure-utility',
  'utils/previewResources.ts': 'pure-utility',
  'components/Scripting/scriptDiff.ts': 'pure-utility',
  'components/AnimationGraph/utils/blending.ts': 'pure-utility',
  'components/AnimationGraph/utils/transitions.ts': 'pure-utility',
  'components/AnimationGraph/utils/graphMath.ts': 'pure-utility',
  'components/AnimationGraph/utils/boneMask.ts': 'pure-utility',
  'components/AnimationGraph/utils/clipMatching.ts': 'pure-utility',
  'components/AnimationGraph/utils/montage.ts': 'hot-loop',
  'components/AnimationGraph/utils/notifies.ts': 'pure-utility',
  'components/AnimationGraph/utils/rootMotion.ts': 'hot-loop',
  'components/AnimationGraph/utils/syncGroups.ts': 'hot-loop',
  'components/AnimationGraph/utils/stateMachines.ts': 'pure-utility',
  'components/AnimationGraph/utils/curves.ts': 'pure-utility',
  'components/AnimationGraph/utils/groundSpeed.ts': 'pure-utility',
  'components/Environment/componentInspectors.ts': 'data-model',
  'components/Sandbox/CharacterIK.tsx': 'hot-loop-controller',
  'components/Scripting/scriptTemplates.ts': 'data-model',
  'runtime/components/scriptComponent.tsx': 'data-model',
  'runtime/ik.ts': 'hot-loop',
  'runtime/ragdoll.ts': 'hot-loop',
  'runtime/motionMatching.ts': 'hot-loop',
  'runtime/locomotion/springs.ts': 'pure-utility',
  'runtime/locomotion/characterMotion.ts': 'hot-loop',
  'runtime/locomotion/inertialization.ts': 'hot-loop',
  'runtime/MovementDebug.tsx': 'hot-loop',
  'runtime/motionDatabase.ts': 'pure-utility',
  'runtime/proceduralRig.ts': 'hot-loop',
  'runtime/levelStreaming.ts': 'pure-utility',
  'runtime/levelAssets.ts': 'pure-utility',
  'runtime/assetResidency.ts': 'pure-utility',
  'runtime/worldGrid.ts': 'pure-utility',
  'runtime/occlusionCulling.ts': 'hot-loop',
  'utils/projectChangeBatches.ts': 'pure-utility',
  'runtime/WorldGridLayer.tsx': 'hot-loop',
  'runtime/components/worldGridComponent.tsx': 'data-model',
  'runtime/cameraDirector.ts': 'hot-loop',
  'runtime/net/protocol.ts': 'protocol-model',
  'runtime/net/replication.ts': 'hot-loop',
  'runtime/scripting/protocol.ts': 'protocol-model',
  'runtime/scripting/scriptApi.ts': 'sandbox-proxy',
  'runtime/timeline/evaluate.ts': 'pure-utility',
  'runtime/timeline/poser.ts': 'hot-loop',
  'runtime/timeline/preview.ts': 'pure-derived-state',
  'runtime/cinematics.ts': 'pure-derived-state',
  'runtime/spawning.ts': 'pure-utility',
  'runtime/weapons.ts': 'pure-utility',
  'runtime/weaponFit.ts': 'pure-utility',
  'runtime/weaponMuzzle.ts': 'pure-utility',
  'runtime/aimTarget.ts': 'pure-utility',
  'runtime/playerActions.ts': 'pure-utility',
  'utils/appDialogs.ts': 'pure-utility',
  'utils/retargeting.ts': 'pure-utility',
  'utils/latestWriter.ts': 'pure-utility',
  'utils/mountedParts.ts': 'pure-utility',
  'utils/viewerModel.ts': 'pure-utility',
  'utils/meshLod.ts': 'pure-utility',
  'utils/instanceCulling.ts': 'hot-loop',
  'utils/processing/opacityMaps.ts': 'pure-utility',
  'utils/autoRig/bodyField.ts': 'pure-utility',
  'utils/autoRig/bodyMarkers.ts': 'pure-utility',
  'utils/autoRig/bodySkeleton.ts': 'pure-utility',
  'utils/autoRig/fourLegReading.ts': 'pure-utility',
  'utils/autoRig/handReading.ts': 'pure-utility',
  'utils/autoRig/rigBody.ts': 'pure-utility',
  'utils/autoRig/riggedGlb.ts': 'pure-utility',
  'utils/autoRig/skinWeights.ts': 'pure-utility',
  'utils/autoRig/voxels.ts': 'pure-utility',
  'utils/fbxImport/clipOrder.ts': 'pure-utility',
  'utils/modelConventions.ts': 'pure-utility',
  'utils/fbxImport/gltfReport.ts': 'pure-utility',
  'utils/humanoidShape.ts': 'pure-utility',
  'utils/skeletonView.ts': 'pure-utility',
  'utils/skinPaint/modelSkin.ts': 'pure-utility',
  'utils/skinPaint/skinPaintFile.ts': 'pure-utility',
  'utils/skinPaint/vertexPlaces.ts': 'pure-utility',
  'utils/skinPaint/weights.ts': 'pure-utility',
  'utils/fbxImport/imagePixels.ts': 'pure-utility',
  'utils/fbxImport/importedModel.ts': 'pure-utility',
  'utils/fbxImport/nativeImporter.ts': 'pure-utility',
  'components/Dialogue/dialogueEditing.ts': 'pure-utility',
  'runtime/timeline/types.ts': 'data-model',
  'script-frame.ts': 'sandbox-proxy',
  'components/Environment/hooks/useEnvironmentHotkeys.ts': 'input-adapter',
  'components/Environment/AudioSystem.tsx': 'hot-loop-controller',
  'components/Environment/types.ts': 'data-model',
  'components/HUDEditor/hudExecutionGuard.ts': 'sandbox-proxy',
  'components/HUDEditor/types.ts': 'data-model',
  'components/LevelBlueprint/overlapTargets.ts': 'pure-utility',
  'components/Sandbox/AIController.tsx': 'hot-loop-controller',
  'components/Sandbox/CharacterCameraRig.tsx': 'hot-loop-controller',
  'runtime/VehicleCamera.tsx': 'hot-loop-controller',
  'components/Sandbox/PlayerController.tsx': 'hot-loop-controller',
  'components/Scene/AttachmentController.tsx': 'render-controller',
  'components/UI/GlobalLoader.tsx': 'deprecated-noop',
  'components/Sandbox/AI/AIConfig.ts': 'data-model',
  'components/Sandbox/AI/AISenses.ts': 'hot-loop',
  'components/Sandbox/AI/AIStateMachine.ts': 'hot-loop',
  'components/Sandbox/AI/useAIBrain.ts': 'hot-loop',
  'components/Sandbox/AI/useAILocomotion.ts': 'hot-loop',
  'components/Sandbox/AI/useBehaviorBrain.ts': 'hot-loop',
  'runtime/behaviorTree.ts': 'hot-loop',
  'runtime/awareness.ts': 'hot-loop',
  'components/Sandbox/hooks/useDamageFlash.ts': 'hot-loop',
  'components/Sandbox/hooks/useEntityHealth.ts': 'hot-loop',
  'components/Sandbox/combat.ts': 'hot-loop',
  'components/UI/Browser/browserFolders.ts': 'pure-utility',
  'components/UI/colourMath.ts': 'pure-utility',
  'components/UI/Icons/glyphs.ts': 'data-model',
  'runtime/audioMixer.ts': 'pure-utility',
  'runtime/components/registry.ts': 'data-model',
  'runtime/levelVariables.ts': 'pure-derived-state',
  'components/Environment/Terrain/terrainSplatCodec.ts': 'pure-utility',
  'components/Environment/Terrain/terrainChunks.ts': 'pure-utility',
  'components/Environment/Terrain/terrainBrush.ts': 'pure-utility',
  'components/Environment/Terrain/terrainEditLayers.ts': 'pure-utility',
  'components/Environment/Foliage/foliagePlacement.ts': 'pure-utility',
  'components/Environment/Foliage/foliageSettings.ts': 'pure-utility',
  'components/Environment/Terrain/terrainLayerTextures.ts': 'pure-utility',
  'components/Environment/Terrain/terrainWeightTools.ts': 'pure-utility',
  'components/Environment/Terrain/terrainBrushOverlay.ts': 'pure-utility',
  'components/Environment/Terrain/terrainHeightmapFile.ts': 'pure-utility',
  'components/Environment/Terrain/terrainLiveEdit.ts': 'pure-utility',
  'components/Environment/Terrain/terrainSculptTools.ts': 'pure-utility',
  'components/Environment/Terrain/terrainTool.ts': 'pure-utility',
  'components/Environment/Terrain/terrainLayerMaterial.ts': 'pure-utility',
  'components/Environment/Terrain/terrainSplatEditor.ts': 'context-adapter',
  'runtime/localization.ts': 'pure-derived-state',
  'runtime/navigation.ts': 'pure-utility',
  'runtime/materials/materialGraph.ts': 'pure-utility',
  'runtime/materials/graphMaterial.ts': 'pure-utility',
  'runtime/materials/materialTypes.ts': 'data-model',
  'runtime/materials/materialNodes.ts': 'pure-utility',
  'runtime/materials/materialGlsl.ts': 'pure-utility',
  'runtime/materials/materialPreviews.ts': 'hot-loop',
  'components/Materials/materialGraphEditing.ts': 'pure-utility',
  'runtime/materials/materialLibrary.ts': 'data-model',
  'runtime/materials/MaterialClock.tsx': 'hot-loop',
  'runtime/materials/shaderStages.ts': 'pure-utility',
  'runtime/materials/physicalSurface.ts': 'pure-utility',
  'runtime/materials/starterMaterials.ts': 'data-model',
  'utils/materialInstances.ts': 'pure-utility',
  'utils/paintedCopies.ts': 'pure-utility',
  'texturing/materialX.ts': 'pure-utility',
  'utils/userMaterialLibrary.ts': 'data-model',
  'utils/userMaterialLibraryActions.ts': 'pure-utility',
  'components/Materials/materialBalls.ts': 'renderer-child-boundary',
  'components/Materials/ballShelf.ts': 'data-model',
  'runtime/materials/triplanarNormal.ts': 'pure-utility',
  'runtime/materials/shaderErrors.ts': 'pure-utility',
  'texturing/textureDecode.ts': 'pure-utility',
  'texturing/compressedContainer.ts': 'pure-utility',
  'components/Materials/materialDeletion.ts': 'pure-utility',
  'texturing/textureSettings.ts': 'pure-utility',
  'texturing/texturePipeline.ts': 'pure-utility',
  'texturing/textureBudget.ts': 'pure-utility',
  'texturing/materialTextureLoader.ts': 'pure-utility',
  'utils/textureCompression/materialTextureEncoder.ts': 'pure-utility',
  'utils/textureCompression/astcEncoder.ts': 'pure-utility',
  'utils/textureCompression/etc2Encoder.ts': 'pure-utility',
  'runtime/materials/bounceColour.ts': 'hot-loop',
  'runtime/navGeometry.ts': 'pure-utility',
  'runtime/levelObjectMotion.ts': 'pure-utility',
  'runtime/perception.ts': 'context-adapter',
  'runtime/audioOcclusion.ts': 'hot-loop',
  'runtime/spatialAudio.ts': 'hot-loop',
  'runtime/splines.ts': 'pure-utility',
  'runtime/vehicles.ts': 'pure-derived-state',
  'runtime/vehicleSim.ts': 'pure-derived-state',
  'runtime/surfaces.ts': 'pure-utility',
  'runtime/particleEffect.ts': 'pure-utility',
  'runtime/particleEmitters.ts': 'pure-derived-state',
  'runtime/particleSimulation.ts': 'hot-loop',
  'runtime/particleRenderer.ts': 'hot-loop',
  'runtime/gpuParticles.ts': 'hot-loop',
  'runtime/abilities.ts': 'pure-derived-state',
  'runtime/abilityWorld.ts': 'pure-derived-state',
  'runtime/proceduralScatter.ts': 'pure-utility',
  'runtime/particleSprites.ts': 'pure-utility',
  'runtime/weather.ts': 'pure-derived-state',
  'runtime/weatherCover.ts': 'hot-loop',
  'runtime/weatherSurfaces.ts': 'hot-loop',
  'runtime/precipitation.ts': 'hot-loop',
  'components/Environment/sky/skyObjects.ts': 'hot-loop',
  'components/Environment/sky/skyShaders.ts': 'pure-utility',
  'runtime/fracture.ts': 'pure-utility',
  'runtime/debris.ts': 'hot-loop',
  'runtime/destructibles.ts': 'pure-derived-state',
  'runtime/impactEffects.ts': 'hot-loop',
  'runtime/wind.ts': 'pure-derived-state',
  'runtime/cloth.ts': 'hot-loop',
  'runtime/springBones.ts': 'hot-loop',
  'runtime/daylight.ts': 'pure-derived-state',
  'runtime/postEffects.ts': 'hot-loop',
  'runtime/gbuffer.ts': 'hot-loop',
  'runtime/screenLighting.ts': 'hot-loop',
  'runtime/skidMarks.ts': 'hot-loop',
  'runtime/components/tyreEffects.ts': 'hot-loop',
  'runtime/components/vehicleAudio.ts': 'hot-loop',
  'runtime/components/vehicleLights.ts': 'hot-loop',
  'runtime/splineMesh.ts': 'pure-utility',
  'runtime/splineRegistry.ts': 'pure-derived-state',
  'components/Environment/splineEditing.ts': 'pure-derived-state',
  'components/Environment/splineTerrain.ts': 'pure-utility',
  'components/Environment/gizmoPointer.ts': 'input-adapter',
  'runtime/patrolPath.ts': 'hot-loop',
  'runtime/scripting/scriptSplines.ts': 'pure-utility',
  'runtime/lighting/bakedLighting.ts': 'pure-utility',
  'runtime/lighting/distanceShadows.ts': 'hot-loop',
  'runtime/lighting/skyScene.ts': 'hot-loop',
  'runtime/keptDepth.ts': 'hot-loop',
  'runtime/lighting/dynamicGi/LevelDynamicGi.tsx': 'hot-loop',
  'runtime/lighting/dynamicGi/giMaterials.ts': 'hot-loop',
  'runtime/lighting/dynamicGi/giShaders.ts': 'pure-utility',
  'runtime/lighting/dynamicGi/giSystem.ts': 'hot-loop',
  'runtime/lighting/dynamicGi/probeGrid.ts': 'pure-utility',
  'components/Scripting/scriptAssistantPrompt.ts': 'pure-utility',
  'services/providerPricing.ts': 'pure-utility',
  'runtime/raytracing/bvh.ts': 'pure-utility',
  'runtime/raytracing/rayBudget.ts': 'hot-loop',
  'runtime/raytracing/rayScene.ts': 'hot-loop',
  'runtime/raytracing/traceShader.ts': 'pure-utility',
  'runtime/passDispose.ts': 'hot-loop',
  'components/Scene/LocalEnvironment.tsx': 'hot-loop',
  'components/Scene/localEnvironmentCapture.ts': 'hot-loop',
  'runtime/temporal/mipBias.ts': 'pure-utility',
  'runtime/temporal/temporalSettings.ts': 'pure-utility',
  'runtime/temporal/temporalShaders.ts': 'pure-utility',
  'runtime/temporal/temporalStage.ts': 'hot-loop',
  'runtime/temporal/velocityBuffer.ts': 'hot-loop',
  'runtime/temporal/TemporalPipeline.tsx': 'hot-loop',
  'runtime/sky/atmosphere.ts': 'pure-utility',
  'runtime/sky/skyPresets.ts': 'pure-utility',
  'runtime/sky/skySettings.ts': 'pure-utility',
  'runtime/sky/skyDirector.ts': 'hot-loop',
  'components/Environment/sky/dayPreview.ts': 'pure-derived-state',
  'components/Environment/sky/SkyRenderer.ts': 'hot-loop',
  'components/Environment/sky/atmosphereShaders.ts': 'pure-utility',
  'components/Environment/sky/cloudShaders.ts': 'pure-utility',
  'runtime/lighting/lightBaker.ts': 'hot-loop',
  'runtime/lighting/lightBakeJobs.ts': 'data-model',
  'runtime/lighting/LevelLightVolume.tsx': 'hot-loop-controller',
  'runtime/navMesh.ts': 'pure-utility',
  'runtime/navSettings.ts': 'pure-utility',
  'components/Environment/hooks/useEditorNavMesh.ts': 'pure-derived-state',
  'runtime/triggers.ts': 'event-boundary',
  'runtime/input.ts': 'input-adapter',
  'runtime/playerOptions.ts': 'pure-derived-state',
  'runtime/components/types.ts': 'data-model',
  'utils/prefabs.ts': 'pure-utility',
  'utils/prefabSync.ts': 'pure-utility',
  'utils/sceneGraph.ts': 'pure-utility',
  'utils/surfacePlacement.ts': 'hot-loop',
  'player/gamePack.ts': 'context-adapter',
  'runtime/gameState.ts': 'pure-derived-state',
  'runtime/saveGame.ts': 'pure-utility',
  'runtime/types.ts': 'data-model',
  'utils/terrainHeightfieldEditor.ts': 'context-adapter',
  'components/Sandbox/hooks/usePlayerCombat.ts': 'input-adapter',
  'components/Sandbox/hooks/usePlayerControls.ts': 'input-adapter',
  'components/Sandbox/hooks/usePlayerPhysics.ts': 'hot-loop',
  'components/Sandbox/hooks/useSandboxConfiguration.ts': 'pure-derived-state',
  'data/blueprints/enemy.ts': 'data-model',
  'data/blueprints/index.ts': 'data-model',
  'data/blueprints/player.ts': 'data-model',
  'hooks/useRuntimeLevelWorld.ts': 'pure-derived-state',
  'host/index.ts': 'protocol-model',
  'host/fakeHost.ts': 'development-host',
  'host/protocol.ts': 'protocol-model',
  'host/transport.ts': 'protocol-model',
  'host/webview2.d.ts': 'type-declaration',
  'types.ts': 'data-model',
  'hud-frame.tsx': 'sandbox-proxy',
  'renderer/capabilities.ts': 'renderer-child-boundary',
  'renderer/contracts.ts': 'data-model',
  'renderer/conventions.ts': 'renderer-child-boundary',
  'renderer/nativeReference.ts': 'renderer-child-boundary',
  'renderer/referenceScenes.ts': 'data-model',
  'renderer/registry.ts': 'renderer-child-boundary',
  'renderer/renderGraph.ts': 'renderer-child-boundary',
  'utils/animationBinding.ts': 'pure-utility',
  'utils/domainCascade.ts': 'event-boundary',
  'utils/editorSession.ts': 'pure-utility',
  'utils/editorState.ts': 'data-model',
  'hooks/levelBlueprintNodes/flow.ts': 'pure-utility',
  'hooks/levelBlueprintNodes/world.ts': 'pure-utility',
  'utils/history.ts': 'input-adapter',
  'utils/materialOverrides.ts': 'pure-utility',
  'utils/projectStatus.ts': 'data-model',
  'utils/processing/ModelMaterials.ts': 'import-child-phase',
  'utils/processing/ModelTransforms.ts': 'import-child-phase',
  'utils/terrainHeightfieldCodec.ts': 'pure-utility',
  'utils/textureUtils.ts': 'pure-utility',
  'utils/textureCompression/bcEncoder.ts': 'pure-utility',
  'utils/textureCompression/compressTextures.ts': 'import-child-phase',
  'utils/textureCompression/textureEncoding.ts': 'pure-utility',
  'utils/gltfContainer.ts': 'pure-utility',
  'utils/preparedModels/format.ts': 'protocol-model',
  'utils/preparedModels/prepareGlb.ts': 'pure-utility',
  'utils/preparedModels/preparedLoader.ts': 'import-child-phase',
  'utils/gltfDecoders.ts': 'import-child-phase',
  'utils/thumbnailGenerator.ts': 'import-child-phase',
  'workers/autoRig.worker.ts': 'worker-protocol',
  'workers/fbxImport.worker.ts': 'worker-protocol',
  'workers/textureCompress.worker.ts': 'worker-protocol',
  'workers/modelPrepare.worker.ts': 'worker-protocol',
  'workers/navBake.worker.ts': 'worker-protocol',
  'workers/basisTranscode.worker.ts': 'worker-protocol',
  'workers/dracoDecode.worker.ts': 'worker-protocol',
  'workers/texturePipeline.worker.ts': 'worker-protocol',
  'texturing/utif.d.ts': 'type-declaration',
  'workers/gltfDecoders.d.ts': 'type-declaration',
}));

const files = [];
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(absolute);
  }
};
walk(root);

const REQUIRED_EVIDENCE = new Map([
  ['diagnostics/runtime.ts', ['startSpan(', 'wrap<T', 'instrumentClass(', 'traceActions<T', 'recordRenderCommit(']],
  ['diagnostics/RuntimeDiagnosticsBoundary.tsx', ['componentDidCatch(', '<React.Profiler']],
  ['context/OperationContext.tsx', ['spanId:', "startSpan('operation'", 'rootSpan.context']],
  ['host/nativeTransport.ts', ["startSpan('host'", 'span.finish(', 'span.fail(']],
  ['host/engine.ts', ["startSpan('engine'", 'withContext(diagnostics']],
  ['services/HostProviderService.ts', ["startSpan('provider'", 'withContext(span.context']],
  ['utils/projectService.ts', ["startSpan('project'", 'withContext(', 'span.context']],
  ['utils/useNativeProjectDocument.ts', ["startSpan('project_document'", 'span.context']],
  ['workers/fbxImport.worker.ts', ["report(0.12, 'fbx_structure_parse'", "report(0.64, 'runtime_asset_construction'", "type: 'error'"]],
  ['renderer/diagnostics.ts', ['renderer.context_lost', 'renderer.performance_degraded']],
]);

const results = [];
const failures = [];
for (const [relative, evidence] of REQUIRED_EVIDENCE) {
  const sourceText = fs.readFileSync(path.join(root, relative), 'utf8');
  for (const token of evidence) {
    if (!sourceText.includes(token)) failures.push(`${relative}: missing required trace evidence ${JSON.stringify(token)}`);
  }
}
for (const absolute of files.sort()) {
  const relative = path.relative(root, absolute).replaceAll('\\', '/');
  if (relative === 'vite.config.ts' || relative === 'vitest.config.ts') continue;
  if (generatedPrefixes.some((prefix) => relative.startsWith(prefix))) {
    results.push([relative, 'generated']);
    continue;
  }
  const sourceText = fs.readFileSync(absolute, 'utf8');
  if (/\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(/.test(sourceText)) {
    failures.push(`${relative}: production console logging bypasses diagnostics`);
  }
  const source = ts.createSourceFile(
    absolute,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (source.parseDiagnostics.length) {
    failures.push(`${relative}: TypeScript parse failure`);
    continue;
  }
  if (relative === 'diagnostics/runtime.ts' || relative === 'diagnostics/RuntimeDiagnosticsBoundary.tsx') {
    results.push([relative, 'diagnostics-infrastructure']);
    continue;
  }
  const direct = /\bfrontendDiagnostics\b/.test(sourceText)
    || /\binstallRendererDiagnostics\b/.test(sourceText)
    || /\bworkerDiagnostic\b/.test(sourceText);
  if (direct) {
    results.push([relative, 'direct']);
    continue;
  }
  let hasJsx = false;
  const visit = (node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) hasJsx = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (relative.endsWith('.tsx') && hasJsx) {
    results.push([relative, 'react-boundary']);
    continue;
  }
  const exemption = EXEMPT.get(relative);
  if (exemption) {
    results.push([relative, exemption]);
    continue;
  }
  failures.push(`${relative}: no direct, React, generated, hot-loop, input, or pure classification`);
}

const unusedExemptions = [...EXEMPT.keys()].filter((relative) => !files.some(
  (absolute) => path.relative(root, absolute).replaceAll('\\', '/') === relative,
));
for (const relative of unusedExemptions) failures.push(`${relative}: stale diagnostics exemption`);

if (failures.length) {
  console.error(`diagnostics coverage failed (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const verifyRuntimeBehavior = async () => {
  const posted = [];
  const webviewListeners = new Map();
  const webview = {
    addEventListener: (name, callback) => webviewListeners.set(name, callback),
    removeEventListener: (name) => webviewListeners.delete(name),
    postMessage: (message) => posted.push(message),
  };
  globalThis.window = {
    chrome: { webview },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const runtimeSource = fs.readFileSync(path.join(root, 'diagnostics/runtime.ts'), 'utf8');
  const transpiled = ts.transpileModule(runtimeSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const module = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`);
  const diagnostics = module.frontendDiagnostics;
  diagnostics.start();
  diagnostics.run('runtime_smoke', 'parent', () => {
    diagnostics.run('runtime_smoke', 'child', () => undefined);
  });
  try {
    diagnostics.wrap('runtime_smoke', 'failure', () => {
      throw new Error('private runtime value');
    })();
  } catch {
    // Expected: the diagnostic must contain only the stable error type.
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  diagnostics.stop();
  const records = posted.filter((message) => message?.type === 'event-batch').flatMap((message) => message.records);
  const starts = records.filter((record) => record.event === 'activity.started'
    && record.attributes?.subsystem === 'runtime_smoke');
  const parent = starts.find((record) => record.attributes.action === 'parent');
  const child = starts.find((record) => record.attributes.action === 'child');
  if (!parent || !child || parent.traceId !== child.traceId || child.parentSpanId !== parent.spanId) {
    failures.push('diagnostics/runtime.ts: executable parent/child span correlation failed');
  }
  if (!records.some((record) => record.event === 'activity.failed'
    && record.attributes?.errorType === 'Error')) {
    failures.push('diagnostics/runtime.ts: executable failure capture failed');
  }
  if (JSON.stringify(records).includes('private runtime value')) {
    failures.push('diagnostics/runtime.ts: executable trace retained an error message');
  }
};

await verifyRuntimeBehavior();

if (failures.length) {
  console.error(`diagnostics coverage failed (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const counts = new Map();
for (const [, classification] of results) counts.set(classification, (counts.get(classification) ?? 0) + 1);
console.log(`diagnostics coverage passed (${results.length} runtime modules)`);
console.log([...counts.entries()].sort().map(([name, count]) => `${name}=${count}`).join(', '));
