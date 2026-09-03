//! Deterministic, bounded source-asset cooking.
//!
//! The cooker deliberately accepts an opaque lower-case SHA-256 source ID,
//! never an arbitrary source path.  A source is read from `source_root/<id>`,
//! verified while it is streamed in bounded chunks, and published atomically
//! below the configured derived root.  Public result/status DTOs contain IDs,
//! formats, hashes, sizes, diagnostics, and manifest data only; filesystem
//! paths remain configuration/implementation details.
//!
//! The glTF implementation accepts JSON glTF 2.0 and GLB 2.0.  JSON is parsed
//! with duplicate-key and finite-number checks before canonical serialization.
//! GLB may contain one JSON chunk and one BIN chunk; all other chunk types are
//! rejected.  URI fields are either absent (embedded data) or
//! `auvra-asset:<lower-case-sha256>`.  File, HTTP(S), data, traversal, and
//! other URI forms fail closed.
//!
//! The FBX implementation is intentionally a small ASCII FBX 7.x subset.  It
//! accepts only `Vertices` and `PolygonVertexIndex` arrays, with finite vertex
//! triples and signed polygon indices.  Binary FBX and other FBX constructs
//! are unsupported and fail closed.  The emitted artifact is an Auvra-owned
//! deterministic envelope, not a claim of interchange-format preservation.

use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
#[cfg(test)]
use std::time::Duration;

pub const DEFAULT_MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
pub const DEFAULT_MAX_JSON_BYTES: u64 = 16 * 1024 * 1024;
pub const DEFAULT_MAX_FBX_BYTES: u64 = 64 * 1024 * 1024;
pub const DEFAULT_MAX_VERTICES: usize = 1_000_000;
pub const DEFAULT_MAX_POLYGON_INDICES: usize = 3_000_000;
pub const DEFAULT_QUEUE_CAPACITY: usize = 8;
pub const MAX_RETAINED_JOBS: usize = 256;
const MAX_DEFERRED_JOBS: usize = 4096;
pub const READ_CHUNK_BYTES: usize = 1024 * 1024;

const SHA256_HEX_LENGTH: usize = 64;
const GLB_JSON_CHUNK: u32 = 0x4e4f_534a;
const GLB_BIN_CHUNK: u32 = 0x004e_4942;
const ARTIFACT_MAGIC: &[u8] = b"AUVRA-COOKED/1\n";
static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct CookConfig {
    source_root: PathBuf,
    derived_root: PathBuf,
    max_source_bytes: u64,
    max_json_bytes: u64,
    max_fbx_bytes: u64,
    max_vertices: usize,
    max_polygon_indices: usize,
    queue_capacity: usize,
}

impl CookConfig {
    pub fn new(source_root: impl Into<PathBuf>, derived_root: impl Into<PathBuf>) -> Self {
        Self {
            source_root: source_root.into(),
            derived_root: derived_root.into(),
            max_source_bytes: DEFAULT_MAX_SOURCE_BYTES,
            max_json_bytes: DEFAULT_MAX_JSON_BYTES,
            max_fbx_bytes: DEFAULT_MAX_FBX_BYTES,
            max_vertices: DEFAULT_MAX_VERTICES,
            max_polygon_indices: DEFAULT_MAX_POLYGON_INDICES,
            queue_capacity: DEFAULT_QUEUE_CAPACITY,
        }
    }

    pub fn with_limits(
        mut self,
        max_source_bytes: u64,
        max_json_bytes: u64,
        max_fbx_bytes: u64,
    ) -> Self {
        self.max_source_bytes = max_source_bytes;
        self.max_json_bytes = max_json_bytes;
        self.max_fbx_bytes = max_fbx_bytes;
        self
    }

    pub fn with_geometry_limits(mut self, max_vertices: usize, max_polygon_indices: usize) -> Self {
        self.max_vertices = max_vertices;
        self.max_polygon_indices = max_polygon_indices;
        self
    }

    pub fn with_queue_capacity(mut self, queue_capacity: usize) -> Self {
        self.queue_capacity = queue_capacity;
        self
    }
}

#[derive(Clone, Debug, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct CookDiagnostic {
    pub severity: String,
    pub code: String,
    pub message: String,
}

impl CookDiagnostic {
    fn warning(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            severity: "warning".into(),
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct CookError {
    pub code: String,
    pub message: String,
    pub diagnostics: Vec<CookDiagnostic>,
}

impl CookError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            diagnostics: Vec::new(),
        }
    }
    fn cancelled() -> Self {
        Self::new("cancelled", "asset cooking was cancelled")
    }
}

