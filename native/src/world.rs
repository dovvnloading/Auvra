//! Deterministic, repository-owned world state for the native runtime.
//!
//! This module deliberately has no renderer or filesystem dependencies.  The
//! native service can hydrate it from an authored project document, apply a
//! revision-checked command transaction, advance the fixed simulation clock,
//! and publish a cloned serializable snapshot.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::fmt;

pub const TICKS_PER_SECOND: u64 = 60;
pub const MAX_CATCH_UP_STEPS: u32 = 8;
pub const MAX_ENTITIES: usize = 16_384;
pub const MAX_COMMANDS: usize = 16_384;
pub const MAX_REPLAY_RECORDS: usize = 4_096;
pub const MAX_ID_BYTES: usize = 128;
pub const MAX_ASSET_HASH_BYTES: usize = 64;
const NANOS_PER_SECOND: u128 = 1_000_000_000;
const MAX_GENERATION: u32 = 1_000_000;
const MAX_ABS_POSITION: f64 = 1_000_000.0;
const MAX_ABS_VELOCITY: f64 = 1_000_000.0;
const MAX_ABS_TIME: f64 = 1_000_000_000.0;
const POSITION_MICRO_UNITS: f64 = 1_000_000.0;

fn identity_rotation() -> [f64; 4] {
    [0.0, 0.0, 0.0, 1.0]
}
fn unit_scale() -> [f64; 3] {
    [1.0, 1.0, 1.0]
}
fn zero_vec3() -> [f64; 3] {
    [0.0, 0.0, 0.0]
}
fn default_visible() -> bool {
    true
}
fn default_looping() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RenderData {
    #[serde(default)]
    pub asset_hash: Option<String>,
    #[serde(default = "default_visible")]
    pub visible: bool,
    #[serde(default)]
    pub cast_shadow: bool,
    #[serde(default)]
    pub receive_shadow: bool,
    #[serde(default)]
    pub layer: u8,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LightData {
    pub kind: String,
    pub color: [f64; 3],
    pub intensity: f64,
    #[serde(default)]
    pub range: f64,
    #[serde(default)]
    pub spot_inner_angle: f64,
    #[serde(default)]
    pub spot_outer_angle: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AnimationData {
    #[serde(default)]
    pub asset_hash: Option<String>,
    pub clip: String,
    #[serde(default)]
    pub time_seconds: f64,
    #[serde(default = "one_f64")]
    pub speed: f64,
    #[serde(default = "default_looping")]
    pub looping: bool,
}

fn one_f64() -> f64 {
    1.0
}

/// Authoritative entity DTO.  `id`, `position`, and `color` retain the Stage 6
/// shape; all newer components are optional/defaulted for old project data.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Entity {
    pub id: String,
    pub position: [f64; 3],
    pub color: [f64; 4],
    #[serde(default)]
    pub generation: u32,
    #[serde(default = "identity_rotation")]
    pub rotation: [f64; 4],
    #[serde(default = "unit_scale")]
    pub scale: [f64; 3],
    #[serde(default = "zero_vec3")]
    pub velocity: [f64; 3],
    #[serde(default)]
    pub render: Option<RenderData>,
    #[serde(default)]
    pub light: Option<LightData>,
    #[serde(default)]
    pub animation: Option<AnimationData>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase", tag = "type")]
pub enum WorldCommand {
    Upsert {
        entity: Entity,
    },
    Remove {
        id: String,
        #[serde(default)]
        expected_generation: Option<u32>,
    },
    SetTransform {
        id: String,
        position: [f64; 3],
        #[serde(default = "identity_rotation")]
        rotation: [f64; 4],
        #[serde(default = "unit_scale")]
        scale: [f64; 3],
        #[serde(default)]
        expected_generation: Option<u32>,
    },
    SetVelocity {
        id: String,
        velocity: [f64; 3],
        #[serde(default)]
        expected_generation: Option<u32>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorldTransaction {
    #[serde(rename = "expectedRevision")]
    pub expected_revision: u64,
    pub commands: Vec<WorldCommand>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReplayRecord {
    pub sequence: u64,
    pub tick_before: u64,
    pub expected_revision: u64,
    pub commands: Vec<WorldCommand>,
    pub simulation_steps: u32,
    pub world_hash: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ReplayLogSnapshot {
    pub hydration_revision: u64,
    pub hydration_tick: u64,
    pub hydration: Vec<Entity>,
    pub records: Vec<ReplayRecord>,
    pub replay_hash: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WorldSnapshot {
    pub revision: u64,
    pub tick: u64,
    pub entities: Vec<Entity>,
    pub world_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorldError {
    Invalid(String),
    RevisionConflict {
        expected: u64,
        actual: u64,
    },
    EntityNotFound(String),
    GenerationConflict {
        id: String,
        expected: u32,
        actual: u32,
    },
    RevisionOverflow,
    TickOverflow,
    ReplayLimitExceeded,
    ReplayMismatch {
        sequence: u64,
    },
    WorkerPanic,
}

impl fmt::Display for WorldError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "invalid world data: {message}"),
            Self::RevisionConflict { expected, actual } => write!(
                f,
                "expected revision {expected}, current revision is {actual}"
            ),
            Self::EntityNotFound(id) => write!(f, "entity '{id}' does not exist"),
            Self::GenerationConflict {
                id,
                expected,
                actual,
            } => write!(
                f,
                "entity '{id}' expected generation {expected}, current generation is {actual}"
            ),
            Self::RevisionOverflow => f.write_str("world revision overflow"),
            Self::TickOverflow => f.write_str("world tick overflow"),
            Self::ReplayLimitExceeded => f.write_str("replay record limit reached"),
            Self::ReplayMismatch { sequence } => {
                write!(f, "replay diverged at sequence {sequence}")
            }
            Self::WorkerPanic => f.write_str("deterministic world worker failed"),
        }
    }
}

impl std::error::Error for WorldError {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct JobPartition {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct JobPlan {
    pub worker_count: usize,
    pub partitions: Vec<JobPartition>,
}

impl JobPlan {
    pub fn for_entity_count(entity_count: usize, requested_workers: usize) -> Self {
        let worker_count = requested_workers.max(1).min(entity_count.max(1));
        let base = entity_count / worker_count;
        let remainder = entity_count % worker_count;
        let mut partitions = Vec::with_capacity(worker_count);
        let mut start = 0;
        for worker in 0..worker_count {
            let size = base + if worker < remainder { 1 } else { 0 };
            partitions.push(JobPartition {
                start,
                end: start + size,
            });
            start += size;
        }
        Self {
            worker_count,
            partitions,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SimulationReport {
    pub tick_before: u64,
    pub tick_after: u64,
    pub steps: u32,
    pub dropped_steps: u64,
    pub job_plan: JobPlan,
    pub world_hash: String,
}

#[derive(Clone, Debug)]
struct ReplayState {
    hydration_revision: u64,
    hydration_tick: u64,
    hydration: Vec<Entity>,
    records: VecDeque<ReplayRecord>,
    next_sequence: u64,
}

impl ReplayState {
    fn new(revision: u64, tick: u64, entities: Vec<Entity>) -> Self {
        Self {
            hydration_revision: revision,
            hydration_tick: tick,
            hydration: entities,
            records: VecDeque::new(),
            next_sequence: 0,
        }
    }

    fn snapshot(&self) -> ReplayLogSnapshot {
        let records = self.records.iter().cloned().collect::<Vec<_>>();
        let canonical = (
            self.hydration_revision,
            self.hydration_tick,
            &self.hydration,
            &records,
        );
        let replay_hash = hash_serializable(&canonical);
        ReplayLogSnapshot {
            hydration_revision: self.hydration_revision,
            hydration_tick: self.hydration_tick,
            hydration: self.hydration.clone(),
            records,
            replay_hash,
        }
    }
}

/// Authoritative world storage.  BTreeMap iteration is the stable entity order
/// used by snapshots, command canonicalization, simulation, and hashes.
#[derive(Clone, Debug)]
pub struct World {
    revision: u64,
    tick: u64,
    accumulator: u128,
    dropped_steps: u64,
    entities: BTreeMap<String, Entity>,
    world_hash: String,
    replay: ReplayState,
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

impl World {
    pub fn new() -> Self {
        let entities = BTreeMap::new();
        Self {
            revision: 0,
            tick: 0,
            accumulator: 0,
            dropped_steps: 0,
            world_hash: hash_world(0, 0, &entities),
            entities,
            replay: ReplayState::new(0, 0, Vec::new()),
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn tick(&self) -> u64 {
        self.tick
    }
    pub fn len(&self) -> usize {
        self.entities.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entities.is_empty()
    }

    pub fn hydrate(
        &mut self,
        revision: u64,
        entities: Vec<Entity>,
    ) -> Result<WorldSnapshot, WorldError> {
        let validated = validated_entities(entities)?;
        let next = validated
            .into_iter()
            .map(|entity| (entity.id.clone(), entity))
            .collect::<BTreeMap<_, _>>();
        self.revision = revision;
        self.tick = 0;
        self.accumulator = 0;
        self.dropped_steps = 0;
        self.entities = next;
        self.refresh_world_hash();
        self.replay = ReplayState::new(revision, 0, self.entities.values().cloned().collect());
        Ok(self.snapshot())
    }

    pub fn snapshot(&self) -> WorldSnapshot {
        let entities = self.entities.values().cloned().collect::<Vec<_>>();
        WorldSnapshot {
            revision: self.revision,
            tick: self.tick,
            entities,
            world_hash: self.world_hash.clone(),
        }
    }

    /// Return one bounded page without cloning or hashing the complete world.
    /// The cached hash is refreshed by every mutating operation before this
    /// method is exposed to the IPC snapshot path.
    pub fn snapshot_page(&self, offset: usize, limit: usize) -> WorldSnapshot {
        let total = self.entities.len();
        let offset = offset.min(total);
        let limit = limit.max(1).min(256);
        let entities = self
            .entities
            .values()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        WorldSnapshot {
            revision: self.revision,
            tick: self.tick,
            entities,
            world_hash: self.world_hash.clone(),
        }
    }

    pub fn replay_snapshot(&self) -> ReplayLogSnapshot {
        self.replay.snapshot()
    }
    pub fn replay_hash(&self) -> String {
        self.replay.snapshot().replay_hash
    }

    pub fn apply_transaction(
        &mut self,
        transaction: WorldTransaction,
    ) -> Result<WorldSnapshot, WorldError> {
        self.apply_commands(transaction.expected_revision, transaction.commands)
    }

    pub fn apply_commands(
        &mut self,
        expected_revision: u64,
        commands: Vec<WorldCommand>,
    ) -> Result<WorldSnapshot, WorldError> {
        if expected_revision != self.revision {
            return Err(WorldError::RevisionConflict {
                expected: expected_revision,
                actual: self.revision,
            });
        }
        if commands.is_empty() {
            return Err(WorldError::Invalid("commands must not be empty".into()));
        }
        if commands.len() > MAX_COMMANDS {
            return Err(WorldError::Invalid("command count exceeds bound".into()));
        }
        if self.revision == u64::MAX {
            return Err(WorldError::RevisionOverflow);
        }
        self.checkpoint_replay_if_full();

        let ordered = canonical_commands(commands)?;
        let mut candidate = self.entities.clone();
        for command in &ordered {
            apply_command(&mut candidate, command)?;
        }
        validate_entity_map(&candidate)?;

        let tick_before = self.tick;
        self.entities = candidate;
        self.revision += 1;
        self.refresh_world_hash();
        let snapshot = self.snapshot();
        self.record(ReplayRecord {
            sequence: self.replay.next_sequence,
            tick_before,
            expected_revision,
            commands: ordered,
            simulation_steps: 0,
            world_hash: snapshot.world_hash.clone(),
        });
        Ok(snapshot)
    }

    /// Advance by a wall-clock duration expressed as integer nanoseconds.  The
    /// duration only feeds an integer accumulator; simulation state advances in
    /// exactly 60 Hz ticks and at most eight ticks per call.
    pub fn advance_frame(
        &mut self,
        elapsed_nanos: u64,
        requested_workers: usize,
    ) -> Result<SimulationReport, WorldError> {
        let next_accumulator = self
            .accumulator
            .checked_add(u128::from(elapsed_nanos) * u128::from(TICKS_PER_SECOND))
            .ok_or(WorldError::TickOverflow)?;
        let available = next_accumulator / NANOS_PER_SECOND;
        let steps = available.min(u128::from(MAX_CATCH_UP_STEPS)) as u32;
        let dropped = if available > u128::from(MAX_CATCH_UP_STEPS) {
            u64::try_from(available - u128::from(MAX_CATCH_UP_STEPS))
                .map_err(|_| WorldError::TickOverflow)?
        } else {
            0
        };
        let next_dropped = self
            .dropped_steps
            .checked_add(dropped)
            .ok_or(WorldError::TickOverflow)?;
        let previous_accumulator = self.accumulator;
        let previous_dropped_steps = self.dropped_steps;
        self.accumulator = next_accumulator % NANOS_PER_SECOND;
        self.dropped_steps = next_dropped;
        match self.advance_steps_in_place(steps, requested_workers) {
            Ok(report) => Ok(report),
            Err(error) => {
                self.accumulator = previous_accumulator;
                self.dropped_steps = previous_dropped_steps;
                Err(error)
            }
        }
    }

    pub fn advance_steps(
        &mut self,
        steps: u32,
        requested_workers: usize,
    ) -> Result<SimulationReport, WorldError> {
        self.advance_steps_in_place(steps, requested_workers)
    }

    fn advance_steps_in_place(
        &mut self,
        steps: u32,
        requested_workers: usize,
    ) -> Result<SimulationReport, WorldError> {
        let steps = steps.min(MAX_CATCH_UP_STEPS);
        let tick_before = self.tick;
        let plan = JobPlan::for_entity_count(self.entities.len(), requested_workers);
        let updates = if steps > 0 {
            self.tick
                .checked_add(u64::from(steps))
                .ok_or(WorldError::TickOverflow)?;
            self.compute_motion(&plan, steps)?
        } else {
            vec![None; self.entities.len()]
        };
        if steps > 0 {
            self.checkpoint_replay_if_full();
        }
        for (entity, position) in self.entities.values_mut().zip(updates) {
            if let Some(position) = position {
                entity.position = position;
            }
        }
        self.tick += u64::from(steps);
        self.refresh_world_hash();
        let report = SimulationReport {
            tick_before,
            tick_after: self.tick,
            steps,
            dropped_steps: self.dropped_steps,
            job_plan: plan,
            world_hash: self.world_hash.clone(),
        };
        if steps > 0 {
            self.record(ReplayRecord {
                sequence: self.replay.next_sequence,
                tick_before,
                expected_revision: self.revision,
                commands: Vec::new(),
                simulation_steps: steps,
                world_hash: report.world_hash.clone(),
            });
        }
        Ok(report)
    }

    fn compute_motion(
        &self,
        plan: &JobPlan,
        steps: u32,
    ) -> Result<Vec<Option<[f64; 3]>>, WorldError> {
        if steps == 0 || self.entities.is_empty() {
            return Ok(vec![None; self.entities.len()]);
        }
        let ordered = self.entities.values().collect::<Vec<_>>();
        if plan.worker_count > 1 {
            std::thread::scope(|scope| {
                let handles = plan
                    .partitions
                    .iter()
                    .map(|partition| {
                        let slice = &ordered[partition.start..partition.end];
                        scope.spawn(move || compute_partition_motion(slice, steps))
                    })
                    .collect::<Vec<_>>();
                handles
                    .into_iter()
                    .map(|handle| handle.join().map_err(|_| WorldError::WorkerPanic)? )
                    .collect::<Result<Vec<_>, WorldError>>()
            })
            .map(|partitions| partitions.into_iter().flatten().collect())
        } else {
            compute_partition_motion(&ordered, steps)
        }
    }

    fn record(&mut self, record: ReplayRecord) {
        self.replay.next_sequence += 1;
        self.replay.records.push_back(record);
    }

    fn checkpoint_replay_if_full(&mut self) {
        if self.replay.records.len() < MAX_REPLAY_RECORDS {
            return;
        }
        self.replay.hydration_revision = self.revision;
        self.replay.hydration_tick = self.tick;
        self.replay.hydration = self.entities.values().cloned().collect();
        self.replay.records.clear();
    }

    /// Rebuild the recorded workload from its immutable hydration baseline and
    /// verify every recorded world hash.
    pub fn replay_from_hydration(
        &self,
        requested_workers: usize,
    ) -> Result<WorldSnapshot, WorldError> {
        let mut replayed = World::new();
        replayed.hydrate(
            self.replay.hydration_revision,
            self.replay.hydration.clone(),
        )?;
        replayed.tick = self.replay.hydration_tick;
        replayed.refresh_world_hash();
        for record in &self.replay.records {
            if record.commands.is_empty() {
                replayed
                    .advance_steps_without_recording(record.simulation_steps, requested_workers)?;
            } else {
                replayed.apply_commands_without_recording(
                    record.expected_revision,
                    record.commands.clone(),
                )?;
                if record.simulation_steps > 0 {
                    replayed.advance_steps_without_recording(
                        record.simulation_steps,
                        requested_workers,
                    )?;
                }
            }
            if replayed.snapshot().world_hash != record.world_hash {
                return Err(WorldError::ReplayMismatch {
                    sequence: record.sequence,
                });
            }
        }
        Ok(replayed.snapshot())
    }

    fn apply_commands_without_recording(
        &mut self,
        expected_revision: u64,
        commands: Vec<WorldCommand>,
    ) -> Result<(), WorldError> {
        if expected_revision != self.revision {
            return Err(WorldError::RevisionConflict {
                expected: expected_revision,
                actual: self.revision,
            });
        }
        if commands.is_empty() || commands.len() > MAX_COMMANDS {
            return Err(WorldError::Invalid("command count is out of bounds".into()));
        }
        let ordered = canonical_commands(commands)?;
        let mut candidate = self.entities.clone();
        for command in &ordered {
            apply_command(&mut candidate, command)?;
        }
        validate_entity_map(&candidate)?;
        self.entities = candidate;
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or(WorldError::RevisionOverflow)?;
        self.refresh_world_hash();
        Ok(())
    }

    fn advance_steps_without_recording(
        &mut self,
        steps: u32,
        requested_workers: usize,
    ) -> Result<(), WorldError> {
        let steps = steps.min(MAX_CATCH_UP_STEPS);
        if steps > 0 {
            self.tick
                .checked_add(u64::from(steps))
                .ok_or(WorldError::TickOverflow)?;
        }
        let plan = JobPlan::for_entity_count(self.entities.len(), requested_workers);
        let updates = self.compute_motion(&plan, steps)?;
        for (entity, position) in self.entities.values_mut().zip(updates) {
            if let Some(position) = position {
                entity.position = position;
            }
        }
        self.tick += u64::from(steps);
        self.refresh_world_hash();
        Ok(())
    }

    fn refresh_world_hash(&mut self) {
        self.world_hash = hash_world(self.revision, self.tick, &self.entities);
    }
}

fn compute_partition_motion(
    entities: &[&Entity],
    steps: u32,
) -> Result<Vec<Option<[f64; 3]>>, WorldError> {
    let mut updates = Vec::with_capacity(entities.len());
    for entity in entities {
        if entity.velocity.iter().any(|value| *value != 0.0) {
            let mut position = entity.position;
            for _ in 0..steps {
                for axis in 0..3 {
                    position[axis] += entity.velocity[axis] / TICKS_PER_SECOND as f64;
                }
                position = quantize_position(position)?;
            }
            updates.push(Some(position));
        } else {
            updates.push(None);
        }
    }
    Ok(updates)
}

fn canonical_commands(mut commands: Vec<WorldCommand>) -> Result<Vec<WorldCommand>, WorldError> {
    commands.sort_by(|left, right| command_key(left).cmp(&command_key(right)));
    let mut previous = None;
    for command in &commands {
        let key = command_key(command);
        if previous.as_ref() == Some(&key) {
            return Err(WorldError::Invalid(
                "duplicate command for the same entity operation".into(),
            ));
        }
        previous = Some(key);
    }
    Ok(commands)
}

fn command_key(command: &WorldCommand) -> (String, u8) {
    match command {
        WorldCommand::Upsert { entity } => (entity.id.clone(), 0),
        WorldCommand::SetTransform { id, .. } => (id.clone(), 1),
        WorldCommand::SetVelocity { id, .. } => (id.clone(), 2),
        WorldCommand::Remove { id, .. } => (id.clone(), 3),
    }
}

fn apply_command(
    entities: &mut BTreeMap<String, Entity>,
    command: &WorldCommand,
) -> Result<(), WorldError> {
    match command {
        WorldCommand::Upsert { entity } => {
            validate_entity(entity)?;
            let mut normalized = entity.clone();
            normalized.position = quantize_position(normalized.position)?;
            entities.insert(normalized.id.clone(), normalized);
        }
        WorldCommand::Remove {
            id,
            expected_generation,
        } => {
            validate_id(id)?;
            let entity = entities
                .get(id)
                .ok_or_else(|| WorldError::EntityNotFound(id.clone()))?;
            check_generation(id, entity.generation, *expected_generation)?;
            entities.remove(id);
        }
        WorldCommand::SetTransform {
            id,
            position,
            rotation,
            scale,
            expected_generation,
        } => {
            validate_id(id)?;
            let position = quantize_position(*position)?;
            validate_rotation(*rotation)?;
            validate_scale(*scale)?;
            let entity = entities
                .get_mut(id)
                .ok_or_else(|| WorldError::EntityNotFound(id.clone()))?;
            check_generation(id, entity.generation, *expected_generation)?;
            entity.position = position;
            entity.rotation = *rotation;
            entity.scale = *scale;
        }
        WorldCommand::SetVelocity {
            id,
            velocity,
            expected_generation,
        } => {
            validate_id(id)?;
            validate_velocity(*velocity)?;
            let entity = entities
                .get_mut(id)
                .ok_or_else(|| WorldError::EntityNotFound(id.clone()))?;
            check_generation(id, entity.generation, *expected_generation)?;
            entity.velocity = *velocity;
        }
    }
    Ok(())
}

fn check_generation(id: &str, actual: u32, expected: Option<u32>) -> Result<(), WorldError> {
    if let Some(expected) = expected {
        if expected != actual {
            return Err(WorldError::GenerationConflict {
                id: id.into(),
                expected,
                actual,
            });
        }
    }
    Ok(())
}

fn validated_entities(entities: Vec<Entity>) -> Result<Vec<Entity>, WorldError> {
    if entities.len() > MAX_ENTITIES {
        return Err(WorldError::Invalid("entity count exceeds bound".into()));
    }
    let mut by_id = BTreeMap::new();
    for mut entity in entities {
        validate_entity(&entity)?;
        entity.position = quantize_position(entity.position)?;
        if by_id.insert(entity.id.clone(), entity).is_some() {
            return Err(WorldError::Invalid("duplicate entity id".into()));
        }
    }
    Ok(by_id.into_values().collect())
}

fn validate_entity_map(entities: &BTreeMap<String, Entity>) -> Result<(), WorldError> {
    if entities.len() > MAX_ENTITIES {
        return Err(WorldError::Invalid("entity count exceeds bound".into()));
    }
    for (id, entity) in entities {
        if id != &entity.id {
            return Err(WorldError::Invalid(
                "entity map key does not match entity id".into(),
            ));
        }
        validate_entity(entity)?;
    }
    Ok(())
}

fn validate_entity(entity: &Entity) -> Result<(), WorldError> {
    validate_id(&entity.id)?;
    if entity.generation > MAX_GENERATION {
        return Err(WorldError::Invalid(
            "entity generation exceeds bound".into(),
        ));
    }
    validate_position(entity.position)?;
    validate_color(entity.color)?;
    validate_rotation(entity.rotation)?;
    validate_scale(entity.scale)?;
    validate_velocity(entity.velocity)?;
    if let Some(render) = &entity.render {
        if let Some(hash) = &render.asset_hash {
            validate_asset_hash(hash)?;
        }
    }
    if let Some(light) = &entity.light {
        validate_light(light)?;
    }
    if let Some(animation) = &entity.animation {
        if let Some(hash) = &animation.asset_hash {
            validate_asset_hash(hash)?;
        }
        validate_id(&animation.clip)?;
        if !animation.time_seconds.is_finite()
            || animation.time_seconds.abs() > MAX_ABS_TIME
            || !animation.speed.is_finite()
            || animation.speed.abs() > 1_000_000.0
        {
            return Err(WorldError::Invalid(
                "animation values are out of range".into(),
            ));
        }
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<(), WorldError> {
    if id.is_empty()
        || id.len() > MAX_ID_BYTES
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:".contains(&byte))
    {
        return Err(WorldError::Invalid("entity or clip id is invalid".into()));
    }
    Ok(())
}

fn validate_asset_hash(hash: &str) -> Result<(), WorldError> {
    if hash.len() != MAX_ASSET_HASH_BYTES
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(WorldError::Invalid(
            "asset hash must be exactly 64 lowercase hexadecimal bytes".into(),
        ));
    }
    Ok(())
}

fn quantize_position(position: [f64; 3]) -> Result<[f64; 3], WorldError> {
    validate_position(position)?;
    let mut quantized = [0.0; 3];
    for (index, value) in position.into_iter().enumerate() {
        let units = (value * POSITION_MICRO_UNITS).round();
        if !units.is_finite() || units.abs() > i64::MAX as f64 {
            return Err(WorldError::Invalid(
                "position micro-units exceed signed range".into(),
            ));
        }
        quantized[index] = units / POSITION_MICRO_UNITS;
    }
    Ok(quantized)
}

fn validate_position(position: [f64; 3]) -> Result<(), WorldError> {
    if position
        .iter()
        .any(|value| !value.is_finite() || value.abs() > MAX_ABS_POSITION)
    {
        return Err(WorldError::Invalid(
            "position is not finite or exceeds bounds".into(),
        ));
    }
    Ok(())
}

fn validate_velocity(velocity: [f64; 3]) -> Result<(), WorldError> {
    if velocity
        .iter()
        .any(|value| !value.is_finite() || value.abs() > MAX_ABS_VELOCITY)
    {
        return Err(WorldError::Invalid(
            "velocity is not finite or exceeds bounds".into(),
        ));
    }
    Ok(())
}

fn validate_rotation(rotation: [f64; 4]) -> Result<(), WorldError> {
    if rotation
        .iter()
        .any(|value| !value.is_finite() || value.abs() > 1.0)
        || rotation.iter().map(|value| value * value).sum::<f64>() < 1e-12
    {
        return Err(WorldError::Invalid(
            "rotation is not a bounded quaternion".into(),
        ));
    }
    Ok(())
}

fn validate_scale(scale: [f64; 3]) -> Result<(), WorldError> {
    if scale
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0001 || *value > 1_000_000.0)
    {
        return Err(WorldError::Invalid(
            "scale is not finite or exceeds bounds".into(),
        ));
    }
    Ok(())
}

fn validate_color(color: [f64; 4]) -> Result<(), WorldError> {
    if color
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0 || *value > 1.0)
    {
        return Err(WorldError::Invalid(
            "color is not in the range [0,1]".into(),
        ));
    }
    Ok(())
}

fn validate_light(light: &LightData) -> Result<(), WorldError> {
    if !matches!(light.kind.as_str(), "directional" | "point" | "spot") {
        return Err(WorldError::Invalid("light kind is unsupported".into()));
    }
    validate_color([light.color[0], light.color[1], light.color[2], 1.0])?;
    if !light.intensity.is_finite()
        || light.intensity < 0.0
        || light.intensity > 1_000_000.0
        || !light.range.is_finite()
        || light.range < 0.0
        || light.range > MAX_ABS_POSITION
        || !light.spot_inner_angle.is_finite()
        || !light.spot_outer_angle.is_finite()
        || light.spot_inner_angle < 0.0
        || light.spot_outer_angle < light.spot_inner_angle
        || light.spot_outer_angle > std::f64::consts::PI
    {
        return Err(WorldError::Invalid("light values are out of range".into()));
    }
    Ok(())
}

fn hash_serializable<T: Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).expect("world DTOs are serializable");
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn hash_world(revision: u64, tick: u64, entities: &BTreeMap<String, Entity>) -> String {
    let ordered = entities.values().cloned().collect::<Vec<_>>();
    hash_serializable(&(revision, tick, &ordered))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entity(id: &str) -> Entity {
        Entity {
            id: id.into(),
            position: [0.0, 0.0, 0.0],
            color: [0.2, 0.6, 1.0, 1.0],
            generation: 1,
            rotation: identity_rotation(),
            scale: unit_scale(),
            velocity: zero_vec3(),
            render: None,
            light: None,
            animation: None,
        }
    }

    #[test]
    fn hydration_is_sorted_and_backward_compatible() {
        let mut world = World::new();
        let snapshot = world.hydrate(7, vec![entity("z"), entity("a")]).unwrap();
        assert_eq!(snapshot.revision, 7);
        assert_eq!(
            snapshot
                .entities
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "z"]
        );
        let before = world.snapshot();
        let mut invalid = entity("invalid");
        invalid.color[0] = f64::NAN;
        assert!(matches!(
            world.hydrate(8, vec![invalid]),
            Err(WorldError::Invalid(_))
        ));
        assert_eq!(world.snapshot(), before);
        let old =
            serde_json::json!({"id":"legacy","position":[1.0,2.0,3.0],"color":[1.0,0.0,0.0,1.0]});
        let parsed: Entity = serde_json::from_value(old).unwrap();
        assert_eq!(parsed.rotation, identity_rotation());
        let page = world.snapshot_page(1, 1);
        assert_eq!(page.entities.len(), 1);
        assert_eq!(page.entities[0].id, "z");
        assert_eq!(page.world_hash, snapshot.world_hash);
    }

    #[test]
    fn invalid_transaction_is_atomic() {
        let mut world = World::new();
        world.hydrate(0, vec![entity("a")]).unwrap();
        let before = world.snapshot();
        let result = world.apply_commands(
            0,
            vec![WorldCommand::SetVelocity {
                id: "a".into(),
                velocity: [f64::NAN, 0.0, 0.0],
                expected_generation: Some(1),
            }],
        );
        assert!(matches!(result, Err(WorldError::Invalid(_))));
        assert_eq!(world.snapshot(), before);
    }

    #[test]
    fn stale_revision_is_rejected_without_mutation() {
        let mut world = World::new();
        world.hydrate(4, vec![entity("a")]).unwrap();
        let before = world.snapshot();
        let result = world.apply_commands(
            3,
            vec![WorldCommand::Remove {
                id: "a".into(),
                expected_generation: Some(1),
            }],
        );
        assert_eq!(
            result,
            Err(WorldError::RevisionConflict {
                expected: 3,
                actual: 4
            })
        );
        assert_eq!(world.snapshot(), before);
    }

    #[test]
    fn fixed_step_is_bounded_and_worker_count_independent() {
        let mut one = World::new();
        let mut many = World::new();
        let mut a = entity("a");
        a.velocity = [60.0, -30.0, 0.0];
        one.hydrate(0, vec![a.clone(), entity("b")]).unwrap();
        many.hydrate(0, vec![a, entity("b")]).unwrap();
        let report_one = one.advance_frame(1_000_000_000, 1).unwrap();
        let report_many = many.advance_frame(1_000_000_000, 8).unwrap();
        assert_eq!(report_one.steps, 8);
        assert_eq!(report_one.tick_after, report_many.tick_after);
        assert_eq!(one.snapshot(), many.snapshot());
        assert_eq!(report_one.world_hash, report_many.world_hash);
        assert_eq!(report_many.job_plan.worker_count, 2);
        assert_eq!(report_many.job_plan.partitions.len(), 2);
    }

    #[test]
    fn position_updates_are_quantized_to_micro_units() {
        let mut world = World::new();
        let mut moving = entity("moving");
        moving.velocity = [0.1, 0.0, 0.0];
        world.hydrate(0, vec![moving]).unwrap();
        world.advance_steps(1, 2).unwrap();
        assert_eq!(
            world.snapshot().entities[0].position[0],
            1_667.0 / POSITION_MICRO_UNITS
        );
    }

    #[test]
    fn uppercase_hashes_and_path_like_ids_are_rejected() {
        let mut upper_hash = entity("valid");
        upper_hash.render = Some(RenderData {
            asset_hash: Some("A".repeat(MAX_ASSET_HASH_BYTES)),
            visible: true,
            cast_shadow: false,
            receive_shadow: false,
            layer: 0,
        });
        let mut world = World::new();
        assert!(matches!(
            world.hydrate(0, vec![upper_hash]),
            Err(WorldError::Invalid(_))
        ));
        let path_like = entity("folder/item");
        assert!(matches!(
            world.hydrate(0, vec![path_like]),
            Err(WorldError::Invalid(_))
        ));
    }

    #[test]
    fn multi_step_overflow_does_not_commit_partial_simulation() {
        let mut world = World::new();
        world.hydrate(0, vec![entity("a")]).unwrap();
        world.tick = u64::MAX - 1;
        let before = world.snapshot();
        assert_eq!(world.advance_steps(2, 2), Err(WorldError::TickOverflow));
        assert_eq!(world.snapshot(), before);
    }

    #[test]
    fn invalid_motion_does_not_commit_partial_simulation() {
        let mut world = World::new();
        let mut moving = entity("edge");
        moving.position = [MAX_ABS_POSITION, 0.0, 0.0];
        moving.velocity = [60.0, 0.0, 0.0];
        world.hydrate(0, vec![moving]).unwrap();
        let before = world.snapshot();
        assert!(matches!(
            world.advance_steps(2, 4),
            Err(WorldError::Invalid(_))
        ));
        assert_eq!(world.snapshot(), before);
    }

    #[test]
    fn replay_hash_and_result_are_stable() {
        let mut world = World::new();
        world.hydrate(0, vec![entity("a")]).unwrap();
        world
            .apply_commands(
                0,
                vec![WorldCommand::SetVelocity {
                    id: "a".into(),
                    velocity: [6.0, 0.0, 0.0],
                    expected_generation: Some(1),
                }],
            )
            .unwrap();
        world.advance_steps(2, 3).unwrap();
        let first_hash = world.replay_hash();
        let replay = world.replay_from_hydration(1).unwrap();
        assert_eq!(replay, world.snapshot());
        assert_eq!(first_hash, world.replay_hash());
    }

    #[test]
    fn full_replay_log_checkpoints_without_stalling_simulation() {
        let mut world = World::new();
        world.hydrate(0, vec![entity("a")]).unwrap();
        let hash = world.snapshot().world_hash;
        for sequence in 0..MAX_REPLAY_RECORDS as u64 {
            world.replay.records.push_back(ReplayRecord {
                sequence,
                tick_before: 0,
                expected_revision: 0,
                commands: Vec::new(),
                simulation_steps: 0,
                world_hash: hash.clone(),
            });
        }
        world.advance_steps(1, 1).unwrap();
        assert_eq!(world.replay.records.len(), 1);
        assert_eq!(world.replay.hydration_tick, 0);
        assert_eq!(world.replay_from_hydration(1).unwrap(), world.snapshot());
    }

    #[test]
    fn stable_command_order_and_bounded_partitioning() {
        let plan = JobPlan::for_entity_count(10, 3);
        assert_eq!(
            plan.partitions,
            vec![
                JobPartition { start: 0, end: 4 },
                JobPartition { start: 4, end: 7 },
                JobPartition { start: 7, end: 10 }
            ]
        );
        let mut world = World::new();
        world.hydrate(0, vec![entity("b"), entity("a")]).unwrap();
        world
            .apply_commands(
                0,
                vec![
                    WorldCommand::SetVelocity {
                        id: "b".into(),
                        velocity: [1.0, 0.0, 0.0],
                        expected_generation: Some(1),
                    },
                    WorldCommand::SetVelocity {
                        id: "a".into(),
                        velocity: [2.0, 0.0, 0.0],
                        expected_generation: Some(1),
                    },
                ],
            )
            .unwrap();
        assert_eq!(
            world.replay_snapshot().records[0].commands[0],
            WorldCommand::SetVelocity {
                id: "a".into(),
                velocity: [2.0, 0.0, 0.0],
                expected_generation: Some(1)
            }
        );
    }
}
