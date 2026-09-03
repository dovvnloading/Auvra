//! Backend-neutral immutable render extraction and production pass planning.
//!
//! This module deliberately contains no wgpu, winit, window, or filesystem
//! types.  The authoritative world owns the input DTOs and adapts them to
//! [`WorldRenderInput`].  Extraction copies only renderer-facing data into
//! immutable boxed slices at one world revision/tick boundary.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt;

pub const MAX_RENDER_ENTITIES: usize = 4_096;
pub const MAX_RENDER_LIGHTS: usize = 256;
pub const MAX_LOD_LEVELS: usize = 8;
pub const MAX_INSTANCE_BATCHES: usize = 4_096;
pub const MAX_GIZMOS: usize = 1_024;
pub const MAX_POST_PASSES: usize = 8;
pub const MAX_PICK_IDS: usize = 4_096;

const FEATURE_COUNT: usize = 16;

/// Exact portable production feature bits.  Bits are stable on the wire and
/// must not be reordered or reused for another feature.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct RenderFeatureBits(pub u32);

impl RenderFeatureBits {
    pub const PBR_METALLIC_ROUGHNESS: u32 = 1 << 0;
    pub const SKELETAL_ANIMATION: u32 = 1 << 1;
    pub const FRUSTUM_CULLING: u32 = 1 << 2;
    pub const DETERMINISTIC_LOD: u32 = 1 << 3;
    pub const INSTANCE_BATCHING: u32 = 1 << 4;
    pub const DIRECTIONAL_LIGHTS: u32 = 1 << 5;
    pub const POINT_LIGHTS: u32 = 1 << 6;
    pub const SPOT_LIGHTS: u32 = 1 << 7;
    pub const SHADOW_MAPS: u32 = 1 << 8;
    pub const IMAGE_BASED_LIGHTING: u32 = 1 << 9;
    pub const ENTITY_PICKING: u32 = 1 << 10;
    pub const EDITOR_GIZMOS: u32 = 1 << 11;
    pub const HDR_INTERMEDIATE: u32 = 1 << 12;
    pub const ACES_TONE_MAPPING: u32 = 1 << 13;
    pub const MSAA_OR_FXAA: u32 = 1 << 14;
    pub const POST_PROCESSING_CHAIN: u32 = 1 << 15;
    pub const ALL: u32 = (1 << FEATURE_COUNT) - 1;