impl fmt::Display for CookError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(output, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CookError {}

impl From<io::Error> for CookError {
    fn from(error: io::Error) -> Self {
        Self::new("io_error", error.kind().to_string())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct CookManifest {
    pub schema: u32,
    pub source_sha256: String,
    pub source_size: u64,
    pub source_format: String,
    pub artifact_sha256: String,
    pub artifact_size: u64,
    pub warnings: Vec<CookDiagnostic>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CookResult {
    pub source_id: String,
    pub source_format: String,
    pub artifact_sha256: String,
    pub artifact_size: u64,
    pub manifest: CookManifest,
}

#[derive(Clone, Debug, Serialize)]
pub enum JobState {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
pub struct CookStatus {
    pub job_id: u64,
    pub source_id: String,
    pub state: JobState,
    pub result: Option<CookResult>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug)]
pub struct CookSubmission {
    pub job_id: u64,
    pub cancellation: CancellationToken,
}

#[derive(Clone)]
struct Job {
    job_id: u64,
    source_id: String,
    cancellation: CancellationToken,
}

#[derive(Clone)]
struct JobRecord {
    source_id: String,
    state: JobState,
    result: Option<CookResult>,
    error: Option<CookError>,
    cancellation: CancellationToken,
}

struct QueueState {
    queue: VecDeque<Job>,
    jobs: BTreeMap<u64, JobRecord>,
    stopping: bool,
    capacity: usize,
}

pub struct CookWorker {
    state: Arc<(Mutex<QueueState>, Condvar)>,
    next_job: Arc<AtomicU64>,
    thread: Option<thread::JoinHandle<()>>,
}

impl CookWorker {
    pub fn new(config: CookConfig) -> Result<Self, CookError> {
        if config.queue_capacity == 0 {
            return Err(CookError::new(
                "invalid_queue_capacity",
                "queue capacity must be positive",
            ));
        }
        if unsafe_path(&config.source_root) {
            return Err(CookError::new(
                "unsafe_source_root",
                "configured source root is linked or reparse-pointed",
            ));
        }
        validate_root(&config.source_root, "unsafe_source_root")?;
        ensure_derived_root(&config.derived_root)?;
        let state = Arc::new((
            Mutex::new(QueueState {
                queue: VecDeque::new(),
                jobs: BTreeMap::new(),
                stopping: false,
                capacity: config.queue_capacity,
            }),
            Condvar::new(),
        ));
        let worker_state = Arc::clone(&state);
        let worker_config = Arc::new(config);
        let next_job = Arc::new(AtomicU64::new(1));
        let thread = thread::Builder::new()
            .name("auvra-asset-cooker".into())
            .spawn(move || {
                loop {
                    let job = {
                        let (lock, wake) = &*worker_state;
                        let mut guard = lock.lock().expect("asset queue mutex poisoned");
                        while guard.queue.is_empty() && !guard.stopping {
                            guard = wake.wait(guard).expect("asset queue condvar poisoned");
                        }
                        if guard.queue.is_empty() && guard.stopping {
                            break;
                        }
                        guard.queue.pop_front().expect("queue was checked above")
                    };
                    {
                        let (lock, _) = &*worker_state;
                        if let Some(record) = lock
                            .lock()
                            .expect("asset queue mutex poisoned")
                            .jobs
                            .get_mut(&job.job_id)
                        {
                            record.state = if job.cancellation.is_cancelled() {
                                JobState::Cancelled
                            } else {
                                JobState::Running
                            };
                        }
                    }
                    if job.cancellation.is_cancelled() {
                        let (lock, _) = &*worker_state;
                        let mut guard = lock.lock().expect("asset queue mutex poisoned");
                        trim_completed_jobs(&mut guard);
                        continue;
                    }
                    let result = cook_source(&worker_config, &job.source_id, &job.cancellation);
                    let (lock, _) = &*worker_state;
                    let mut guard = lock.lock().expect("asset queue mutex poisoned");
                    if let Some(record) = guard.jobs.get_mut(&job.job_id) {
                        match result {
                            Ok(value) => {
                                record.state = JobState::Completed;
                                record.result = Some(value);
                            }
                            Err(error) if error.code == "cancelled" => {
                                record.state = JobState::Cancelled;
                                record.error = Some(error);
                            }
                            Err(error) => {
                                record.state = JobState::Failed;
                                record.error = Some(error);
                            }
                        }
                    }
                    trim_completed_jobs(&mut guard);
                }
            })
            .map_err(|_| CookError::new("worker_start_failed", "asset worker could not start"))?;
        Ok(Self {
            state,
            next_job,
            thread: Some(thread),
        })
    }

    pub fn submit(&self, source_id: &str) -> Result<CookSubmission, CookError> {
        self.submit_inner(source_id, true)
    }

    /// Queue a hydration job without treating normal worker backpressure as a
    /// permanent deferral.  The queue remains bounded by a generous safety
    /// ceiling, while the regular interactive submission API keeps its fast
    /// queue-full behavior.
    pub fn submit_deferred(&self, source_id: &str) -> Result<CookSubmission, CookError> {
        self.submit_inner(source_id, false)
    }

    fn submit_inner(
        &self,
        source_id: &str,
        enforce_capacity: bool,
    ) -> Result<CookSubmission, CookError> {
        validate_source_id(source_id)?;
        let job_id = self.next_job.fetch_add(1, Ordering::Relaxed);
        let cancellation = CancellationToken::new();
        let job = Job {
            job_id,
            source_id: source_id.into(),
            cancellation: cancellation.clone(),
        };
        let (lock, wake) = &*self.state;
        let mut guard = lock.lock().expect("asset queue mutex poisoned");
        if guard.stopping {
            return Err(CookError::new("worker_stopped", "asset worker is stopped"));
        }
        let active_jobs = guard
            .jobs
            .values()
            .filter(|record| matches!(record.state, JobState::Queued | JobState::Running))
            .count();
        let limit = if enforce_capacity {
            guard.capacity
        } else {
            guard.capacity.saturating_add(MAX_DEFERRED_JOBS)
        };
        if active_jobs >= limit {
            return Err(CookError::new("queue_full", "asset cooking queue is full"));
        }
        guard.jobs.insert(
            job_id,
            JobRecord {
                source_id: source_id.into(),
                state: JobState::Queued,
                result: None,
                error: None,
                cancellation: cancellation.clone(),
            },
        );
        guard.queue.push_back(job);
        wake.notify_one();
        Ok(CookSubmission {
            job_id,
            cancellation,
        })
    }

    pub fn status(&self, job_id: u64) -> Option<CookStatus> {
        let (lock, _) = &*self.state;
        let guard = lock.lock().expect("asset queue mutex poisoned");
        guard.jobs.get(&job_id).map(|record| CookStatus {
            job_id,
            source_id: record.source_id.clone(),
            state: record.state.clone(),
            result: record.result.clone(),
            error_code: record.error.as_ref().map(|error| error.code.clone()),
            error_message: record.error.as_ref().map(|error| error.message.clone()),
        })
    }
}

fn trim_completed_jobs(state: &mut QueueState) {
    let terminal = state
        .jobs
        .iter()
        .filter(|(_, record)| {
            matches!(
                record.state,
                JobState::Completed | JobState::Failed | JobState::Cancelled
            )
        })
        .map(|(job_id, _)| *job_id)
        .collect::<Vec<_>>();
    let excess = terminal.len().saturating_sub(MAX_RETAINED_JOBS);
    for job_id in terminal.into_iter().take(excess) {
        state.jobs.remove(&job_id);
    }
}

impl Drop for CookWorker {
    fn drop(&mut self) {
        let (lock, wake) = &*self.state;
        if let Ok(mut guard) = lock.lock() {
            guard.stopping = true;
            guard.queue.clear();
            for record in guard.jobs.values_mut() {
                if matches!(record.state, JobState::Queued | JobState::Running) {
                    record.cancellation.cancel();
                    record.state = JobState::Cancelled;
                }
            }
            wake.notify_all();
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub fn validate_source_id(source_id: &str) -> Result<(), CookError> {
    if source_id.len() != SHA256_HEX_LENGTH
        || !source_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(CookError::new(
            "invalid_source_id",
            "source ID must be a lower-case SHA-256 digest",
        ));
    }
    Ok(())
}

pub fn cook_source(
    config: &CookConfig,
    source_id: &str,
    cancellation: &CancellationToken,
) -> Result<CookResult, CookError> {
    validate_source_id(source_id)?;
    let staged = read_source(config, source_id, cancellation)?;
    let mut probe = File::open(&staged.path)
        .map_err(|_| CookError::new("source_unavailable", "source asset is unavailable"))?;
    let mut magic = [0_u8; 64];
    let magic_len = probe.read(&mut magic)?;
    drop(probe);
    let (source_format, canonical_json, binary, warnings) =
        if magic_len >= 4 && &magic[..4] == b"glTF" {
            let parsed = parse_glb_file(&staged, config, cancellation)?;
            ("glb".to_string(), parsed.json, parsed.bin, Vec::new())
        } else if magic_len >= 4 && &magic[..4] == b"; FB" {
            let source = read_bounded_file(&staged.path, config.max_fbx_bytes, cancellation)?;
            let (document, fbx_warnings) = parse_fbx(&source, config)?;
            (
                "fbx-ascii-7x-subset".to_string(),
                document,
                None,
                fbx_warnings,
            )
        } else if magic[..magic_len]
            .iter()
            .copied()
            .find(|byte| !byte.is_ascii_whitespace())
            .is_some_and(|byte| byte == b'{' || byte == b'[')
        {
            (
                "gltf-json".to_string(),
                parse_gltf_file(&staged, config, cancellation)?,
                None,
                Vec::new(),
            )
        } else {
            return Err(CookError::new(
                "unsupported_source_format",
                "source is not supported glTF JSON, GLB 2.0, or ASCII FBX 7.x subset",
            ));
        };
    if cancellation.is_cancelled() {
        return Err(CookError::cancelled());
    }
    let transaction = create_transaction(&config.derived_root)?;
    let result = (|| {
        let artifact_path = transaction.join("artifact.bin");
        let (artifact_sha256, artifact_size) = write_artifact_file(
            &artifact_path,
            &source_format,
            &canonical_json,
            binary,
            &staged.path,
            cancellation,
        )?;
        let manifest = CookManifest {
            schema: 1,
            source_sha256: source_id.into(),
            source_size: staged.size,
            source_format: source_format.clone(),
            artifact_sha256: artifact_sha256.clone(),
            artifact_size,
            warnings,
        };
        let manifest_bytes = canonical_json_bytes(
            &serde_json::to_value(&manifest)
                .map_err(|_| CookError::new("manifest_error", "manifest serialization failed"))?,
        )?;
        write_complete_file(&transaction.join("manifest.json"), &manifest_bytes)?;
        commit_publication(
            config,
            &artifact_sha256,
            transaction.clone(),
            &manifest_bytes,
        )?;
        Ok(CookResult {
            source_id: source_id.into(),
            source_format,
            artifact_sha256,
            artifact_size,
            manifest,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&transaction);
    }
    result
}

struct StagedSource {
    path: PathBuf,
    size: u64,
}

impl Drop for StagedSource {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

struct ParsedGlb {
    json: Vec<u8>,
    bin: Option<(u64, u64)>,
}

fn read_source(
    config: &CookConfig,
    source_id: &str,
    cancellation: &CancellationToken,
) -> Result<StagedSource, CookError> {
    validate_root(&config.source_root, "unsafe_source_root")?;
    ensure_derived_root(&config.derived_root)?;
    let path = config.source_root.join(source_id);
    if unsafe_path(&path) {
        return Err(CookError::new(
            "unsafe_source",
            "source entry is linked or reparse-pointed",
        ));
    }
    let metadata = fs::metadata(&path)
        .map_err(|_| CookError::new("source_unavailable", "source asset is unavailable"))?;
    if !metadata.is_file() {
        return Err(CookError::new(
            "source_unavailable",
            "source asset is not a regular file",
        ));
    }
    let temporary_path = config.derived_root.join(format!(
        ".source-stage-{}-{}-{source_id}",
        std::process::id(),
        NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .map_err(|_| CookError::new("staging_failed", "source staging could not start"))?;
        let mut input = File::open(&path)
            .map_err(|_| CookError::new("source_unavailable", "source asset is unavailable"))?;
        let mut buffer = vec![0_u8; READ_CHUNK_BYTES];
        let mut total = 0_u64;
        let mut hasher = Sha256::new();
        loop {
            if cancellation.is_cancelled() {
                return Err(CookError::cancelled());
            }
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            total = total
                .checked_add(count as u64)
                .ok_or_else(|| CookError::new("source_too_large", "source size overflow"))?;
            if total > config.max_source_bytes {
                return Err(CookError::new(
                    "source_too_large",
                    "source exceeds configured limit",
                ));
            }
            hasher.update(&buffer[..count]);
            output.write_all(&buffer[..count])?;
        }
        output.flush()?;
        output.sync_all()?;
        if hasher.finalize_hex() != source_id {
            return Err(CookError::new(
                "source_hash_mismatch",
                "source bytes do not match source ID",
            ));
        }
        Ok(StagedSource {
            path: temporary_path.clone(),
            size: total,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn create_transaction(root: &Path) -> Result<PathBuf, CookError> {
    validate_root(root, "unsafe_derived_root")?;
    let path = root.join(format!(
        ".cook-txn-{}-{}",
        std::process::id(),
        NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&path)
        .map_err(|_| CookError::new("staging_failed", "cooking transaction could not start"))?;
    Ok(path)
}

fn write_complete_file(path: &Path, bytes: &[u8]) -> Result<(), CookError> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()?;
    Ok(())
}

fn commit_publication(
    config: &CookConfig,
    artifact_id: &str,
    transaction: PathBuf,
    manifest: &[u8],
) -> Result<(), CookError> {
    let destination = config.derived_root.join(artifact_id);
    if unsafe_path(&destination) {
        let _ = fs::remove_dir_all(&transaction);
        return Err(CookError::new(
            "unsafe_derived_root",
            "derived artifact destination is linked",
        ));
    }
    if destination.exists() {
        let valid = complete_publication_matches(&destination, artifact_id, manifest);
        let _ = fs::remove_dir_all(&transaction);
        return if valid {
            Ok(())
        } else {
            Err(CookError::new(
                "publication_conflict",
                "derived artifact already exists with different bytes",
            ))
        };
    }
    match fs::rename(&transaction, &destination) {
        Ok(()) => Ok(()),
        Err(_) if destination.exists() => {
            if complete_publication_matches(&destination, artifact_id, manifest) {
                let _ = fs::remove_dir_all(&transaction);
                Ok(())
            } else {
                let _ = fs::remove_dir_all(&transaction);
                Err(CookError::new(
                    "publication_conflict",
                    "derived artifact already exists with different bytes",
                ))
            }
        }
        Err(_) => {
            let _ = fs::remove_dir_all(&transaction);
            Err(CookError::new(
                "publication_failed",
                "derived artifact publication failed",
            ))
        }
    }
}

fn complete_publication_matches(destination: &Path, artifact_id: &str, manifest: &[u8]) -> bool {
    if !destination.is_dir() || unsafe_path(destination) {
        return false;
    }
    let artifact = destination.join("artifact.bin");
    let stored_manifest = destination.join("manifest.json");
    if unsafe_path(&artifact) || unsafe_path(&stored_manifest) {
        return false;
    }
    let mut names = Vec::new();
    let entries = match fs::read_dir(destination) {
        Ok(entries) => entries,
        Err(_) => return false,
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => return false,
        };
        if unsafe_path(&entry.path()) {
            return false;
        }
        names.push(entry.file_name());
    }
    names.sort();
    if names.as_slice()
        != [
            std::ffi::OsString::from("artifact.bin"),
            std::ffi::OsString::from("manifest.json"),
        ]
    {
        return false;
    }
    if hash_file(&artifact).ok().as_deref() != Some(artifact_id) {
        return false;
    }
    let metadata = match fs::metadata(&stored_manifest) {
        Ok(metadata) => metadata,
        Err(_) => return false,
    };
    if metadata.len() != manifest.len() as u64 {
        return false;
    }
    let mut file = match File::open(stored_manifest) {
        Ok(file) => file,
        Err(_) => return false,
    };
    let mut bytes = vec![0_u8; manifest.len()];
    file.read_exact(&mut bytes).is_ok() && bytes == manifest
}

fn hash_file(path: &Path) -> Result<String, CookError> {
    let mut file = File::open(path)?;
    let mut buffer = vec![0_u8; READ_CHUNK_BYTES];
    let mut hasher = Sha256::new();
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hasher.finalize_hex())
}

fn validate_root(path: &Path, code: &str) -> Result<(), CookError> {
    if unsafe_path(path) || !path.is_dir() {
        return Err(CookError::new(
            code,
            "configured asset root is missing, linked, or not a directory",
        ));
    }
    Ok(())
}

fn ensure_derived_root(path: &Path) -> Result<(), CookError> {
    if unsafe_path(path) {
        return Err(CookError::new(
            "unsafe_derived_root",
            "configured derived root is linked or reparse-pointed",
        ));
    }
    if !path.exists() {
        fs::create_dir_all(path).map_err(|_| {
            CookError::new("unsafe_derived_root", "derived root could not be created")
        })?;
    }
    validate_root(path, "unsafe_derived_root")
}

fn unsafe_path(path: &Path) -> bool {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            if metadata.file_type().is_symlink() || is_reparse(&metadata) {
                return true;
            }
        }
    }
    false
}

#[cfg(windows)]
fn is_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn parse_gltf_json(bytes: &[u8], config: &CookConfig) -> Result<Vec<u8>, CookError> {
    if bytes.len() as u64 > config.max_json_bytes {
        return Err(CookError::new(
            "json_too_large",
            "glTF JSON exceeds configured limit",
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| CookError::new("invalid_utf8", "glTF JSON is not valid UTF-8"))?;
    validate_json_syntax(text)?;
    let value: Value = serde_json::from_str(text)
        .map_err(|_| CookError::new("invalid_json", "glTF JSON is invalid"))?;
    validate_gltf_document(&value, None)?;
    canonical_json_bytes(&value)
}

fn read_bounded_file(
    path: &Path,
    limit: u64,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, CookError> {
    let mut file = File::open(path)?;
    let mut output = Vec::new();
    let mut buffer = vec![0_u8; READ_CHUNK_BYTES];
    let mut total = 0_u64;
    loop {
        if cancellation.is_cancelled() {
            return Err(CookError::cancelled());
        }
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| CookError::new("source_too_large", "source size overflow"))?;
        if total > limit {
            return Err(CookError::new(
                "source_too_large",
                "bounded source structure exceeds its limit",
            ));
        }
        output.extend_from_slice(&buffer[..count]);
    }
    Ok(output)
}

fn parse_gltf_file(
    staged: &StagedSource,
    config: &CookConfig,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, CookError> {
    let bytes = read_bounded_file(&staged.path, config.max_json_bytes, cancellation)?;
    parse_gltf_json(&bytes, config)
}

fn parse_glb_file(
    staged: &StagedSource,
    config: &CookConfig,
    cancellation: &CancellationToken,
) -> Result<ParsedGlb, CookError> {
    let mut file = File::open(&staged.path)?;
    let mut header = [0_u8; 12];
    file.read_exact(&mut header)
        .map_err(|_| CookError::new("invalid_glb", "GLB header is truncated"))?;
    if &header[..4] != b"glTF" || u32::from_le_bytes(header[4..8].try_into().unwrap()) != 2 {
        return Err(CookError::new(
            "invalid_glb",
            "GLB magic or version is unsupported",
        ));
    }
    if u32::from_le_bytes(header[8..12].try_into().unwrap()) as u64 != staged.size {
        return Err(CookError::new(
            "glb_length_mismatch",
            "GLB length does not match source bytes",
        ));
    }
    let mut offset = 12_u64;
    let mut json_chunk = None;
    let mut bin_chunk = None;
    while offset < staged.size {
        if cancellation.is_cancelled() {
            return Err(CookError::cancelled());
        }
        let mut chunk_header = [0_u8; 8];
        file.read_exact(&mut chunk_header)
            .map_err(|_| CookError::new("invalid_glb", "GLB chunk header is truncated"))?;
        let length = u32::from_le_bytes(chunk_header[..4].try_into().unwrap()) as u64;
        let kind = u32::from_le_bytes(chunk_header[4..].try_into().unwrap());
        if length % 4 != 0 || offset == 12 && kind != GLB_JSON_CHUNK {
            return Err(CookError::new(
                "invalid_glb",
                "GLB chunk alignment or ordering is invalid",
            ));
        }
        let end = offset
            .checked_add(8)
            .and_then(|value| value.checked_add(length))
            .ok_or_else(|| CookError::new("invalid_glb", "GLB chunk length overflows"))?;
        if end > staged.size {
            return Err(CookError::new(
                "invalid_glb",
                "GLB chunk exceeds declared length",
            ));
        }
        match kind {
            GLB_JSON_CHUNK if json_chunk.is_none() => {
                if length > config.max_json_bytes {
                    return Err(CookError::new(
                        "json_too_large",
                        "GLB JSON exceeds configured limit",
                    ));
                }
                let mut bytes = vec![0_u8; length as usize];
                file.read_exact(&mut bytes)?;
                json_chunk = Some(bytes);
            }
            GLB_BIN_CHUNK if bin_chunk.is_none() => {
                bin_chunk = Some((offset + 8, length));
                file.seek(SeekFrom::Current(length as i64))?;
            }
            GLB_JSON_CHUNK | GLB_BIN_CHUNK => {
                return Err(CookError::new(
                    "invalid_glb",
                    "GLB contains duplicate JSON or BIN chunks",
                ));
            }
            _ => {
                return Err(CookError::new(
                    "unknown_glb_chunk",
                    "GLB contains an unknown chunk type",
                ));
            }
        }
        offset = end;
    }
    let json_chunk =
        json_chunk.ok_or_else(|| CookError::new("invalid_glb", "GLB has no JSON chunk"))?;
    let text = std::str::from_utf8(&json_chunk)
        .map_err(|_| CookError::new("invalid_utf8", "GLB JSON is not valid UTF-8"))?;
    validate_json_syntax(text)?;
    let value: Value = serde_json::from_str(text)
        .map_err(|_| CookError::new("invalid_json", "GLB JSON is invalid"))?;
    validate_gltf_document(&value, bin_chunk.map(|(_, length)| length))?;
    Ok(ParsedGlb {
        json: canonical_json_bytes(&value)?,
        bin: bin_chunk,
    })
}

fn write_artifact_file(
    path: &Path,
    format: &str,
    canonical_json: &[u8],
    binary: Option<(u64, u64)>,
    source: &Path,
    cancellation: &CancellationToken,
) -> Result<(String, u64), CookError> {
    let mut output = File::create(path)?;
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    let mut write_hashed = |bytes: &[u8]| -> Result<(), CookError> {
        output.write_all(bytes)?;
        hasher.update(bytes);
        size += bytes.len() as u64;
        Ok(())
    };
    write_hashed(ARTIFACT_MAGIC)?;
    write_hashed(format.as_bytes())?;
    write_hashed(b"\n")?;
    write_hashed(&(canonical_json.len() as u64).to_le_bytes())?;
    write_hashed(canonical_json)?;
    let binary_len = binary.map(|(_, length)| length).unwrap_or(0);
    write_hashed(&binary_len.to_le_bytes())?;
    if let Some((offset, length)) = binary {
        let mut input = File::open(source)?;
        input.seek(SeekFrom::Start(offset))?;
        let mut remaining = length;
        let mut buffer = vec![0_u8; READ_CHUNK_BYTES];
        while remaining > 0 {
            if cancellation.is_cancelled() {
                return Err(CookError::cancelled());
            }
            let want = remaining.min(buffer.len() as u64) as usize;
            let count = input.read(&mut buffer[..want])?;
            if count == 0 {
                return Err(CookError::new("invalid_glb", "GLB BIN chunk ended early"));
            }
            write_hashed(&buffer[..count])?;
            remaining -= count as u64;
        }
    }
    output.flush()?;
    output.sync_all()?;
    Ok((hasher.finalize_hex(), size))
}

fn validate_gltf_document(value: &Value, embedded_bin_len: Option<u64>) -> Result<(), CookError> {
    let object = value
        .as_object()
        .ok_or_else(|| CookError::new("invalid_gltf", "glTF root must be an object"))?;
    let asset = object
        .get("asset")
        .and_then(Value::as_object)
        .ok_or_else(|| CookError::new("invalid_gltf", "glTF asset object is required"))?;
    if asset.get("version").and_then(Value::as_str) != Some("2.0") {
        return Err(CookError::new(
            "unsupported_gltf_version",
            "only glTF 2.0 is supported",
        ));
    }
    validate_gltf_uris(value)?;
    validate_gltf_structure(object, embedded_bin_len)
}

fn validate_gltf_structure(
    root: &Map<String, Value>,
    embedded_bin_len: Option<u64>,
) -> Result<(), CookError> {
    for key in [
        "buffers",
        "bufferViews",
        "accessors",
        "images",
        "textures",
        "samplers",
        "meshes",
        "nodes",
        "scenes",
        "skins",
        "animations",
        "cameras",
        "materials",
    ] {
        require_array_if_present(root, key)?;
    }
    let buffers = array_field(root, "buffers");
    let mut buffer_lengths = Vec::with_capacity(buffers.len());
    for buffer in &buffers {
        let object = object_value(buffer, "buffer")?;
        let length = integer_field(object, "byteLength", "gltf_buffer_length")?;
        if object.get("uri").is_none() {
            if let Some(bin_len) = embedded_bin_len {
                if length > bin_len {
                    return Err(CookError::new(
                        "gltf_buffer_bounds",
                        "GLB BIN data is shorter than its embedded buffer",
                    ));
                }
            } else if length != 0 {
                return Err(CookError::new(
                    "gltf_embedded_buffer",
                    "JSON glTF buffers require auvra-asset URIs unless empty",
                ));
            }
        }
        buffer_lengths.push(length);
    }
    let views = array_field(root, "bufferViews");
    let mut view_ranges = Vec::with_capacity(views.len());
    for view in &views {
        let object = object_value(view, "bufferView")?;
        let buffer = index_field(
            object,
            "buffer",
            buffer_lengths.len(),
            "gltf_buffer_reference",
        )?;
        let offset = optional_integer_field(object, "byteOffset")?.unwrap_or(0);
        let length = integer_field(object, "byteLength", "gltf_view_length")?;
        if offset
            .checked_add(length)
            .is_none_or(|end| end > buffer_lengths[buffer])
        {
            return Err(CookError::new(
                "gltf_buffer_bounds",
                "glTF bufferView exceeds its buffer",
            ));
        }
        if let Some(stride) = optional_integer_field(object, "byteStride")? {
            if !(4..=252).contains(&stride) || stride % 4 != 0 {
                return Err(CookError::new(
                    "gltf_stride_invalid",
                    "glTF byteStride is outside its valid range",
                ));
            }
        }
        view_ranges.push((
            buffer,
            offset,
            length,
            optional_integer_field(object, "byteStride")?,
        ));
    }
    let accessors = array_field(root, "accessors");
    for accessor in &accessors {
        let object = object_value(accessor, "accessor")?;
        let count = integer_field(object, "count", "gltf_accessor_count")?;
        let component_size = match integer_field(object, "componentType", "gltf_component_type")? {
            5120 | 5121 => 1,
            5122 | 5123 => 2,
            5125 | 5126 => 4,
            _ => {
                return Err(CookError::new(
                    "gltf_component_type",
                    "glTF accessor component type is unsupported",
                ));
            }
        };
        let components = match object.get("type").and_then(Value::as_str) {
            Some("SCALAR") => 1_u64,
            Some("VEC2") => 2,
            Some("VEC3") => 3,
            Some("VEC4") => 4,
            Some("MAT2") => 4,
            Some("MAT3") => 9,
            Some("MAT4") => 16,
            _ => {
                return Err(CookError::new(
                    "gltf_accessor_type",
                    "glTF accessor type is invalid",
                ));
            }
        };
        let element = (component_size as u64)
            .checked_mul(components)
            .ok_or_else(|| {
                CookError::new("gltf_accessor_bounds", "glTF accessor size overflows")
            })?;
        if let Some(view) = object.get("bufferView") {
            let view_index = index_value(view, view_ranges.len(), "gltf_view_reference")?;
            let (buffer, offset, length, stride) = view_ranges[view_index];
            let stride = stride.unwrap_or(element);
            if stride < element {
                return Err(CookError::new(
                    "gltf_stride_invalid",
                    "glTF accessor stride is smaller than its element",
                ));
            }
            let accessor_offset = optional_integer_field(object, "byteOffset")?.unwrap_or(0);
            if accessor_offset > length {
                return Err(CookError::new(
                    "gltf_accessor_bounds",
                    "glTF accessor offset exceeds its bufferView",
                ));
            }
            let needed = if count == 0 {
                0
            } else {
                accessor_offset
                    .checked_add(
                        stride
                            .checked_mul(count.saturating_sub(1))
                            .and_then(|value| value.checked_add(element))
                            .ok_or_else(|| {
                                CookError::new(
                                    "gltf_accessor_bounds",
                                    "glTF accessor range overflows",
                                )
                            })?,
                    )
                    .ok_or_else(|| {
                        CookError::new("gltf_accessor_bounds", "glTF accessor range overflows")
                    })?
            };
            if needed > length
                || buffer >= buffer_lengths.len()
                || offset
                    .checked_add(needed)
                    .is_none_or(|end| end > buffer_lengths[buffer])
            {
                return Err(CookError::new(
                    "gltf_accessor_bounds",
                    "glTF accessor exceeds its bufferView",
                ));
            }
        } else if count != 0 {
            return Err(CookError::new(
                "gltf_accessor_reference",
                "non-empty glTF accessor has no bufferView",
            ));
        }
    }
    for image in array_field(root, "images") {
        let object = object_value(image, "image")?;
        if let Some(view) = object.get("bufferView") {
            index_value(view, views.len(), "gltf_view_reference")?;
        }
    }
    for texture in array_field(root, "textures") {
        let object = object_value(texture, "texture")?;
        if let Some(source) = object.get("source") {
            index_value(
                source,
                array_field(root, "images").len(),
                "gltf_image_reference",
            )?;
        }
        if let Some(sampler) = object.get("sampler") {
            index_value(
                sampler,
                array_field(root, "samplers").len(),
                "gltf_sampler_reference",
            )?;
        }
    }
    for mesh in array_field(root, "meshes") {
        let object = object_value(mesh, "mesh")?;
        require_array_if_present(object, "primitives")?;
        for primitive in array_field(object, "primitives") {
            let primitive = object_value(primitive, "primitive")?;
            require_array_if_present(primitive, "targets")?;
            if let Some(indices) = primitive.get("indices") {
                index_value(indices, accessors.len(), "gltf_accessor_reference")?;
            }
            if let Some(material) = primitive.get("material") {
                index_value(
                    material,
                    array_field(root, "materials").len(),
                    "gltf_material_reference",
                )?;
            }
            if let Some(attributes) = primitive.get("attributes") {
                for accessor in attributes
                    .as_object()
                    .ok_or_else(|| {
                        CookError::new(
                            "gltf_accessor_reference",
                            "glTF primitive attributes are invalid",
                        )
                    })?
                    .values()
                {
                    index_value(accessor, accessors.len(), "gltf_accessor_reference")?;
                }
            }
            for target in array_field(primitive, "targets") {
                for accessor in object_value(target, "morph target")?.values() {
                    index_value(accessor, accessors.len(), "gltf_accessor_reference")?;
                }
            }
        }
    }
    let nodes = array_field(root, "nodes");
    for node in &nodes {
        let object = object_value(node, "node")?;
        require_array_if_present(object, "children")?;
        for key in ["mesh", "skin", "camera"] {
            if let Some(index) = object.get(key) {
                let limit = if key == "mesh" {
                    array_field(root, "meshes").len()
                } else if key == "skin" {
                    array_field(root, "skins").len()
                } else {
                    array_field(root, "cameras").len()
                };
                index_value(index, limit, "gltf_node_reference")?;
            }
        }
        for child in array_field(object, "children") {
            index_value(child, nodes.len(), "gltf_node_reference")?;
        }
    }
    for scene in array_field(root, "scenes") {
        let object = object_value(scene, "scene")?;
        require_array_if_present(object, "nodes")?;
        for node in array_field(object, "nodes") {
            index_value(node, nodes.len(), "gltf_node_reference")?;
        }
    }
    if let Some(scene) = root.get("scene") {
        index_value(
            scene,
            array_field(root, "scenes").len(),
            "gltf_scene_reference",
        )?;
    }
    for skin in array_field(root, "skins") {
        let object = object_value(skin, "skin")?;
        require_array_if_present(object, "joints")?;
        if let Some(accessor) = object.get("inverseBindMatrices") {
            index_value(accessor, accessors.len(), "gltf_accessor_reference")?;
        }
        for joint in array_field(object, "joints") {
            index_value(joint, nodes.len(), "gltf_node_reference")?;
        }
        if let Some(skeleton) = object.get("skeleton") {
            index_value(skeleton, nodes.len(), "gltf_node_reference")?;
        }
    }
    for animation in array_field(root, "animations") {
        let object = object_value(animation, "animation")?;
        require_array_if_present(object, "samplers")?;
        require_array_if_present(object, "channels")?;
        let samplers = array_field(object, "samplers");
        for sampler in &samplers {
            let sampler = object_value(sampler, "animation sampler")?;
            index_value(
                sampler.get("input").ok_or_else(|| {
                    CookError::new(
                        "gltf_accessor_reference",
                        "animation sampler input is missing",
                    )
                })?,
                accessors.len(),
                "gltf_accessor_reference",
            )?;
            index_value(
                sampler.get("output").ok_or_else(|| {
                    CookError::new(
                        "gltf_accessor_reference",
                        "animation sampler output is missing",
                    )
                })?,
                accessors.len(),
                "gltf_accessor_reference",
            )?;
        }
        for channel in array_field(object, "channels") {
            let channel = object_value(channel, "animation channel")?;
            index_value(
                channel.get("sampler").ok_or_else(|| {
                    CookError::new(
                        "gltf_accessor_reference",
                        "animation channel sampler is missing",
                    )
                })?,
                samplers.len(),
                "gltf_accessor_reference",
            )?;
            if let Some(target) = channel.get("target") {
                if let Some(node) = object_value(target, "animation target")?.get("node") {
                    index_value(node, nodes.len(), "gltf_node_reference")?;
                }
            }
        }
    }
    Ok(())
}

fn array_field<'a>(object: &'a Map<String, Value>, key: &str) -> Vec<&'a Value> {
    object
        .get(key)
        .and_then(Value::as_array)
        .map(|values| values.iter().collect())
        .unwrap_or_default()
}
fn require_array_if_present(object: &Map<String, Value>, key: &str) -> Result<(), CookError> {
    if object.get(key).is_some_and(|value| !value.is_array()) {
        return Err(CookError::new(
            "gltf_structure",
            format!("glTF {key} must be an array"),
        ));
    }
    Ok(())
}
fn object_value<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, CookError> {
    value
        .as_object()
        .ok_or_else(|| CookError::new("gltf_structure", format!("glTF {label} must be an object")))
}
fn integer_field(object: &Map<String, Value>, key: &str, code: &str) -> Result<u64, CookError> {
    object
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| CookError::new(code, format!("glTF {key} must be a non-negative integer")))
}
fn optional_integer_field(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<u64>, CookError> {
    object
        .get(key)
        .map(|value| {
            value.as_u64().ok_or_else(|| {
                CookError::new(
                    "gltf_structure",
                    format!("glTF {key} must be a non-negative integer"),
                )
            })
        })
        .transpose()
}
fn index_field(
    object: &Map<String, Value>,
    key: &str,
    length: usize,
    code: &str,
) -> Result<usize, CookError> {
    index_value(
        object
            .get(key)
            .ok_or_else(|| CookError::new(code, format!("glTF {key} reference is missing")))?,
        length,
        code,
    )
}
fn index_value(value: &Value, length: usize, code: &str) -> Result<usize, CookError> {
    let index = value
        .as_u64()
        .ok_or_else(|| CookError::new(code, "glTF reference index is not an integer"))?;
    let index = usize::try_from(index)
        .map_err(|_| CookError::new(code, "glTF reference index overflows"))?;
    if index >= length {
        return Err(CookError::new(
            code,
            "glTF reference index is out of bounds",
        ));
    }
    Ok(index)
}

fn validate_gltf_uris(value: &Value) -> Result<(), CookError> {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if key == "uri" {
                    let uri = child.as_str().ok_or_else(|| {
                        CookError::new("invalid_uri", "glTF URI must be a string")
                    })?;
                    if !uri.starts_with("auvra-asset:") {
                        return Err(CookError::new(
                            "external_uri",
                            "only absent URI or auvra-asset IDs are allowed",
                        ));
                    }
                    validate_source_id(uri.strip_prefix("auvra-asset:").unwrap_or_default())?;
                }
                validate_gltf_uris(child)?;
            }
        }
        Value::Array(array) => {
            for child in array {
                validate_gltf_uris(child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn parse_fbx(
    bytes: &[u8],
    config: &CookConfig,
) -> Result<(Vec<u8>, Vec<CookDiagnostic>), CookError> {
    if bytes.len() as u64 > config.max_fbx_bytes {
        return Err(CookError::new(
            "fbx_too_large",
            "FBX source exceeds configured limit",
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| CookError::new("unsupported_fbx", "binary or non-UTF-8 FBX is unsupported"))?;
    if !text.starts_with("; FBX 7.") {
        return Err(CookError::new(
            "unsupported_fbx",
            "only ASCII FBX 7.x is supported",
        ));
    }
    for line in text.lines().skip(1) {
        let line = line.trim();
        if line.is_empty()
            || line.starts_with(';')
            || line == "{"
            || line == "}"
            || line.starts_with("Vertices: *")
            || line.starts_with("PolygonVertexIndex: *")
            || line.starts_with("a:")
        {
            continue;
        }
        return Err(CookError::new(
            "unsupported_fbx",
            "FBX contains a construct outside the supported subset",
        ));
    }
    let vertices = parse_fbx_float_array(text, "Vertices")?;
    let polygon_indices = parse_fbx_integer_array(text, "PolygonVertexIndex")?;
    if vertices.len() % 3 != 0 || vertices.len() / 3 > config.max_vertices {
        return Err(CookError::new(
            "fbx_vertex_limit",
            "FBX vertex count is invalid or exceeds its limit",
        ));
    }
    if polygon_indices.len() > config.max_polygon_indices {
        return Err(CookError::new(
            "fbx_index_limit",
            "FBX polygon index count exceeds its limit",
        ));
    }
    let mut decoded = Vec::with_capacity(polygon_indices.len());
    for index in polygon_indices {
        let value = if index < 0 {
            index
                .checked_neg()
                .and_then(|value| value.checked_sub(1))
                .ok_or_else(|| CookError::new("fbx_index_invalid", "FBX polygon index overflows"))?
        } else {
            index
        };
        if value < 0 || value as usize >= vertices.len() / 3 {
            return Err(CookError::new(
                "fbx_index_invalid",
                "FBX polygon index is outside Vertices",
            ));
        }
        decoded.push(value);
    }
    let vertex_values: Vec<Value> = vertices.into_iter().map(|value| json!(value)).collect();
    let index_values: Vec<Value> = decoded.into_iter().map(|value| json!(value)).collect();
    let document = json!({"format":"fbx-ascii-7x-subset", "vertices":vertex_values, "polygonVertexIndex":index_values});
    Ok((
        canonical_json_bytes(&document)?,
        vec![CookDiagnostic::warning(
            "fbx_subset",
            "cooked using the bounded ASCII FBX 7.x Vertices/PolygonVertexIndex subset",
        )],
    ))
}

fn fbx_array_body<'a>(text: &'a str, name: &str) -> Result<(usize, &'a str), CookError> {
    let marker = format!("{name}: *");
    if text.matches(marker.as_str()).count() != 1 {
        return Err(CookError::new(
            "fbx_subset",
            "FBX subset arrays must occur exactly once",
        ));
    }
    let start = text
        .find(&marker)
        .ok_or_else(|| CookError::new("fbx_subset", "required FBX array is missing"))?;
    let count_start = start + marker.len();
    let count_end = text[count_start..]
        .find(|character: char| !character.is_ascii_digit())
        .map(|value| count_start + value)
        .unwrap_or(text.len());
    let declared_count = text[count_start..count_end]
        .parse::<usize>()
        .map_err(|_| CookError::new("fbx_count_invalid", "FBX array count is invalid"))?;
    let body_start = text[start..]
        .find("a:")
        .map(|value| start + value + 2)
        .ok_or_else(|| CookError::new("fbx_subset", "FBX array payload is missing"))?;
    let body_end = text[body_start..]
        .find(';')
        .map(|value| body_start + value)
        .ok_or_else(|| CookError::new("fbx_subset", "FBX array terminator is missing"))?;
    let body = &text[body_start..body_end];
    Ok((declared_count, body))
}

fn parse_fbx_float_array(text: &str, name: &str) -> Result<Vec<f64>, CookError> {
    let (declared_count, body) = fbx_array_body(text, name)?;
    let mut values = Vec::new();
    for token in body
        .split(',')
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        let value = token.parse::<f64>().map_err(|_| {
            CookError::new(
                "fbx_number_invalid",
                "FBX vertex values must be finite numbers",
            )
        })?;
        if !value.is_finite() {
            return Err(CookError::new(
                "fbx_number_invalid",
                "FBX vertex values must be finite numbers",
            ));
        }
        values.push(value);
    }
    if values.is_empty() {
        return Err(CookError::new("fbx_subset", "FBX array is empty"));
    }
    if values.len() != declared_count {
        return Err(CookError::new(
            "fbx_count_mismatch",
            "FBX array count does not match its values",
        ));
    }
    Ok(values)
}

fn parse_fbx_integer_array(text: &str, name: &str) -> Result<Vec<i64>, CookError> {
    let (declared_count, body) = fbx_array_body(text, name)?;
    let mut values = Vec::new();
    for token in body
        .split(',')
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        values.push(token.parse::<i64>().map_err(|_| {
            CookError::new("fbx_number_invalid", "FBX polygon indices must be integers")
        })?);
    }
    if values.is_empty() {
        return Err(CookError::new("fbx_subset", "FBX array is empty"));
    }
    if values.len() != declared_count {
        return Err(CookError::new(
            "fbx_count_mismatch",
            "FBX array count does not match its values",
        ));
    }
    Ok(values)
}

fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, CookError> {
    serde_json::to_vec(&canonicalize(value)).map_err(|_| {
        CookError::new(
            "canonical_json_error",
            "canonical JSON serialization failed",
        )
    })
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let sorted: BTreeMap<_, _> = object
                .iter()
                .map(|(key, value)| (key.clone(), canonicalize(value)))
                .collect();
            let mut output = Map::new();
            for (key, value) in sorted {
                output.insert(key, value);
            }
            Value::Object(output)
        }
        Value::Array(array) => Value::Array(array.iter().map(canonicalize).collect()),
        _ => value.clone(),
    }
}

fn validate_json_syntax(text: &str) -> Result<(), CookError> {
    let mut parser = JsonScanner {
        bytes: text.as_bytes(),
        position: 0,
    };
    parser.value()?;
    parser.whitespace();
    if parser.position != parser.bytes.len() {
        return Err(CookError::new("invalid_json", "JSON has trailing content"));
    }
    Ok(())
}

struct JsonScanner<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> JsonScanner<'a> {
    fn whitespace(&mut self) {
        while self
            .bytes
            .get(self.position)
            .is_some_and(|byte| byte.is_ascii_whitespace())
        {
            self.position += 1;
        }
    }
    fn value(&mut self) -> Result<(), CookError> {
        self.whitespace();
        match self.bytes.get(self.position).copied() {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => {
                self.string()?;
                Ok(())
            }
            Some(b't') => self.literal(b"true"),
            Some(b'f') => self.literal(b"false"),
            Some(b'n') => self.literal(b"null"),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(CookError::new("invalid_json", "JSON value is invalid")),
        }
    }
    fn object(&mut self) -> Result<(), CookError> {
        self.position += 1;
        self.whitespace();
        let mut keys = std::collections::HashSet::new();
        if self.take(b'}') {
            return Ok(());
        }
        loop {
            self.whitespace();
            let key = self.string_value()?;
            if !keys.insert(key) {
                return Err(CookError::new(
                    "duplicate_json_key",
                    "JSON contains a duplicate object key",
                ));
            }
            self.whitespace();
            if !self.take(b':') {
                return Err(CookError::new("invalid_json", "JSON object is missing ':'"));
            }
            self.value()?;
            self.whitespace();
            if self.take(b'}') {
                return Ok(());
            }
            if !self.take(b',') {
                return Err(CookError::new("invalid_json", "JSON object is missing ','"));
            }
        }
    }
    fn array(&mut self) -> Result<(), CookError> {
        self.position += 1;
        self.whitespace();
        if self.take(b']') {
            return Ok(());
        }
        loop {
            self.value()?;
            self.whitespace();
            if self.take(b']') {
                return Ok(());
            }
            if !self.take(b',') {
                return Err(CookError::new("invalid_json", "JSON array is missing ','"));
            }
        }
    }
    fn string(&mut self) -> Result<(), CookError> {
        if !self.take(b'"') {
            return Err(CookError::new("invalid_json", "JSON string is invalid"));
        }
        while let Some(byte) = self.bytes.get(self.position).copied() {
            self.position += 1;
            match byte {
                b'"' => return Ok(()),
                b'\\' => {
                    if self.bytes.get(self.position).is_none() {
                        return Err(CookError::new("invalid_json", "JSON escape is truncated"));
                    }
                    self.position += 1;
                }
                0..=0x1f => {
                    return Err(CookError::new(
                        "invalid_json",
                        "JSON string contains a control character",
                    ));
                }
                _ => {}
            }
        }
        Err(CookError::new(
            "invalid_json",
            "JSON string is unterminated",
        ))
    }
    fn string_value(&mut self) -> Result<String, CookError> {
        let start = self.position;
        self.string()?;
        serde_json::from_slice(&self.bytes[start..self.position])
            .map_err(|_| CookError::new("invalid_json", "JSON string escape is invalid"))
    }
    fn number(&mut self) -> Result<(), CookError> {
        let start = self.position;
        while self
            .bytes
            .get(self.position)
            .is_some_and(|byte| !byte.is_ascii_whitespace() && !matches!(byte, b',' | b']' | b'}'))
        {
            self.position += 1;
        }
        serde_json::from_slice::<Value>(&self.bytes[start..self.position])
            .map(|_| ())
            .map_err(|_| CookError::new("invalid_json", "JSON number is invalid"))
    }
    fn literal(&mut self, expected: &[u8]) -> Result<(), CookError> {
        if self
            .bytes
            .get(self.position..self.position + expected.len())
            == Some(expected)
        {
            self.position += expected.len();
            Ok(())
        } else {
            Err(CookError::new("invalid_json", "JSON literal is invalid"))
        }
    }
    fn take(&mut self, expected: u8) -> bool {
        if self.bytes.get(self.position) == Some(&expected) {
            self.position += 1;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize_hex()
}

#[derive(Clone)]
struct Sha256 {
    state: [u32; 8],
    buffer: [u8; 64],
    buffer_len: usize,
    bit_len: u64,
}

impl Sha256 {
    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buffer: [0; 64],
            buffer_len: 0,
            bit_len: 0,
        }
    }
    fn update(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.buffer[self.buffer_len] = *byte;
            self.buffer_len += 1;
            self.bit_len = self.bit_len.wrapping_add(8);
            if self.buffer_len == 64 {
                let block = self.buffer;
                self.compress(&block);
                self.buffer_len = 0;
            }
        }
    }
    fn finalize_hex(mut self) -> String {
        self.buffer[self.buffer_len] = 0x80;
        self.buffer_len += 1;
        if self.buffer_len > 56 {
            self.buffer[self.buffer_len..].fill(0);
            let block = self.buffer;
            self.compress(&block);
            self.buffer_len = 0;
        }
        self.buffer[self.buffer_len..56].fill(0);
        self.buffer[56..].copy_from_slice(&self.bit_len.to_be_bytes());
        let block = self.buffer;
        self.compress(&block);
        let mut output = String::with_capacity(64);
        for word in self.state {
            output.push_str(&format!("{word:08x}"));
        }
        output
    }
    fn compress(&mut self, block: &[u8; 64]) {
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
            0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
            0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
            0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
            0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
            0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
            0xc67178f2,
        ];
        let mut schedule = [0_u32; 64];
        for (index, word) in schedule[..16].iter_mut().enumerate() {
            let start = index * 4;
            *word = u32::from_be_bytes(block[start..start + 4].try_into().unwrap());
        }
        for index in 16..64 {
            let s0 = schedule[index - 15].rotate_right(7)
                ^ schedule[index - 15].rotate_right(18)
                ^ (schedule[index - 15] >> 3);
            let s1 = schedule[index - 2].rotate_right(17)
                ^ schedule[index - 2].rotate_right(19)
                ^ (schedule[index - 2] >> 10);
            schedule[index] = schedule[index - 16]
                .wrapping_add(s0)
                .wrapping_add(schedule[index - 7])
                .wrapping_add(s1);
        }
        let mut working = self.state;
        for index in 0..64 {
            let s1 = working[4].rotate_right(6)
                ^ working[4].rotate_right(11)
                ^ working[4].rotate_right(25);
            let choice = (working[4] & working[5]) ^ ((!working[4]) & working[6]);
            let temp1 = working[7]
                .wrapping_add(s1)
                .wrapping_add(choice)
                .wrapping_add(K[index])
                .wrapping_add(schedule[index]);
            let s0 = working[0].rotate_right(2)
                ^ working[0].rotate_right(13)
                ^ working[0].rotate_right(22);
            let majority =
                (working[0] & working[1]) ^ (working[0] & working[2]) ^ (working[1] & working[2]);
            let temp2 = s0.wrapping_add(majority);
            working = [
                temp1.wrapping_add(temp2),
                working[0],
                working[1],
                working[2],
                working[3].wrapping_add(temp1),
                working[4],
                working[5],
                working[6],
            ];
        }
        for index in 0..8 {
            self.state[index] = self.state[index].wrapping_add(working[index]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "auvra-assets-{label}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    fn write_source(root: &Path, bytes: &[u8]) -> String {
        fs::create_dir_all(root).unwrap();
        let id = sha256_hex(bytes);
        fs::write(root.join(&id), bytes).unwrap();
        id
    }
    fn gltf() -> Vec<u8> {
        br#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":0}]}"#.to_vec()
    }

    #[test]
    fn sha256_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn gltf_cook_is_byte_identical_and_pathless() {
        let root = temp_root("gltf");
        let derived = temp_root("derived");
        let source_bytes = gltf();
        let id = write_source(&root, &source_bytes);
        let config = CookConfig::new(&root, &derived);
        let first = cook_source(&config, &id, &CancellationToken::new()).unwrap();
        let second = cook_source(&config, &id, &CancellationToken::new()).unwrap();
        assert_eq!(first.artifact_sha256, second.artifact_sha256);
        assert_eq!(first.manifest.artifact_sha256, first.artifact_sha256);
        assert!(
            serde_json::to_string(&first)
                .unwrap()
                .find(root.to_string_lossy().as_ref())
                .is_none()
        );
        assert!(derived.join(&first.artifact_sha256).is_dir());
        assert!(
            derived
                .join(&first.artifact_sha256)
                .join("artifact.bin")
                .is_file()
        );
        assert!(
            derived
                .join(&first.artifact_sha256)
                .join("manifest.json")
                .is_file()
        );
        fs::write(
            derived.join(&first.artifact_sha256).join("artifact.bin"),
            b"corrupt",
        )
        .unwrap();
        assert_eq!(
            cook_source(&config, &id, &CancellationToken::new())
                .unwrap_err()
                .code,
            "publication_conflict"
        );
        assert_eq!(fs::read(root.join(&id)).unwrap(), source_bytes);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(derived);
    }

    #[test]
    fn glb_validates_chunks_and_length() {
        let mut json = br#"{"asset":{"version":"2.0"}}"#.to_vec();
        while json.len() % 4 != 0 {
            json.push(b' ');
        }
        let mut glb = Vec::new();
        glb.extend_from_slice(b"glTF");
        glb.extend_from_slice(&2_u32.to_le_bytes());
        glb.extend_from_slice(&((12 + 8 + json.len()) as u32).to_le_bytes());
        glb.extend_from_slice(&(json.len() as u32).to_le_bytes());
        glb.extend_from_slice(&GLB_JSON_CHUNK.to_le_bytes());
        glb.extend_from_slice(&json);
        let root = temp_root("glb");
        let derived = temp_root("glb-derived");
        let id = write_source(&root, &glb);
        let result = cook_source(
            &CookConfig::new(&root, &derived),
            &id,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(result.source_format, "glb");
        glb[8] = glb[8].wrapping_add(1);
        let bad_id = write_source(&root, &glb);
        assert_eq!(
            cook_source(
                &CookConfig::new(&root, &derived),
                &bad_id,
                &CancellationToken::new()
            )
            .unwrap_err()
            .code,
            "glb_length_mismatch"
        );
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(derived);
    }

    #[test]
    fn fbx_subset_and_rejections() {
        let source = b"; FBX 7.4.0 project file\nVertices: *6 {\n  a: 0,0,0, 1,0,0;\n}\nPolygonVertexIndex: *3 {\n  a: 0,1,-2;\n}\n";
        let root = temp_root("fbx");
        let derived = temp_root("fbx-derived");
        let id = write_source(&root, source);
        let result = cook_source(
            &CookConfig::new(&root, &derived),
            &id,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(result.source_format, "fbx-ascii-7x-subset");
        assert_eq!(result.manifest.warnings.len(), 1);
        let binary_id = write_source(&root, b"Kaydara FBX Binary  ");
        assert_eq!(
            cook_source(
                &CookConfig::new(&root, &derived),
                &binary_id,
                &CancellationToken::new()
            )
            .unwrap_err()
            .code,
            "unsupported_source_format"
        );
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(derived);
    }

    #[test]
    fn uri_duplicate_nonfinite_oversize_hash_and_cancel_fail_closed() {
        let root = temp_root("bad");
        let derived = temp_root("bad-derived");
        let config = CookConfig::new(&root, &derived).with_limits(8, 1024, 1024);
        let cancel = CancellationToken::new();
        cancel.cancel();
        let bytes = gltf();
        let id = write_source(&root, &bytes);
        assert_eq!(
            cook_source(&config, &id, &cancel).unwrap_err().code,
            "cancelled"
        );
        let external =
            br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"http://example.invalid/a"}]}"#;
        let external_id = write_source(&root, external);
        assert_eq!(
            cook_source(
                &CookConfig::new(&root, &derived),
                &external_id,
                &CancellationToken::new()
            )
            .unwrap_err()
            .code,
            "external_uri"
        );
        let duplicate = br#"{"asset":{"version":"2.0"},"asset":{"version":"2.0"}}"#;
        let duplicate_id = write_source(&root, duplicate);
        assert_eq!(
            cook_source(
                &CookConfig::new(&root, &derived),
                &duplicate_id,
                &CancellationToken::new()
            )
            .unwrap_err()
            .code,
            "duplicate_json_key"
        );
        let nonfinite = br#"{"asset":{"version":"2.0"},"extras":{"value":1e999}}"#;
        let nonfinite_id = write_source(&root, nonfinite);
        assert_eq!(
            cook_source(
                &CookConfig::new(&root, &derived),
                &nonfinite_id,
                &CancellationToken::new()
            )
            .unwrap_err()
            .code,
            "invalid_json"
        );
        let oversized = write_source(&root, &vec![b'x'; 9]);
        assert_eq!(
            cook_source(&config, &oversized, &CancellationToken::new())
                .unwrap_err()
                .code,
            "source_too_large"
        );
        let mismatched_id = "0000000000000000000000000000000000000000000000000000000000000000";
        fs::write(root.join(mismatched_id), gltf()).unwrap();
        assert_eq!(
            cook_source(
                &CookConfig::new(&root, &derived),
                mismatched_id,
                &CancellationToken::new()
            )
            .unwrap_err()
            .code,
            "source_hash_mismatch"
        );
        assert_eq!(
            cook_source(
                &config,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA",
                &CancellationToken::new()
            )
            .unwrap_err()
            .code,
            "invalid_source_id"
        );
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(derived);
    }

    #[test]
    fn worker_publishes_and_reports_status() {
        let root = temp_root("worker");
        let derived = temp_root("worker-derived");
        let id = write_source(&root, &gltf());
        let worker =
            CookWorker::new(CookConfig::new(&root, &derived).with_queue_capacity(1)).unwrap();
        let submission = worker.submit(&id).unwrap();
        let mut completed = false;
        for _ in 0..100 {
            if let Some(status) = worker.status(submission.job_id) {
                if matches!(status.state, JobState::Completed) {
                    assert!(status.result.is_some());
                    completed = true;
                    break;
                }
                if matches!(status.state, JobState::Failed | JobState::Cancelled) {
                    panic!("worker failed: {status:?}");
                }
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(completed, "worker did not complete");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(derived);
    }

    #[test]
    fn glb_streams_large_bin_and_publishes_one_directory_unit() {
        let mut json = br#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":2097152}],"bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":2097152}]}"#.to_vec();
        while json.len() % 4 != 0 {
            json.push(b' ');
        }
        let bin = vec![0x5a_u8; 2 * 1024 * 1024];
        let total = 12 + 8 + json.len() + 8 + bin.len();
        let mut glb = Vec::with_capacity(total);
        glb.extend_from_slice(b"glTF");
        glb.extend_from_slice(&2_u32.to_le_bytes());
        glb.extend_from_slice(&(total as u32).to_le_bytes());
        glb.extend_from_slice(&(json.len() as u32).to_le_bytes());
        glb.extend_from_slice(&GLB_JSON_CHUNK.to_le_bytes());
        glb.extend_from_slice(&json);
        glb.extend_from_slice(&(bin.len() as u32).to_le_bytes());
        glb.extend_from_slice(&GLB_BIN_CHUNK.to_le_bytes());
        glb.extend_from_slice(&bin);
        let root = temp_root("streaming");
        let derived = temp_root("streaming-derived");
        let id = write_source(&root, &glb);
        let result = cook_source(
            &CookConfig::new(&root, &derived),
            &id,
            &CancellationToken::new(),
        )
        .unwrap();
        let publication = derived.join(&result.artifact_sha256);
        assert!(publication.join("artifact.bin").is_file());
        assert!(publication.join("manifest.json").is_file());
        assert_eq!(fs::read_dir(&publication).unwrap().count(), 2);
        assert_eq!(
            hash_file(&publication.join("artifact.bin")).unwrap(),
            result.artifact_sha256
        );
        assert!(
            !derived
                .join(format!(".cook-txn-{}", std::process::id()))
                .exists()
        );
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(derived);
    }

    #[test]
    fn gltf_structural_references_and_uri_fail_closed() {
        let root = temp_root("structure");
        let derived = temp_root("structure-derived");
        let bad_view = br#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":1,"uri":"auvra-asset:0000000000000000000000000000000000000000000000000000000000000000"}],"bufferViews":[{"buffer":2,"byteLength":1}]}"#;
        let id = write_source(&root, bad_view);
        assert_eq!(
            cook_source(
                &CookConfig::new(&root, &derived),
                &id,
                &CancellationToken::new()
            )
            .unwrap_err()
            .code,
            "gltf_buffer_reference"
        );
        let bad_accessor = br#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":4,"uri":"auvra-asset:0000000000000000000000000000000000000000000000000000000000000000"}],"bufferViews":[{"buffer":0,"byteLength":4}],"accessors":[{"bufferView":0,"componentType":5126,"count":2,"type":"SCALAR"}]}"#;
        let id = write_source(&root, bad_accessor);
        assert_eq!(
            cook_source(
                &CookConfig::new(&root, &derived),
                &id,
                &CancellationToken::new()
            )
            .unwrap_err()
            .code,
            "gltf_accessor_bounds"
        );
        let data_uri = br#"{"asset":{"version":"2.0"},"images":[{"uri":"data:application/octet-stream;base64,AA=="}]}"#;
        let id = write_source(&root, data_uri);
        assert_eq!(
            cook_source(
                &CookConfig::new(&root, &derived),
                &id,
                &CancellationToken::new()
            )
            .unwrap_err()
            .code,
            "external_uri"
        );
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(derived);
    }

    #[test]
    fn worker_cancels_and_bounds_terminal_records() {
        let root = temp_root("worker-bounded");
        let derived = temp_root("worker-bounded-derived");
        let id = write_source(&root, &gltf());
        let worker =
            CookWorker::new(CookConfig::new(&root, &derived).with_queue_capacity(1)).unwrap();
        let cancelled = worker.submit(&id).unwrap();
        cancelled.cancellation.cancel();
        for _ in 0..100 {
            if matches!(
                worker.status(cancelled.job_id).map(|status| status.state),
                Some(JobState::Cancelled | JobState::Failed | JobState::Completed)
            ) {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        for _ in 0..(MAX_RETAINED_JOBS + 2) {
            let submission = loop {
                match worker.submit(&id) {
                    Ok(submission) => break submission,
                    Err(error) if error.code == "queue_full" => {
                        thread::sleep(Duration::from_millis(1))
                    }
                    Err(error) => panic!("unexpected submit failure: {error}"),
                }
            };
            for _ in 0..100 {
                if worker.status(submission.job_id).is_none() {
                    break;
                }
                if matches!(
                    worker.status(submission.job_id).map(|status| status.state),
                    Some(JobState::Completed | JobState::Failed | JobState::Cancelled)
                ) {
                    break;
                }
                thread::sleep(Duration::from_millis(1));
            }
        }
        assert!(worker.status(cancelled.job_id).is_none());
        drop(worker);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(derived);
    }

    #[test]
    fn deferred_submission_accepts_hydration_tail_beyond_interactive_capacity() {
        let root = temp_root("worker-deferred");
        let derived = temp_root("worker-deferred-derived");
        fs::create_dir_all(&root).unwrap();
        let worker =
            CookWorker::new(CookConfig::new(&root, &derived).with_queue_capacity(1)).unwrap();
        let ids = (0..32)
            .map(|index| format!("{index:064x}"))
            .collect::<Vec<_>>();
        let submissions = ids
            .iter()
            .map(|id| worker.submit_deferred(id))
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(submissions.len(), ids.len());
        drop(worker);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(derived);
    }

    #[cfg(unix)]
    #[test]
    fn linked_source_root_and_entry_are_rejected() {
        use std::os::unix::fs::symlink;
        let real = temp_root("symlink-real");
        let linked = temp_root("symlink-root");
        fs::create_dir_all(&real).unwrap();
        symlink(&real, &linked).unwrap();
        let derived = temp_root("symlink-derived");
        let error = match CookWorker::new(CookConfig::new(&linked, &derived)) {
            Ok(_) => panic!("linked source root was accepted"),
            Err(error) => error,
        };
        assert_eq!(error.code, "unsafe_source_root");
        let _ = fs::remove_file(linked);
        let _ = fs::remove_dir_all(real);
        let _ = fs::remove_dir_all(derived);
    }
}