    pub const fn all() -> Self {
        Self(Self::ALL)
    }
    pub const fn contains(self, bit: u32) -> bool {
        self.0 & bit == bit
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderFeature {
    PbrMetallicRoughness,
    SkeletalAnimation,
    FrustumCulling,
    DeterministicLod,
    InstanceBatching,
    DirectionalLights,
    PointLights,
    SpotLights,
    ShadowMaps,
    ImageBasedLighting,
    EntityPicking,
    EditorGizmos,
    HdrIntermediate,
    AcesToneMapping,
    MsaaOrFxaa,
    PostProcessingChain,
}

impl RenderFeature {
    pub const fn bit(self) -> u32 {
        match self {
            Self::PbrMetallicRoughness => RenderFeatureBits::PBR_METALLIC_ROUGHNESS,
            Self::SkeletalAnimation => RenderFeatureBits::SKELETAL_ANIMATION,
            Self::FrustumCulling => RenderFeatureBits::FRUSTUM_CULLING,
            Self::DeterministicLod => RenderFeatureBits::DETERMINISTIC_LOD,
            Self::InstanceBatching => RenderFeatureBits::INSTANCE_BATCHING,
            Self::DirectionalLights => RenderFeatureBits::DIRECTIONAL_LIGHTS,
            Self::PointLights => RenderFeatureBits::POINT_LIGHTS,
            Self::SpotLights => RenderFeatureBits::SPOT_LIGHTS,
            Self::ShadowMaps => RenderFeatureBits::SHADOW_MAPS,
            Self::ImageBasedLighting => RenderFeatureBits::IMAGE_BASED_LIGHTING,
            Self::EntityPicking => RenderFeatureBits::ENTITY_PICKING,
            Self::EditorGizmos => RenderFeatureBits::EDITOR_GIZMOS,
            Self::HdrIntermediate => RenderFeatureBits::HDR_INTERMEDIATE,
            Self::AcesToneMapping => RenderFeatureBits::ACES_TONE_MAPPING,
            Self::MsaaOrFxaa => RenderFeatureBits::MSAA_OR_FXAA,
            Self::PostProcessingChain => RenderFeatureBits::POST_PROCESSING_CHAIN,
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            Self::PbrMetallicRoughness => "pbr_metallic_roughness",
            Self::SkeletalAnimation => "skeletal_animation",
            Self::FrustumCulling => "frustum_culling",
            Self::DeterministicLod => "deterministic_lod",
            Self::InstanceBatching => "instance_batching",
            Self::DirectionalLights => "directional_lights",
            Self::PointLights => "point_lights",
            Self::SpotLights => "spot_lights",
            Self::ShadowMaps => "shadow_maps",
            Self::ImageBasedLighting => "image_based_lighting",
            Self::EntityPicking => "entity_picking",
            Self::EditorGizmos => "editor_gizmos",
            Self::HdrIntermediate => "hdr_intermediate",
            Self::AcesToneMapping => "aces_tone_mapping",
            Self::MsaaOrFxaa => "msaa_or_fxaa",
            Self::PostProcessingChain => "post_processing_chain",
        }
    }

    pub const fn fallback_reason(self) -> &'static str {
        match self {
            Self::PbrMetallicRoughness => {
                "pbr_metallic_roughness_unavailable: use deterministic lambert fallback"
            }
            Self::SkeletalAnimation => {
                "skeletal_animation_unavailable: use deterministic bind_pose sample"
            }
            Self::FrustumCulling => {
                "frustum_culling_unavailable: submit bounded visible-entity list"
            }
            Self::DeterministicLod => "deterministic_lod_unavailable: use highest-detail level",
            Self::InstanceBatching => {
                "instance_batching_unavailable: submit stable per-entity draws"
            }
            Self::DirectionalLights => "directional_lights_unavailable: use ambient fallback",
            Self::PointLights => "point_lights_unavailable: omit point contribution",
            Self::SpotLights => "spot_lights_unavailable: omit spot contribution",
            Self::ShadowMaps => "shadow_maps_unavailable: use unshadowed lighting",
            Self::ImageBasedLighting => {
                "image_based_lighting_unavailable: use fixed ambient irradiance"
            }
            Self::EntityPicking => "entity_picking_unavailable: disable GPU pick pass",
            Self::EditorGizmos => "editor_gizmos_unavailable: retain CPU overlay metadata",
            Self::HdrIntermediate => "hdr_intermediate_unavailable: render directly to sRGB target",
            Self::AcesToneMapping => "aces_tone_mapping_unavailable: use linear sRGB output",
            Self::MsaaOrFxaa => "msaa_or_fxaa_unavailable: use single-sample output",
            Self::PostProcessingChain => {
                "post_processing_chain_unavailable: publish tone-mapped color only"
            }
        }
    }
}

const FEATURES: [RenderFeature; FEATURE_COUNT] = [
    RenderFeature::PbrMetallicRoughness,
    RenderFeature::SkeletalAnimation,
    RenderFeature::FrustumCulling,
    RenderFeature::DeterministicLod,
    RenderFeature::InstanceBatching,
    RenderFeature::DirectionalLights,
    RenderFeature::PointLights,
    RenderFeature::SpotLights,
    RenderFeature::ShadowMaps,
    RenderFeature::ImageBasedLighting,
    RenderFeature::EntityPicking,
    RenderFeature::EditorGizmos,
    RenderFeature::HdrIntermediate,
    RenderFeature::AcesToneMapping,
    RenderFeature::MsaaOrFxaa,
    RenderFeature::PostProcessingChain,
];

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FeatureCapability {
    pub feature: RenderFeature,
    pub bit: u32,
    pub supported: bool,
    pub fallback_reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RenderCapabilities {
    pub bits: RenderFeatureBits,
    pub features: Box<[FeatureCapability]>,
}

impl RenderCapabilities {
    pub fn from_bits(bits: RenderFeatureBits) -> Self {
        let features = FEATURES
            .iter()
            .copied()
            .map(|feature| FeatureCapability {
                feature,
                bit: feature.bit(),
                supported: bits.contains(feature.bit()),
                fallback_reason: feature.fallback_reason().to_owned(),
            })
            .collect::<Vec<_>>()
            .into_boxed_slice();
        Self { bits, features }
    }

    pub fn portable() -> Self {
        Self::from_bits(RenderFeatureBits::all())
    }
    pub fn capability(&self, feature: RenderFeature) -> &FeatureCapability {
        &self.features[FEATURES
            .iter()
            .position(|candidate| *candidate == feature)
            .expect("feature table is complete")]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct MaterialReference {
    pub material_id: u64,
    pub base_color_factor: [f32; 4],
    pub metallic: f32,
    pub roughness: f32,
    pub base_color_texture: Option<u64>,
    pub normal_texture: Option<u64>,
    pub metallic_roughness_texture: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AnimationInput {
    pub clip_id: u64,
    pub duration_ticks: u64,
    pub speed_numerator: u32,
    pub speed_denominator: u32,
    pub looped: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AnimationSample {
    pub clip_id: u64,
    pub sample_tick: u64,
    pub normalized_time_micros: u32,
    pub bind_pose: bool,
}

impl AnimationInput {
    fn sample(self, fixed_tick: u64) -> Result<AnimationSample, RenderExtractionError> {
        if self.clip_id == 0 || self.duration_ticks == 0 || self.speed_denominator == 0 {
            return Err(RenderExtractionError::Invalid(
                "animation descriptor is invalid",
            ));
        }
        let scaled = (fixed_tick as u128).saturating_mul(self.speed_numerator as u128)
            / self.speed_denominator as u128;
        let sample_tick = if self.looped {
            (scaled % self.duration_ticks as u128) as u64
        } else {
            scaled.min(self.duration_ticks as u128 - 1) as u64
        };
        let normalized_time_micros =
            ((sample_tick as u128 * 1_000_000) / self.duration_ticks as u128).min(999_999) as u32;
        Ok(AnimationSample {
            clip_id: self.clip_id,
            sample_tick,
            normalized_time_micros,
            bind_pose: false,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorldRenderEntity {
    pub id: u64,
    pub mesh_id: u64,
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    pub scale: [f32; 3],
    pub radius: f32,
    pub material: MaterialReference,
    pub lods: Vec<LodLevel>,
    pub animation: Option<AnimationInput>,
    pub selected: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct LodLevel {
    pub level: u8,
    pub max_distance: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Plane {
    pub normal: [f32; 3],
    pub distance: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Frustum {
    pub planes: [Plane; 6],
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LightKind {
    Directional,
    Point,
    Spot,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorldRenderLight {
    pub id: u64,
    pub kind: LightKind,
    pub position: [f32; 3],
    pub direction: [f32; 3],
    pub range: f32,
    pub spot_inner_cos: f32,
    pub spot_outer_cos: f32,
    pub casts_shadow: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct IblInput {
    pub environment_id: u64,
    pub irradiance_id: u64,
    pub prefiltered_id: u64,
    pub brdf_lut_id: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorldRenderInput {
    pub world_revision: u64,
    pub fixed_tick: u64,
    pub camera_position: [f32; 3],
    pub frustum: Frustum,
    pub entities: Vec<WorldRenderEntity>,
    pub lights: Vec<WorldRenderLight>,
    pub ibl: Option<IblInput>,
    pub post_effects: Vec<PostEffect>,
    pub msaa_samples: u8,
    pub fxaa: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PostEffect {
    Bloom,
    ColorGrading,
    Vignette,
    Sharpen,
    Fxaa,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderFallback {
    Compatibility,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExtractedEntity {
    pub id: u64,
    pub mesh_id: u64,
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    pub scale: [f32; 3],
    pub radius: f32,
    pub material: MaterialReference,
    pub animation: Option<AnimationSample>,
    pub lod: u8,
    pub pick_id: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct InstanceBatch {
    pub mesh_id: u64,
    pub material_id: u64,
    pub lod: u8,
    pub entity_ids: Box<[u64]>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExtractedLight {
    pub light: WorldRenderLight,
    pub shadow_candidate: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PickEntry {
    pub entity_id: u64,
    pub pick_id: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GizmoOverlay {
    pub entity_id: u64,
    pub pick_id: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderPassKind {
    AnimationSample,
    FrustumCull,
    LodSelect,
    InstanceBatch,
    ShadowMaps,
    PbrOpaque,
    ImageBasedLighting,
    HdrIntermediate,
    AcesToneMapping,
    MsaaOrFxaa,
    EntityPicking,
    GizmoOverlay,
    PostProcessingChain,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RenderPass {
    pub order: u8,
    pub kind: RenderPassKind,
    pub enabled: bool,
    pub fallback: Option<RenderFallback>,
    pub fallback_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RenderSnapshot {
    pub world_revision: u64,
    pub fixed_tick: u64,
    pub entities: Box<[ExtractedEntity]>,
    pub visible_entity_ids: Box<[u64]>,
    pub batches: Box<[InstanceBatch]>,
    pub lights: Box<[ExtractedLight]>,
    pub shadow_light_ids: Box<[u64]>,
    pub picks: Box<[PickEntry]>,
    pub gizmos: Box<[GizmoOverlay]>,
    pub ibl: Option<IblInput>,
    pub post_effects: Box<[PostEffect]>,
    pub msaa_samples: u8,
    pub fxaa: bool,
    pub capabilities: RenderCapabilities,
    pub extraction_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RenderPlan {
    pub passes: Box<[RenderPass]>,
    pub plan_hash: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RenderExtraction {
    pub snapshot: RenderSnapshot,
    pub plan: RenderPlan,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RenderExtractionError {
    Invalid(&'static str),
    Limit(&'static str),
    DuplicateId(u64),
}

impl fmt::Display for RenderExtractionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => f.write_str(message),
            Self::Limit(message) => f.write_str(message),
            Self::DuplicateId(id) => write!(f, "duplicate render id {id}"),
        }
    }
}
impl std::error::Error for RenderExtractionError {}

pub fn extract_render_world(
    input: &WorldRenderInput,
    capabilities: RenderCapabilities,
) -> Result<RenderExtraction, RenderExtractionError> {
    validate_input(input)?;
    let mut source = input.entities.clone();
    source.sort_by_key(|entity| entity.id);
    let mut used = BTreeSet::new();
    for entity in &source {
        if !used.insert(entity.id) {
            return Err(RenderExtractionError::DuplicateId(entity.id));
        }
    }

    let mut extracted = Vec::with_capacity(source.len());
    let mut visible_ids = Vec::with_capacity(source.len());
    for entity in source {
        if capabilities
            .bits
            .contains(RenderFeatureBits::FRUSTUM_CULLING)
            && !sphere_visible(entity.position, entity.radius, input.frustum)
        {
            continue;
        }
        let lod = if capabilities
            .bits
            .contains(RenderFeatureBits::DETERMINISTIC_LOD)
        {
            choose_lod(
                &entity.lods,
                distance_sq(input.camera_position, entity.position),
            )
        } else {
            highest_detail_lod(&entity.lods)
        };
        let animation = if capabilities
            .bits
            .contains(RenderFeatureBits::SKELETAL_ANIMATION)
        {
            entity
                .animation
                .map(|value| value.sample(input.fixed_tick))
                .transpose()?
        } else {
            entity.animation.map(|_| AnimationSample {
                clip_id: 0,
                sample_tick: 0,
                normalized_time_micros: 0,
                bind_pose: true,
            })
        };
        visible_ids.push(entity.id);
        extracted.push(ExtractedEntity {
            id: entity.id,
            mesh_id: entity.mesh_id,
            position: entity.position,
            rotation: entity.rotation,
            scale: entity.scale,
            radius: entity.radius,
            material: entity.material,
            animation,
            lod,
            pick_id: 0,
        });
    }

    let mut picks = Vec::new();
    if capabilities
        .bits
        .contains(RenderFeatureBits::ENTITY_PICKING)
    {
        let mut pick_numbers = BTreeSet::new();
        for entity in &mut extracted {
            let mut pick_id = (fnv1a(&entity.id.to_le_bytes()) as u32).max(1);
            while !pick_numbers.insert(pick_id) {
                pick_id = pick_id.wrapping_add(1).max(1);
            }
            entity.pick_id = pick_id;
            picks.push(PickEntry {
                entity_id: entity.id,
                pick_id,
            });
        }
    }

    let batches = if capabilities
        .bits
        .contains(RenderFeatureBits::INSTANCE_BATCHING)
    {
        let mut keys = extracted
            .iter()
            .map(|entity| (entity.mesh_id, entity.material.material_id, entity.lod))
            .collect::<Vec<_>>();
        keys.sort_unstable();
        keys.dedup();
        keys.into_iter()
            .map(|(mesh_id, material_id, lod)| InstanceBatch {
                mesh_id,
                material_id,
                lod,
                entity_ids: extracted
                    .iter()
                    .filter(|entity| {
                        entity.mesh_id == mesh_id
                            && entity.material.material_id == material_id
                            && entity.lod == lod
                    })
                    .map(|entity| entity.id)
                    .collect::<Vec<_>>()
                    .into_boxed_slice(),
            })
            .collect::<Vec<_>>()
    } else {
        extracted
            .iter()
            .map(|entity| InstanceBatch {
                mesh_id: entity.mesh_id,
                material_id: entity.material.material_id,
                lod: entity.lod,
                entity_ids: vec![entity.id].into_boxed_slice(),
            })
            .collect::<Vec<_>>()
    };

    let mut lights = input
        .lights
        .iter()
        .copied()
        .filter(|light| match light.kind {
            LightKind::Directional => capabilities
                .bits
                .contains(RenderFeatureBits::DIRECTIONAL_LIGHTS),
            LightKind::Point => capabilities.bits.contains(RenderFeatureBits::POINT_LIGHTS),
            LightKind::Spot => capabilities.bits.contains(RenderFeatureBits::SPOT_LIGHTS),
        })
        .collect::<Vec<_>>();
    lights.sort_by_key(|light| light.id);
    let lights = lights
        .into_iter()
        .map(|light| ExtractedLight {
            shadow_candidate: capabilities.bits.contains(RenderFeatureBits::SHADOW_MAPS)
                && light.casts_shadow,
            light,
        })
        .collect::<Vec<_>>();
    let mut shadow_ids = lights
        .iter()
        .filter(|entry| entry.shadow_candidate)
        .map(|entry| entry.light.id)
        .collect::<Vec<_>>();
    shadow_ids.sort_unstable();
    let gizmos = if capabilities.bits.contains(RenderFeatureBits::EDITOR_GIZMOS) {
        extracted
            .iter()
            .filter(|entity| {
                input
                    .entities
                    .iter()
                    .any(|source| source.id == entity.id && source.selected)
            })
            .take(MAX_GIZMOS)
            .map(|entity| GizmoOverlay {
                entity_id: entity.id,
                pick_id: entity.pick_id,
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    let ibl = if capabilities
        .bits
        .contains(RenderFeatureBits::IMAGE_BASED_LIGHTING)
    {
        input.ibl
    } else {
        None
    };
    let mut snapshot = RenderSnapshot {
        world_revision: input.world_revision,
        fixed_tick: input.fixed_tick,
        entities: extracted.into_boxed_slice(),
        visible_entity_ids: visible_ids.into_boxed_slice(),
        batches: batches.into_boxed_slice(),
        lights: lights.into_boxed_slice(),
        shadow_light_ids: shadow_ids.into_boxed_slice(),
        picks: picks.into_boxed_slice(),
        gizmos: gizmos.into_boxed_slice(),
        ibl,
        post_effects: input.post_effects.clone().into_boxed_slice(),
        msaa_samples: input.msaa_samples,
        fxaa: input.fxaa,
        capabilities,
        extraction_hash: String::new(),
    };
    snapshot.extraction_hash = canonical_hash(&snapshot);
    let plan = plan_render_passes(input, &snapshot.capabilities);
    Ok(RenderExtraction { snapshot, plan })
}

pub fn plan_render_passes(
    input: &WorldRenderInput,
    capabilities: &RenderCapabilities,
) -> RenderPlan {
    let entries = [
        (
            RenderPassKind::AnimationSample,
            true,
            capabilities
                .bits
                .contains(RenderFeatureBits::SKELETAL_ANIMATION),
        ),
        (
            RenderPassKind::FrustumCull,
            true,
            capabilities
                .bits
                .contains(RenderFeatureBits::FRUSTUM_CULLING),
        ),
        (
            RenderPassKind::LodSelect,
            true,
            capabilities
                .bits
                .contains(RenderFeatureBits::DETERMINISTIC_LOD),
        ),
        (
            RenderPassKind::InstanceBatch,
            true,
            capabilities
                .bits
                .contains(RenderFeatureBits::INSTANCE_BATCHING),
        ),
        (
            RenderPassKind::ShadowMaps,
            true,
            capabilities.bits.contains(RenderFeatureBits::SHADOW_MAPS),
        ),
        (
            RenderPassKind::PbrOpaque,
            true,
            capabilities
                .bits
                .contains(RenderFeatureBits::PBR_METALLIC_ROUGHNESS),
        ),
        (
            RenderPassKind::ImageBasedLighting,
            input.ibl.is_some(),
            capabilities
                .bits
                .contains(RenderFeatureBits::IMAGE_BASED_LIGHTING),
        ),
        (
            RenderPassKind::HdrIntermediate,
            true,
            capabilities
                .bits
                .contains(RenderFeatureBits::HDR_INTERMEDIATE),
        ),
        (
            RenderPassKind::AcesToneMapping,
            true,
            capabilities
                .bits
                .contains(RenderFeatureBits::ACES_TONE_MAPPING),
        ),
        (
            RenderPassKind::MsaaOrFxaa,
            input.msaa_samples > 1 || input.fxaa,
            capabilities.bits.contains(RenderFeatureBits::MSAA_OR_FXAA),
        ),
        (
            RenderPassKind::EntityPicking,
            true,
            capabilities
                .bits
                .contains(RenderFeatureBits::ENTITY_PICKING),
        ),
        (
            RenderPassKind::GizmoOverlay,
            true,
            capabilities.bits.contains(RenderFeatureBits::EDITOR_GIZMOS),
        ),
        (
            RenderPassKind::PostProcessingChain,
            !input.post_effects.is_empty(),
            capabilities
                .bits
                .contains(RenderFeatureBits::POST_PROCESSING_CHAIN),
        ),
    ];
    let passes = entries
        .into_iter()
        .enumerate()
        .map(|(index, (kind, requested, supported))| {
            let feature = pass_feature(kind);
            let fallback = requested && !supported;
            RenderPass {
                order: index as u8,
                kind,
                enabled: requested && supported,
                fallback: fallback.then_some(RenderFallback::Compatibility),
                fallback_reason: fallback.then(|| feature.fallback_reason().to_owned()),
            }
        })
        .collect::<Vec<_>>();
    let mut plan = RenderPlan {
        passes: passes.into_boxed_slice(),
        plan_hash: String::new(),
    };
    plan.plan_hash = canonical_hash(&plan);
    plan
}

fn pass_feature(pass: RenderPassKind) -> RenderFeature {
    match pass {
        RenderPassKind::AnimationSample => RenderFeature::SkeletalAnimation,
        RenderPassKind::FrustumCull => RenderFeature::FrustumCulling,
        RenderPassKind::LodSelect => RenderFeature::DeterministicLod,
        RenderPassKind::InstanceBatch => RenderFeature::InstanceBatching,
        RenderPassKind::ShadowMaps => RenderFeature::ShadowMaps,
        RenderPassKind::PbrOpaque => RenderFeature::PbrMetallicRoughness,
        RenderPassKind::ImageBasedLighting => RenderFeature::ImageBasedLighting,
        RenderPassKind::HdrIntermediate => RenderFeature::HdrIntermediate,
        RenderPassKind::AcesToneMapping => RenderFeature::AcesToneMapping,
        RenderPassKind::MsaaOrFxaa => RenderFeature::MsaaOrFxaa,
        RenderPassKind::EntityPicking => RenderFeature::EntityPicking,
        RenderPassKind::GizmoOverlay => RenderFeature::EditorGizmos,
        RenderPassKind::PostProcessingChain => RenderFeature::PostProcessingChain,
    }
}

fn validate_input(input: &WorldRenderInput) -> Result<(), RenderExtractionError> {
    if input.entities.len() > MAX_RENDER_ENTITIES {
        return Err(RenderExtractionError::Limit("render entity limit exceeded"));
    }
    if input.lights.len() > MAX_RENDER_LIGHTS {
        return Err(RenderExtractionError::Limit("render light limit exceeded"));
    }
    if input.post_effects.len() > MAX_POST_PASSES {
        return Err(RenderExtractionError::Limit(
            "post-processing pass limit exceeded",
        ));
    }
    if input.msaa_samples > 16 || input.msaa_samples != 0 && !input.msaa_samples.is_power_of_two() {
        return Err(RenderExtractionError::Invalid(
            "MSAA sample count must be zero or a power of two no greater than sixteen",
        ));
    }
    if !finite3(input.camera_position) {
        return Err(RenderExtractionError::Invalid(
            "camera position is not finite",
        ));
    }
    if input
        .frustum
        .planes
        .iter()
        .any(|plane| !finite3(plane.normal) || !plane.distance.is_finite())
    {
        return Err(RenderExtractionError::Invalid("frustum plane is invalid"));
    }
    for entity in &input.entities {
        if entity.id == 0
            || entity.mesh_id == 0
            || !finite3(entity.position)
            || !finite4(entity.rotation)
            || entity.rotation.iter().map(|value| value * value).sum::<f32>() <= f32::EPSILON
            || entity.scale.iter().any(|value| !value.is_finite() || *value <= 0.0)
            || !entity.radius.is_finite()
            || entity.radius < 0.0
        {
            return Err(RenderExtractionError::Invalid("render entity is invalid"));
        }
        if entity.lods.len() > MAX_LOD_LEVELS {
            return Err(RenderExtractionError::Limit("LOD level limit exceeded"));
        }
        validate_material(entity.material)?;
        let mut lod_levels = Vec::with_capacity(entity.lods.len());
        for lod in &entity.lods {
            if !lod.max_distance.is_finite() || lod.max_distance < 0.0 {
                return Err(RenderExtractionError::Invalid("LOD distance is invalid"));
            }
            if lod_levels.contains(&lod.level) {
                return Err(RenderExtractionError::Invalid("duplicate LOD level"));
            }
            lod_levels.push(lod.level);
        }
    }
    let mut light_ids = BTreeSet::new();
    for light in &input.lights {
        if light.id == 0
            || !light_ids.insert(light.id)
            || !finite3(light.position)
            || !finite3(light.direction)
            || direction_length_sq(light.direction) <= f32::EPSILON
            || !light.range.is_finite()
            || light.range < 0.0
        {
            return Err(RenderExtractionError::Invalid("render light is invalid"));
        }
        if !(-1.0..=1.0).contains(&light.spot_outer_cos)
            || !(-1.0..=1.0).contains(&light.spot_inner_cos)
            || light.spot_outer_cos > light.spot_inner_cos
        {
            return Err(RenderExtractionError::Invalid(
                "spot light cosine range is invalid",
            ));
        }
    }
    if let Some(ibl) = input.ibl {
        if ibl.environment_id == 0
            || ibl.irradiance_id == 0
            || ibl.prefiltered_id == 0
            || ibl.brdf_lut_id == 0
        {
            return Err(RenderExtractionError::Invalid(
                "IBL handles must be nonzero",
            ));
        }
    }
    let mut post_effects = Vec::with_capacity(input.post_effects.len());
    for effect in &input.post_effects {
        if post_effects.contains(effect) {
            return Err(RenderExtractionError::Invalid(
                "duplicate post-processing effect",
            ));
        }
        post_effects.push(*effect);
    }
    Ok(())
}

fn validate_material(material: MaterialReference) -> Result<(), RenderExtractionError> {
    if material.material_id == 0
        || material
            .base_color_factor
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0 || *value > 1.0)
        || !material.metallic.is_finite()
        || !material.roughness.is_finite()
        || !(0.0..=1.0).contains(&material.metallic)
        || !(0.0..=1.0).contains(&material.roughness)
    {
        return Err(RenderExtractionError::Invalid(
            "PBR material reference is invalid",
        ));
    }
    Ok(())
}

fn finite3(value: [f32; 3]) -> bool {
    value.iter().all(|component| component.is_finite())
}
fn finite4(value: [f32; 4]) -> bool {
    value.iter().all(|component| component.is_finite())
}
fn direction_length_sq(value: [f32; 3]) -> f32 {
    value[0].mul_add(value[0], value[1].mul_add(value[1], value[2] * value[2]))
}
fn distance_sq(a: [f32; 3], b: [f32; 3]) -> f32 {
    (a[0] - b[0]).mul_add(
        a[0] - b[0],
        (a[1] - b[1]).mul_add(a[1] - b[1], (a[2] - b[2]) * (a[2] - b[2])),
    )
}
fn sphere_visible(center: [f32; 3], radius: f32, frustum: Frustum) -> bool {
    frustum.planes.iter().all(|plane| {
        plane.normal[0] * center[0]
            + plane.normal[1] * center[1]
            + plane.normal[2] * center[2]
            + plane.distance
            >= -radius
    })
}
fn highest_detail_lod(lods: &[LodLevel]) -> u8 {
    lods.iter()
        .min_by(|a, b| {
            a.level
                .cmp(&b.level)
                .then_with(|| a.max_distance.total_cmp(&b.max_distance))
        })
        .map(|lod| lod.level)
        .unwrap_or(0)
}
fn choose_lod(lods: &[LodLevel], distance_squared: f32) -> u8 {
    let distance = distance_squared.max(0.0).sqrt();
    let mut ordered = lods.to_vec();
    ordered.sort_by(|a, b| {
        a.max_distance
            .total_cmp(&b.max_distance)
            .then_with(|| a.level.cmp(&b.level))
    });
    ordered
        .iter()
        .find(|lod| distance <= lod.max_distance)
        .map(|lod| lod.level)
        .unwrap_or_else(|| ordered.last().map(|lod| lod.level).unwrap_or(0))
}
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}
fn canonical_hash<T: Serialize>(value: &T) -> String {
    let encoded = serde_json::to_vec(value).expect("render DTOs are serializable");
    format!("{:016x}", fnv1a(&encoded))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn material(id: u64) -> MaterialReference {
        MaterialReference {
            material_id: id,
            base_color_factor: [0.4, 0.5, 0.6, 1.0],
            metallic: 0.2,
            roughness: 0.7,
            base_color_texture: None,
            normal_texture: None,
            metallic_roughness_texture: None,
        }
    }
    fn frustum() -> Frustum {
        Frustum {
            planes: [Plane {
                normal: [1.0, 0.0, 0.0],
                distance: 10.0,
            }; 6],
        }
    }
    fn entity(id: u64, x: f32) -> WorldRenderEntity {
        WorldRenderEntity {
            id,
            mesh_id: 2,
            position: [x, 0.0, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0, 1.0, 1.0],
            radius: 0.5,
            material: material(3),
            lods: vec![
                LodLevel {
                    level: 0,
                    max_distance: 2.0,
                },
                LodLevel {
                    level: 1,
                    max_distance: 20.0,
                },
            ],
            animation: Some(AnimationInput {
                clip_id: 5,
                duration_ticks: 60,
                speed_numerator: 1,
                speed_denominator: 1,
                looped: true,
            }),
            selected: id == 2,
        }
    }
    fn input() -> WorldRenderInput {
        WorldRenderInput {
            world_revision: 4,
            fixed_tick: 120,
            camera_position: [0.0, 0.0, 0.0],
            frustum: frustum(),
            entities: vec![entity(2, 1.0), entity(1, 3.0)],
            lights: vec![WorldRenderLight {
                id: 8,
                kind: LightKind::Point,
                position: [0.0, 1.0, 0.0],
                direction: [0.0, -1.0, 0.0],
                range: 5.0,
                spot_inner_cos: 0.8,
                spot_outer_cos: 0.5,
                casts_shadow: true,
            }],
            ibl: Some(IblInput {
                environment_id: 1,
                irradiance_id: 2,
                prefiltered_id: 3,
                brdf_lut_id: 4,
            }),
            post_effects: vec![PostEffect::Bloom],
            msaa_samples: 4,
            fxaa: false,
        }
    }

    #[test]
    fn extraction_is_immutable_and_hashes_repeat() {
        let first = extract_render_world(&input(), RenderCapabilities::portable()).unwrap();
        let second = extract_render_world(&input(), RenderCapabilities::portable()).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.snapshot.entities[0].id, 1);
        assert_eq!(first.snapshot.entities[0].animation.unwrap().sample_tick, 0);
        assert!(!first.snapshot.extraction_hash.is_empty());
    }

    #[test]
    fn culling_and_lod_are_deterministic() {
        let mut value = input();
        value.entities[0].position = [-20.0, 0.0, 0.0];
        let extracted = extract_render_world(&value, RenderCapabilities::portable()).unwrap();
        assert_eq!(extracted.snapshot.visible_entity_ids.as_ref(), &[1]);
        assert_eq!(
            choose_lod(
                &[
                    LodLevel {
                        level: 0,
                        max_distance: 2.0
                    },
                    LodLevel {
                        level: 1,
                        max_distance: 20.0
                    }
                ],
                9.0
            ),
            1
        );
    }

    #[test]
    fn batching_order_light_shadow_pick_and_gizmo_bounds_hold() {
        let mut value = input();
        value.entities.push(entity(3, 1.5));
        let result = extract_render_world(&value, RenderCapabilities::portable()).unwrap();
        assert_eq!(result.snapshot.batches.len(), 2);
        assert_eq!(result.snapshot.batches[0].lod, 0);
        assert_eq!(result.snapshot.batches[0].entity_ids.as_ref(), &[2, 3]);
        assert_eq!(result.snapshot.batches[1].entity_ids.as_ref(), &[1]);
        assert_eq!(result.snapshot.shadow_light_ids.as_ref(), &[8]);
        assert_eq!(result.snapshot.picks.len(), 3);
        assert_eq!(result.snapshot.gizmos.len(), 1);
    }

    #[test]
    fn capabilities_have_one_bit_and_fallback_for_every_feature() {
        let capabilities = RenderCapabilities::from_bits(RenderFeatureBits(0));
        assert_eq!(capabilities.features.len(), FEATURE_COUNT);
        for (index, feature) in FEATURES.iter().enumerate() {
            assert_eq!(capabilities.features[index].bit, feature.bit());
            assert!(!capabilities.features[index].fallback_reason.is_empty());
        }
    }

    #[test]
    fn pass_order_and_fallbacks_are_complete() {
        let mut value = input();
        value.ibl = None;
        value.post_effects.clear();
        value.msaa_samples = 0;
        value.fxaa = false;
        let plan = plan_render_passes(&value, &RenderCapabilities::from_bits(RenderFeatureBits(0)));
        assert_eq!(plan.passes.len(), 13);
        assert!(
            plan.passes
                .windows(2)
                .all(|passes| passes[0].order < passes[1].order)
        );
        assert!(plan.passes.iter().all(|pass| !pass.enabled));
        for pass in &plan.passes {
            let optional_not_requested = matches!(
                pass.kind,
                RenderPassKind::ImageBasedLighting
                    | RenderPassKind::MsaaOrFxaa
                    | RenderPassKind::PostProcessingChain
            );
            assert_eq!(pass.fallback_reason.is_none(), optional_not_requested);
        }
        assert!(!plan.plan_hash.is_empty());
    }

    #[test]
    fn bounds_and_invalid_input_fail_closed() {
        let mut value = input();
        value.entities = (1..=MAX_RENDER_ENTITIES as u64 + 1)
            .map(|id| entity(id, 1.0))
            .collect();
        assert!(matches!(
            extract_render_world(&value, RenderCapabilities::portable()),
            Err(RenderExtractionError::Limit(_))
        ));
        let mut value = input();
        value.entities[0].id = value.entities[1].id;
        assert!(matches!(
            extract_render_world(&value, RenderCapabilities::portable()),
            Err(RenderExtractionError::DuplicateId(1))
        ));
        let mut value = input();
        value.lights = (1..=MAX_RENDER_LIGHTS + 1)
            .map(|id| WorldRenderLight {
                id: id as u64,
                kind: LightKind::Directional,
                position: [0.0, 0.0, 0.0],
                direction: [0.0, -1.0, 0.0],
                range: 1.0,
                spot_inner_cos: 1.0,
                spot_outer_cos: 0.0,
                casts_shadow: true,
            })
            .collect();
        assert!(matches!(
            extract_render_world(&value, RenderCapabilities::portable()),
            Err(RenderExtractionError::Limit("render light limit exceeded"))
        ));
    }

    #[test]
    fn capability_fallbacks_control_picks_batches_lights_and_ibl() {
        let mut bits = RenderFeatureBits::all();
        bits.0 &= !(RenderFeatureBits::ENTITY_PICKING
            | RenderFeatureBits::INSTANCE_BATCHING
            | RenderFeatureBits::DIRECTIONAL_LIGHTS
            | RenderFeatureBits::POINT_LIGHTS
            | RenderFeatureBits::SPOT_LIGHTS
            | RenderFeatureBits::IMAGE_BASED_LIGHTING);
        let result = extract_render_world(&input(), RenderCapabilities::from_bits(bits)).unwrap();
        assert!(result.snapshot.picks.is_empty());
        assert_eq!(
            result.snapshot.entities.len(),
            result.snapshot.batches.len()
        );
        assert!(
            result
                .snapshot
                .batches
                .iter()
                .all(|batch| batch.entity_ids.len() == 1)
        );
        assert!(result.snapshot.lights.is_empty());
        assert!(result.snapshot.shadow_light_ids.is_empty());
        assert!(result.snapshot.ibl.is_none());
    }

    #[test]
    fn duplicate_and_range_validation_fails_closed() {
        let mut value = input();
        value.lights.push(value.lights[0]);
        assert!(matches!(
            extract_render_world(&value, RenderCapabilities::portable()),
            Err(RenderExtractionError::Invalid("render light is invalid"))
        ));
        let mut value = input();
        value.lights[0].direction = [0.0, 0.0, 0.0];
        assert!(matches!(
            extract_render_world(&value, RenderCapabilities::portable()),
            Err(RenderExtractionError::Invalid("render light is invalid"))
        ));
        let mut value = input();
        value.lights[0].kind = LightKind::Spot;
        value.lights[0].spot_inner_cos = 0.2;
        value.lights[0].spot_outer_cos = 0.9;
        assert!(matches!(
            extract_render_world(&value, RenderCapabilities::portable()),
            Err(RenderExtractionError::Invalid(
                "spot light cosine range is invalid"
            ))
        ));
        let mut value = input();
        value.entities[0].lods.push(LodLevel {
            level: 0,
            max_distance: 30.0,
        });
        assert!(matches!(
            extract_render_world(&value, RenderCapabilities::portable()),
            Err(RenderExtractionError::Invalid("duplicate LOD level"))
        ));
        let mut value = input();
        value.ibl = Some(IblInput {
            environment_id: 0,
            irradiance_id: 2,
            prefiltered_id: 3,
            brdf_lut_id: 4,
        });
        assert!(matches!(
            extract_render_world(&value, RenderCapabilities::portable()),
            Err(RenderExtractionError::Invalid(
                "IBL handles must be nonzero"
            ))
        ));
        let mut value = input();
        value.post_effects.push(PostEffect::Bloom);
        assert!(matches!(
            extract_render_world(&value, RenderCapabilities::portable()),
            Err(RenderExtractionError::Invalid(
                "duplicate post-processing effect"
            ))
        ));
    }
}
