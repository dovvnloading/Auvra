use auvra_native::assets::{
    CancellationToken, CookConfig, CookWorker, cook_source, sha256_digest,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
mod gpu;
use auvra_native::render_world::{
    AnimationInput, Frustum, IblInput, LightKind, LodLevel, MaterialReference, Plane, PostEffect,
    RenderExtraction, WorldRenderEntity, WorldRenderInput, WorldRenderLight, extract_render_world,
};
use auvra_native::world::{Entity, World as NativeWorld, WorldCommand, WorldTransaction};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::io::{self, Read, Write};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use winit::{
    event_loop::EventLoop, platform::run_on_demand::EventLoopExtRunOnDemand, window::Window,
};

const MAX_FRAME: usize = 64 * 1024;
const PROTOCOL: &str = "auvra.native/1";

#[derive(Debug, Serialize)]
struct Diagnostic<'a> {
    schema: &'static str,
    level: &'static str,
    event: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'a str>,
    #[serde(rename = "traceId", skip_serializing_if = "Option::is_none")]
    trace_id: Option<&'a str>,
    #[serde(rename = "spanId", skip_serializing_if = "Option::is_none")]
    span_id: Option<&'a str>,
    #[serde(rename = "parentSpanId", skip_serializing_if = "Option::is_none")]
    parent_span_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<&'a str>,
    #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
    duration_ms: Option<f64>,
}

fn diagnostic(level: &'static str, event: &'static str, method: Option<&str>, code: Option<&str>) {
    let line = serde_json::to_string(&Diagnostic {
        schema: "auvra.native-diagnostic/1",
        level,
        event,
        method,
        code,
        trace_id: None,
        span_id: None,
        parent_span_id: None,
        phase: None,
        outcome: None,
        duration_ms: None,
    })
    .unwrap_or_else(|_| {
        "{\"schema\":\"auvra.native-diagnostic/1\",\"level\":\"error\",\"event\":\"native.diagnostic_failure\",\"code\":\"serialization_failed\"}".to_string()
    });
    eprintln!("{line}");
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DiagnosticContext {
    #[serde(default)]
    trace_id: Option<String>,
    #[serde(default)]
    span_id: Option<String>,
    #[serde(default)]
    parent_span_id: Option<String>,
    #[serde(default)]
    detailed: bool,
}

#[derive(Clone, Debug)]
struct ActiveNativeTrace {
    method: String,
    context: DiagnosticContext,
    span_id: String,
    started: Instant,
    recording: bool,
}

thread_local! {
    static ACTIVE_NATIVE_TRACE: RefCell<Option<ActiveNativeTrace>> = const { RefCell::new(None) };
}

fn stable_diagnostic_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn emit_native_operation(
    trace: &ActiveNativeTrace,
    level: &'static str,
    event: &'static str,
    phase: Option<&str>,
    outcome: Option<&str>,
    code: Option<&str>,
) {
    let line = serde_json::to_string(&Diagnostic {
        schema: "auvra.native-diagnostic/1",
        level,
        event,
        method: Some(&trace.method),
        code,
        trace_id: trace.context.trace_id.as_deref(),
        span_id: Some(&trace.span_id),
        parent_span_id: trace.context.span_id.as_deref().or(trace.context.parent_span_id.as_deref()),
        phase,
        outcome,
        duration_ms: Some(trace.started.elapsed().as_secs_f64() * 1000.0),
    })
    .unwrap_or_else(|_| {
        "{\"schema\":\"auvra.native-diagnostic/1\",\"level\":\"error\",\"event\":\"native.diagnostic_failure\",\"code\":\"serialization_failed\"}".to_string()
    });
    eprintln!("{line}");
}

fn native_phase(phase: &'static str) {
    ACTIVE_NATIVE_TRACE.with(|active| {
        if let Some(trace) = active.borrow().as_ref()
            && trace.recording
        {
            emit_native_operation(
                trace,
                "debug",
                "native.operation_phase",
                Some(phase),
                None,
                None,
            );
        }
    });
}

fn in_native_phase<T>(phase: &'static str, work: impl FnOnce() -> T) -> T {
    native_phase(phase);
    work()
}

struct NativeTraceGuard {
    trace: ActiveNativeTrace,
}

impl NativeTraceGuard {
    fn begin(method: &str, request_id: u64, context: DiagnosticContext) -> Self {
        let quiet = matches!(
            method,
            "world.getSnapshot" | "renderer.getMetrics" | "asset.status"
        );
        let trace = ActiveNativeTrace {
            method: method.to_string(),
            span_id: format!(
                "native-{}",
                stable_id(&format!(
                    "{method}:{request_id}:{}",
                    context.trace_id.as_deref().unwrap_or("run")
                ))
            ),
            recording: context.detailed || !quiet,
            context,
            started: Instant::now(),
        };
        if trace.recording {
            emit_native_operation(
                &trace,
                "debug",
                "native.operation_started",
                Some("dispatch"),
                None,
                None,
            );
        }
        ACTIVE_NATIVE_TRACE.with(|active| *active.borrow_mut() = Some(trace.clone()));
        Self { trace }
    }

    fn finish(self, succeeded: bool) {
        if self.trace.recording || !succeeded {
            emit_native_operation(
                &self.trace,
                if succeeded { "debug" } else { "error" },
                if succeeded {
                    "native.operation_completed"
                } else {
                    "native.operation_failed"
                },
                Some("complete"),
                Some(if succeeded { "success" } else { "failure" }),
                if succeeded {
                    None
                } else {
                    Some("operation_failed")
                },
            );
        }
        ACTIVE_NATIVE_TRACE.with(|active| *active.borrow_mut() = None);
    }
}

fn take_diagnostic_context(params: &mut Value) -> DiagnosticContext {
    let Some(object) = params.as_object_mut() else {
        return DiagnosticContext::default();
    };
    let Some(value) = object.remove("__diagnostics") else {
        return DiagnosticContext::default();
    };
    let Ok(mut context) = serde_json::from_value::<DiagnosticContext>(value) else {
        return DiagnosticContext::default();
    };
    context.trace_id = context.trace_id.filter(|value| stable_diagnostic_id(value));
    context.span_id = context.span_id.filter(|value| stable_diagnostic_id(value));
    context.parent_span_id = context
        .parent_span_id
        .filter(|value| stable_diagnostic_id(value));
    context
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: u64,
    protocol: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct Response {
    id: u64,
    protocol: &'static str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

fn response(id: u64, result: Value) -> Response {
    Response {
        id,
        protocol: PROTOCOL,
        ok: true,
        result: Some(result),
        error: None,
    }
}

fn error_response(id: u64, code: &'static str, message: impl Into<String>) -> Response {
    Response {
        id,
        protocol: PROTOCOL,
        ok: false,
        result: None,
        error: Some(ErrorBody {
            code,
            message: message.into(),
            details: None,
        }),
    }
}

fn error_response_with_details(
    id: u64,
    code: &'static str,
    message: impl Into<String>,
    details: Option<Value>,
) -> Response {
    Response {
        id,
        protocol: PROTOCOL,
        ok: false,
        result: None,
        error: Some(ErrorBody {
            code,
            message: message.into(),
            details,
        }),
    }
}

fn read_frame(input: &mut impl Read) -> Result<Option<Vec<u8>>, String> {
    let mut header = [0_u8; 4];
    let mut read = 0;
    while read < 4 {
        let count = input.read(&mut header[read..]).map_err(|e| e.to_string())?;
        if count == 0 {
            return if read == 0 {
                Ok(None)
            } else {
                Err("truncated length prefix".into())
            };
        }
        read += count;
    }
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(format!(
            "frame length {length} exceeds 64 KiB protocol limit"
        ));
    }
    let mut body = vec![0_u8; length];
    input
        .read_exact(&mut body)
        .map_err(|e| format!("truncated frame: {e}"))?;
    Ok(Some(body))
}

#[derive(Debug)]
enum FrameWriteError {
    Serialization(String),
    TooLarge,
    Io(String),
}

impl fmt::Display for FrameWriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Serialization(error) => {
                write!(formatter, "response serialization failed: {error}")
            }
            Self::TooLarge => formatter.write_str("response exceeds 64 KiB protocol limit"),
            Self::Io(error) => write!(formatter, "response write failed: {error}"),
        }
    }
}

fn write_frame(output: &mut impl Write, value: &impl Serialize) -> Result<(), FrameWriteError> {
    let body = serde_json::to_vec(value)
        .map_err(|error| FrameWriteError::Serialization(error.to_string()))?;
    if body.is_empty() || body.len() > MAX_FRAME {
        return Err(FrameWriteError::TooLarge);
    }
    output
        .write_all(&(body.len() as u32).to_be_bytes())
        .map_err(|error| FrameWriteError::Io(error.to_string()))?;
    output
        .write_all(&body)
        .map_err(|error| FrameWriteError::Io(error.to_string()))?;
    output
        .flush()
        .map_err(|error| FrameWriteError::Io(error.to_string()))
}

#[derive(Debug, Eq, PartialEq)]
enum ResponseWriteOutcome {
    Written,
    ReplacedWithError,
}

impl ResponseWriteOutcome {
    fn operation_succeeded(&self, response_ok: bool) -> bool {
        response_ok && matches!(self, Self::Written)
    }
}

fn write_response(
    output: &mut impl Write,
    response: &Response,
) -> Result<ResponseWriteOutcome, FrameWriteError> {
    match write_frame(output, response) {
        Ok(()) => Ok(ResponseWriteOutcome::Written),
        Err(FrameWriteError::TooLarge) => {
            let fallback = error_response(
                response.id,
                "operation_failed",
                "native response exceeds 64 KiB protocol limit",
            );
            write_frame(output, &fallback)?;
            Ok(ResponseWriteOutcome::ReplacedWithError)
        }
        Err(FrameWriteError::Serialization(_)) => {
            let fallback = error_response(
                response.id,
                "operation_failed",
                "native response could not be serialized",
            );
            write_frame(output, &fallback)?;
            Ok(ResponseWriteOutcome::ReplacedWithError)
        }
        Err(error) => Err(error),
    }
}

struct Renderer {
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    info: wgpu::AdapterInfo,
    format: wgpu::TextureFormat,
    startup_ms: f64,
    last_frame_ms: Option<f64>,
    last_gpu_ms: Option<f64>,
    last_memory_bytes: u64,
    last_hash: Option<String>,
    production_pipelines: gpu::ProductionPipelines,
    gpu_timing: Option<gpu::GpuTiming>,
    gpu_timing_supported: bool,
    gpu_timing_fallback: Option<String>,
    pipeline_cache_hits: u64,
    pipeline_cache_misses: u64,
}

impl Renderer {
    fn new() -> Result<Self, String> {
        let started = Instant::now();
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::LowPower,
            compatible_surface: None,
            force_fallback_adapter: std::env::var_os("AUVRA_WGPU_FORCE_FALLBACK_ADAPTER").as_deref()
                == Some(std::ffi::OsStr::new("1")),
            apply_limit_buckets: false,
        }))
        .map_err(|e| format!("adapter request failed: {e:?}"))?;
        let info = adapter.get_info();
        gpu::validate_adapter(&adapter)?;
        let available = adapter.features();
        let timestamp_features_available = available.contains(wgpu::Features::TIMESTAMP_QUERY)
            && available.contains(wgpu::Features::TIMESTAMP_QUERY_INSIDE_PASSES);
        let required_features = if timestamp_features_available {
            wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_PASSES
        } else {
            wgpu::Features::empty()
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("auvra-native-device"),
            required_features,
            required_limits: wgpu::Limits::downlevel_defaults(),
            experimental_features: wgpu::ExperimentalFeatures::disabled(),
            memory_hints: wgpu::MemoryHints::Performance,
            trace: wgpu::Trace::Off,
        }))
        .map_err(|e| format!("device request failed: {e:?}"))?;
        let production_pipelines =
            gpu::ProductionPipelines::new(&device, wgpu::TextureFormat::Rgba8UnormSrgb);
        let gpu_timing = timestamp_features_available
            .then(|| gpu::GpuTiming::new(&device, &queue))
            .flatten();
        let gpu_timing_supported = gpu_timing.is_some();
        Ok(Self {
            instance,
            adapter,
            device,
            queue,
            info,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            startup_ms: started.elapsed().as_secs_f64() * 1000.0,
            last_frame_ms: None,
            last_gpu_ms: None,
            last_memory_bytes: 0,
            last_hash: None,
            production_pipelines,
            gpu_timing,
            gpu_timing_supported,
            gpu_timing_fallback: (!gpu_timing_supported)
                .then(|| "timestamp_query_unavailable_cpu_submit".into()),
            pipeline_cache_hits: 0,
            pipeline_cache_misses: 0,
        })
    }

    fn capabilities(&self) -> Value {
        let feature_caps = gpu::capabilities();
        json!({"backend": format!("{:?}", self.info.backend), "adapter": self.info.name, "device_type": format!("{:?}", self.info.device_type), "format": format!("{:?}", self.format), "gpu_timing": {"supported": self.gpu_timing_supported, "fallback": self.gpu_timing_fallback}, "pipeline_cache_key": "production-v1|immutable-extraction", "pipeline_cache_hits": self.pipeline_cache_hits, "pipeline_cache_misses": self.pipeline_cache_misses, "featureCapabilities": feature_caps.features, "dockSupport": "unsupported", "dockActive": false, "dockReason": "same-build-native-parenting-gate-not-passed"})
    }

    fn render_production(
        &mut self,
        params: &Value,
        extraction: &RenderExtraction,
    ) -> Result<Value, String> {
        let (width, height) = dimensions(params)?;
        let frame = gpu::render_offscreen(
            &self.device,
            &self.queue,
            self.format,
            &mut self.production_pipelines,
            self.gpu_timing.as_ref(),
            extraction,
            width,
            height,
        )?;
        // This metric is deliberately CPU command encoding/submission only.
        // GPU completion, readback mapping, and signature hashing are separate
        // acceptance work and must not be compared with the CPU frame budget.
        self.last_frame_ms = Some(frame.cpu_submit_ms);
        self.last_gpu_ms = frame.gpu_ms;
        self.last_hash = Some(format!("0x{:016x}", frame.pixel_hash));
        self.last_memory_bytes = frame.memory_bytes;
        if frame.pipeline_cache_hit {
            self.pipeline_cache_hits = self.pipeline_cache_hits.saturating_add(1);
        } else {
            self.pipeline_cache_misses = self.pipeline_cache_misses.saturating_add(1);
        }
        Ok(
            json!({"referenceScene":"basic", "referenceVersion":1, "width":width, "height":height, "signature":format!("{:016x}", frame.pixel_hash), "pixel_hash_fnv1a64":format!("0x{:016x}", frame.pixel_hash), "geometryCount":frame.geometry_count, "batchCount":frame.batch_count, "passCount":frame.pass_count, "fallbackCount":frame.fallback_count, "executedPasses":frame.executed_passes, "extractionHash":extraction.snapshot.extraction_hash, "capabilities":gpu::capabilities().features, "pipeline_cache_hits":self.pipeline_cache_hits, "pipeline_cache_misses":self.pipeline_cache_misses, "frame_submit_ms":self.last_frame_ms}),
        )
    }

    fn present_surface(
        &mut self,
        surface: &wgpu::Surface<'_>,
        _format: wgpu::TextureFormat,
        width: u32,
        height: u32,
        extraction: &RenderExtraction,
    ) -> Result<(), String> {
        let frame = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            status => return Err(format!("surface acquire failed: {status:?}")),
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let submission = gpu::present_production(
            &self.device,
            &self.queue,
            &view,
            &mut self.production_pipelines,
            self.gpu_timing.as_ref(),
            extraction,
            width,
            height,
        )?;
        self.last_frame_ms = Some(submission.cpu_submit_ms);
        self.last_gpu_ms = submission.gpu_ms;
        self.last_memory_bytes = submission.memory_bytes;
        if submission.pipeline_cache_hit {
            self.pipeline_cache_hits = self.pipeline_cache_hits.saturating_add(1);
        } else {
            self.pipeline_cache_misses = self.pipeline_cache_misses.saturating_add(1);
        }
        self.queue.present(frame);
        Ok(())
    }

    fn metrics(&self) -> Value {
        json!({"startup_ms": self.startup_ms, "last_frame_submit_ms": self.last_frame_ms, "gpu_frame_ms": self.last_gpu_ms, "memory_bytes": self.last_memory_bytes, "last_readback_hash": self.last_hash, "backend": format!("{:?}", self.info.backend), "adapter": self.info.name, "gpu_timing": {"supported": self.gpu_timing_supported, "fallback": self.gpu_timing_fallback}})
    }
}

fn dimensions(params: &Value) -> Result<(u32, u32), String> {
    let obj = params.as_object();
    let width = obj
        .and_then(|v| v.get("width"))
        .and_then(Value::as_u64)
        .unwrap_or(128);
    let height = obj
        .and_then(|v| v.get("height"))
        .and_then(Value::as_u64)
        .unwrap_or(128);
    if !(16..=2048).contains(&width) || !(16..=2048).contains(&height) {
        return Err("reference dimensions must be between 16 and 2048".into());
    }
    Ok((width as u32, height as u32))
}

struct Viewport {
    event_loop: EventLoop<()>,
    app: ViewportApp,
    window: Arc<Window>,
    surface: Option<wgpu::Surface<'static>>,
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
}

struct ViewportApp {
    window: Option<Arc<Window>>,
    width: u32,
    height: u32,
    title: String,
    close_requested: bool,
    resized: Option<(u32, u32)>,
    redraw_requested: bool,
}

impl winit::application::ApplicationHandler for ViewportApp {
    fn resumed(&mut self, event_loop: &winit::event_loop::ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attrs = Window::default_attributes()
            .with_title(self.title.clone())
            .with_inner_size(winit::dpi::PhysicalSize::new(self.width, self.height));
        match event_loop.create_window(attrs) {
            Ok(window) => {
                self.window = Some(Arc::new(window));
            }
            Err(_) => {
                event_loop.exit();
            }
        }
    }
    fn window_event(
        &mut self,
        event_loop: &winit::event_loop::ActiveEventLoop,
        _window_id: winit::window::WindowId,
        event: winit::event::WindowEvent,
    ) {
        match event {
            winit::event::WindowEvent::CloseRequested => {
                self.close_requested = true;
                event_loop.exit();
            }
            winit::event::WindowEvent::Resized(size)
                if size.width > 0 && size.height > 0 =>
            {
                self.width = size.width;
                self.height = size.height;
                self.resized = Some((size.width, size.height));
            }
            winit::event::WindowEvent::RedrawRequested => {
                self.redraw_requested = true;
            }
            _ => {}
        }
    }
    fn about_to_wait(&mut self, event_loop: &winit::event_loop::ActiveEventLoop) {
        if let Some(window) = &self.window {
            window.request_redraw();
        }
        // ``run_app_on_demand`` is used as a bounded event pump by the IPC
        // loop. Return after this batch so requests and window events share
        // the native thread without starving either side.
        event_loop.exit();
    }
}

impl Viewport {
    fn open(
        renderer: &mut Renderer,
        width: u32,
        height: u32,
        title: String,
        extraction: &RenderExtraction,
    ) -> Result<Self, String> {
        let mut event_loop = EventLoop::new().map_err(|e| e.to_string())?;
        let mut app = ViewportApp {
            window: None,
            width,
            height,
            title: title.clone(),
            close_requested: false,
            resized: None,
            redraw_requested: false,
        };
        event_loop
            .run_app_on_demand(&mut app)
            .map_err(|e| e.to_string())?;
        let window = app
            .window
            .clone()
            .ok_or("viewport window creation failed")?;
        let surface = renderer
            .instance
            .create_surface(window.clone())
            .map_err(|e| e.to_string())?;
        let caps = surface.get_capabilities(&renderer.adapter);
        let format = caps
            .formats
            .first()
            .copied()
            .ok_or("viewport surface has no formats")?;
        let present_mode = caps
            .present_modes
            .first()
            .copied()
            .ok_or("viewport surface has no present modes")?;
        let alpha_mode = caps
            .alpha_modes
            .first()
            .copied()
            .ok_or("viewport surface has no alpha modes")?;
        configure_viewport_surface(
            renderer,
            &surface,
            format,
            width,
            height,
            present_mode,
            alpha_mode,
        );
        renderer.present_surface(&surface, format, width, height, extraction)?;
        Ok(Self {
            event_loop,
            app,
            window,
            surface: Some(surface),
            format,
            width,
            height,
        })
    }

    fn pump_events(
        &mut self,
        renderer: &mut Renderer,
        extraction: &RenderExtraction,
    ) -> Result<bool, String> {
        self.app.resized = None;
        self.app.redraw_requested = false;
        self.event_loop
            .run_app_on_demand(&mut self.app)
            .map_err(|e| e.to_string())?;
        if self.app.close_requested {
            return Ok(false);
        }
        let Some(surface) = self.surface.as_ref() else {
            return Ok(false);
        };
        if let Some((width, height)) = self.app.resized {
            self.width = width;
            self.height = height;
            let caps = surface.get_capabilities(&renderer.adapter);
            let present_mode = caps
                .present_modes
                .first()
                .copied()
                .ok_or("viewport surface has no present modes")?;
            let alpha_mode = caps
                .alpha_modes
                .first()
                .copied()
                .ok_or("viewport surface has no alpha modes")?;
            configure_viewport_surface(
                renderer,
                surface,
                self.format,
                width,
                height,
                present_mode,
                alpha_mode,
            );
        }
        // Present on every bounded pump, not only on the first open or after
        // explicit recovery. This keeps world mutations and redraw/resize
        // events visible while the IPC loop remains responsive.
        renderer.present_surface(surface, self.format, self.width, self.height, extraction)?;
        Ok(true)
    }

    fn recover(
        &mut self,
        renderer: &mut Renderer,
        extraction: &RenderExtraction,
    ) -> Result<(), String> {
        drop(self.surface.take());
        let surface = renderer
            .instance
            .create_surface(self.window.clone())
            .map_err(|e| e.to_string())?;
        let caps = surface.get_capabilities(&renderer.adapter);
        let format = caps
            .formats
            .first()
            .copied()
            .ok_or("recovered viewport surface has no formats")?;
        let present_mode = caps
            .present_modes
            .first()
            .copied()
            .ok_or("recovered viewport surface has no present modes")?;
        let alpha_mode = caps
            .alpha_modes
            .first()
            .copied()
            .ok_or("recovered viewport surface has no alpha modes")?;
        configure_viewport_surface(
            renderer,
            &surface,
            format,
            self.width,
            self.height,
            present_mode,
            alpha_mode,
        );
        renderer.present_surface(&surface, format, self.width, self.height, extraction)?;
        self.format = format;
        self.surface = Some(surface);
        Ok(())
    }
}

fn configure_viewport_surface(
    renderer: &mut Renderer,
    surface: &wgpu::Surface<'_>,
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
    present_mode: wgpu::PresentMode,
    alpha_mode: wgpu::CompositeAlphaMode,
) {
    renderer
        .production_pipelines
        .ensure_surface_format(&renderer.device, format);
    surface.configure(
        &renderer.device,
        &wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            color_space: wgpu::SurfaceColorSpace::Auto,
            width,
            height,
            present_mode,
            alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        },
    );
}

fn valid_session_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn session_proof(token: &str, challenge: &str, editor_session: &str) -> String {
    const BLOCK_BYTES: usize = 64;
    let mut key = [0_u8; BLOCK_BYTES];
    let token_bytes = token.as_bytes();
    key[..token_bytes.len().min(BLOCK_BYTES)]
        .copy_from_slice(&token_bytes[..token_bytes.len().min(BLOCK_BYTES)]);
    let mut inner = [0x36_u8; BLOCK_BYTES];
    let mut outer = [0x5c_u8; BLOCK_BYTES];
    for index in 0..BLOCK_BYTES {
        inner[index] ^= key[index];
        outer[index] ^= key[index];
    }
    let mut message = Vec::with_capacity(BLOCK_BYTES + challenge.len() + editor_session.len() + 1);
    message.extend_from_slice(&inner);
    message.extend_from_slice(challenge.as_bytes());
    message.push(b'\n');
    message.extend_from_slice(editor_session.as_bytes());
    let inner_digest = sha256_digest(&message);
    let mut outer_message = Vec::with_capacity(BLOCK_BYTES + inner_digest.len());
    outer_message.extend_from_slice(&outer);
    outer_message.extend_from_slice(&inner_digest);
    sha256_digest(&outer_message)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

struct App {
    authenticated: bool,
    session_token: Option<String>,
    world: NativeWorld,
    project_id: Option<String>,
    project_revision: Option<u64>,
    renderer: Renderer,
    viewport: Option<Viewport>,
    cooker: Option<CookWorker>,
    asset_jobs: HashMap<u64, CancellationToken>,
    pending_asset_ids: BTreeSet<String>,
    hydration: Option<HydrationDraft>,
    render_state: ProjectRenderState,
}

#[derive(Clone)]
struct HydrationDraft {
    project_id: String,
    project_revision: u64,
    validate_only: bool,
    domains: BTreeMap<String, Vec<Value>>,
    asset_ids: BTreeSet<String>,
    document_count: usize,
}

#[derive(Clone, Debug, PartialEq)]
struct ProjectRenderState {
    materials: BTreeMap<u64, MaterialReference>,
    model_base_color_textures: BTreeMap<String, u64>,
    object_materials: BTreeMap<String, u64>,
    object_lods: BTreeMap<String, Vec<LodLevel>>,
    object_animations: BTreeMap<String, AnimationInput>,
    object_visibility: BTreeMap<String, bool>,
    object_selected: BTreeSet<String>,
    object_radii: BTreeMap<String, f32>,
    lights: Vec<WorldRenderLight>,
    camera_position: [f32; 3],
    ibl: Option<IblInput>,
    post_effects: Vec<PostEffect>,
    msaa_samples: u8,
    fxaa: bool,
}

impl Default for ProjectRenderState {
    fn default() -> Self {
        Self {
            materials: BTreeMap::new(),
            model_base_color_textures: BTreeMap::new(),
            object_materials: BTreeMap::new(),
            object_lods: BTreeMap::new(),
            object_animations: BTreeMap::new(),
            object_visibility: BTreeMap::new(),
            object_selected: BTreeSet::new(),
            object_radii: BTreeMap::new(),
            lights: Vec::new(),
            camera_position: [0.0; 3],
            ibl: None,
            post_effects: Vec::new(),
            msaa_samples: 0,
            fxaa: false,
        }
    }
}

impl App {
    fn new() -> Result<Self, String> {
        let session_token = std::env::var("AUVRA_NATIVE_SESSION_TOKEN")
            .ok()
            .filter(|token| valid_session_token(token));
        let world = NativeWorld::new();
        let cooker = match (
            std::env::var_os("AUVRA_NATIVE_SOURCE_ROOT"),
            std::env::var_os("AUVRA_NATIVE_DERIVED_ROOT"),
        ) {
            (Some(source), Some(derived)) => {
                Some(CookWorker::new(CookConfig::new(source, derived)).map_err(|e| e.to_string())?)
            }
            _ => None,
        };
        Ok(Self {
            authenticated: false,
            session_token,
            world,
            project_id: None,
            project_revision: None,
            renderer: Renderer::new()?,
            viewport: None,
            cooker,
            asset_jobs: HashMap::new(),
            pending_asset_ids: BTreeSet::new(),
            hydration: None,
            render_state: ProjectRenderState::default(),
        })
    }

    fn dispatch(&mut self, req: Request) -> Result<Response, String> {
        if req.protocol != PROTOCOL {
            return Err("unsupported protocol version".into());
        }
        if req.method == "session.hello" {
            let Some(params) = req.params.as_object() else {
                return Ok(error_response(
                    req.id,
                    "authentication_failed",
                    "session.hello requires an editor session, challenge, and proof",
                ));
            };
            let editor_session = params
                .get("editorSession")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 128);
            let challenge = params
                .get("challenge")
                .and_then(Value::as_str)
                .filter(|value| valid_session_token(value));
            let proof = params
                .get("proof")
                .and_then(Value::as_str)
                .filter(|value| valid_session_token(value));
            let authenticated = match (
                self.session_token.as_deref(),
                editor_session,
                challenge,
                proof,
            ) {
                (Some(token), Some(editor_session), Some(challenge), Some(proof)) => {
                    let expected = session_proof(token, challenge, editor_session);
                    constant_time_equal(expected.as_bytes(), proof.as_bytes())
                }
                _ => false,
            };
            if !authenticated {
                return Ok(error_response(
                    req.id,
                    "authentication_failed",
                    "session proof is invalid",
                ));
            }
            self.authenticated = true;
            return Ok(response(
                req.id,
                json!({"protocol": PROTOCOL, "authenticated": true, "world_revision": self.world.revision(), "world_tick": self.world.tick()}),
            ));
        }
        if !self.authenticated {
            return Err("session.hello required".into());
        }
        self.reap_asset_jobs();
        self.retry_pending_asset_jobs();
        let result = match req.method.as_str() {
            "world.getSnapshot" => {
                in_native_phase("world_validate", || self.world_snapshot(&req.params))
            }
            "world.apply" => in_native_phase("world_commit", || self.apply_legacy(&req.params)),
            "world.applyTransaction" | "world.applyCommands" => {
                in_native_phase("world_commit", || self.apply_transaction(&req.params))
            }
            "world.validateHydration" => in_native_phase("hydration_validate", || {
                self.validate_hydration(&req.params)
            }),
            "world.hydrate" => {
                in_native_phase("hydration_commit", || self.hydrate_world(&req.params))
            }
            "world.beginHydration" => {
                in_native_phase("hydration_validate", || self.begin_hydration(&req.params))
            }
            "world.appendHydration" => {
                in_native_phase("hydration_validate", || self.append_hydration(&req.params))
            }
            "world.commitHydration" => {
                in_native_phase("hydration_commit", || self.commit_hydration())
            }
            "world.abortHydration" => {
                in_native_phase("hydration_commit", || self.abort_hydration())
            }
            "world.closeProject" => in_native_phase("world_commit", || self.close_project()),
            "world.advance" => in_native_phase("world_advance", || self.advance_world(&req.params)),
            "world.getReplay" => self.replay_snapshot(),
            "renderer.getCapabilities" => Ok(self.renderer.capabilities()),
            "renderer.renderReference" => {
                native_phase("render_extract");
                let extraction = self.build_extraction(&req.params)?;
                native_phase("render_submit");
                self.renderer.render_production(&req.params, &extraction)
            }
            "renderer.extract" => {
                in_native_phase("render_extract", || self.render_extract(&req.params))
            }
            "renderer.getMetrics" => Ok(self.renderer.metrics()),
            "renderer.recover" => in_native_phase("renderer_recover", || self.recover_renderer()),
            "asset.submit" | "asset.beginCook" => {
                in_native_phase("asset_submit", || self.submit_asset(&req.params))
            }
            "asset.status" => in_native_phase("asset_status", || self.asset_status(&req.params)),
            "asset.cancel" => in_native_phase("asset_status", || self.cancel_asset(&req.params)),
            "viewport.open" => in_native_phase("viewport_open", || self.open_viewport(&req.params)),
            "viewport.close" => {
                native_phase("viewport_close");
                self.viewport = None;
                Ok(json!({"open": false, "world_revision": self.world.revision()}))
            }
            "shutdown" => in_native_phase("shutdown", || Ok(json!({"stopped": true}))),
            _ => Ok(
                json!({"__error": {"code": "unknown_method", "message": "method is not part of auvra.native/1"}}),
            ),
        };
        match result {
            Ok(value) => {
                if let Some(error) = value.get("__error") {
                    let body = match error.get("code").and_then(Value::as_str) {
                        Some("unknown_method") => "unknown_method",
                        _ => "operation_failed",
                    };
                    let message = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("native operation failed");
                    Ok(error_response(req.id, body, message))
                } else {
                    Ok(response(req.id, value))
                }
            }
            Err(error) => Ok(Self::operation_error_response(req.id, &error)),
        }
    }

    fn operation_error_response(id: u64, error: &str) -> Response {
        let (code, message) = error.split_once('|').unwrap_or(("operation_failed", error));
        if code == "revision_conflict" {
            let details = message
                .split('|')
                .filter_map(|part| part.split_once('='))
                .fold(serde_json::Map::new(), |mut map, (key, value)| {
                    if let Ok(number) = value.parse::<u64>() {
                        map.insert(key.to_string(), json!(number));
                    }
                    map
                });
            let message = message.split('|').next().unwrap_or(message);
            return error_response_with_details(
                id,
                "revision_conflict",
                message,
                Some(Value::Object(details)),
            );
        }
        let allowed = [
            "invalid_project",
            "invalid_request",
            "unsupported_version",
            "cancelled",
            "recovery_required",
            "permission_denied",
            "unsupported_capability",
        ];
        let safe_code = allowed
            .iter()
            .copied()
            .find(|candidate| *candidate == code)
            .unwrap_or("operation_failed");
        error_response(id, safe_code, message)
    }

    fn world_snapshot(&self, params: &Value) -> Result<Value, String> {
        let snapshot = self.world.snapshot();
        let object = params.as_object();
        let offset = object
            .and_then(|v| v.get("offset"))
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(snapshot.entities.len() as u64) as usize;
        let limit = object
            .and_then(|v| v.get("limit"))
            .and_then(Value::as_u64)
            .unwrap_or(128)
            .clamp(1, 256) as usize;
        let end = offset.saturating_add(limit).min(snapshot.entities.len());
        Ok(
            json!({"revision": snapshot.revision, "tick": snapshot.tick, "worldHash": snapshot.world_hash, "worldRevision": snapshot.revision, "projectId": self.project_id, "projectRevision": self.project_revision, "replayHash": self.world.replay_hash(), "entities": &snapshot.entities[offset..end], "page": {"offset": offset, "limit": limit, "total": snapshot.entities.len(), "hasMore": end < snapshot.entities.len()}}),
        )
    }

    fn apply_legacy(&mut self, params: &Value) -> Result<Value, String> {
        let object = params
            .as_object()
            .ok_or("invalid_request|params must be an object")?;
        let expected = object
            .get("expectedRevision")
            .and_then(Value::as_u64)
            .ok_or("invalid_request|expectedRevision must be an unsigned integer")?;
        let entities: Vec<Entity> = serde_json::from_value(
            object
                .get("entities")
                .cloned()
                .ok_or("invalid_request|entities are required")?,
        )
        .map_err(|e| format!("invalid_request|invalid entities: {e}"))?;
        let existing = self.world.snapshot().entities;
        let incoming = entities
            .iter()
            .map(|entity| entity.id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let mut commands = existing
            .into_iter()
            .filter(|entity| !incoming.contains(entity.id.as_str()))
            .map(|entity| WorldCommand::Remove {
                id: entity.id,
                expected_generation: Some(entity.generation),
            })
            .collect::<Vec<_>>();
        commands.extend(
            entities
                .into_iter()
                .map(|entity| WorldCommand::Upsert { entity }),
        );
        if commands.is_empty() {
            if expected != self.world.revision() {
                return Err(world_error_message(
                    auvra_native::world::WorldError::RevisionConflict {
                        expected,
                        actual: self.world.revision(),
                    },
                ));
            }
            return self.world_snapshot(&Value::Null);
        }
        self.world
            .apply_commands(expected, commands)
            .map_err(world_error_message)
            .and_then(|snapshot| self.snapshot_value(snapshot, params))
    }

    fn apply_transaction(&mut self, params: &Value) -> Result<Value, String> {
        let tx: WorldTransaction = serde_json::from_value(params.clone())
            .map_err(|e| format!("invalid_request|invalid world transaction: {e}"))?;
        self.world
            .apply_transaction(tx)
            .map_err(world_error_message)
            .and_then(|snapshot| self.snapshot_value(snapshot, params))
    }

    fn snapshot_value(
        &self,
        snapshot: auvra_native::world::WorldSnapshot,
        params: &Value,
    ) -> Result<Value, String> {
        let object = params.as_object();
        let offset = object
            .and_then(|v| v.get("offset"))
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(snapshot.entities.len() as u64) as usize;
        let limit = object
            .and_then(|v| v.get("limit"))
            .and_then(Value::as_u64)
            .unwrap_or(128)
            .clamp(1, 256) as usize;
        let end = offset.saturating_add(limit).min(snapshot.entities.len());
        Ok(
            json!({"revision": snapshot.revision, "tick": snapshot.tick, "worldHash": snapshot.world_hash, "worldRevision": snapshot.revision, "projectId": self.project_id, "projectRevision": self.project_revision, "replayHash": self.world.replay_hash(), "entities": &snapshot.entities[offset..end], "page": {"offset": offset, "limit": limit, "total": snapshot.entities.len(), "hasMore": end < snapshot.entities.len()}}),
        )
    }

    fn validate_hydration(&self, params: &Value) -> Result<Value, String> {
        let (_, revision, entities, _, _) = project_candidate(params)?;
        let mut candidate = NativeWorld::new();
        candidate
            .hydrate(revision, entities)
            .map_err(world_error_message)?;
        Ok(json!({"valid": true, "projectRevision": revision}))
    }

    fn begin_hydration(&mut self, params: &Value) -> Result<Value, String> {
        if self.hydration.is_some() {
            return Err("invalid_request|a hydration transaction is already active".into());
        }
        let object = params
            .as_object()
            .ok_or("invalid_request|hydration transaction must be an object")?;
        let project_id = object
            .get("projectId")
            .and_then(Value::as_str)
            .ok_or("invalid_project|projectId is required")?;
        if project_id.is_empty()
            || project_id.len() > 128
            || !project_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:".contains(&byte))
        {
            return Err("invalid_project|projectId is invalid".into());
        }
        let project_revision = object
            .get("projectRevision")
            .and_then(Value::as_u64)
            .ok_or("invalid_project|projectRevision is required")?;
        let validate_only = object
            .get("validateOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.hydration = Some(HydrationDraft {
            project_id: project_id.into(),
            project_revision,
            validate_only,
            domains: BTreeMap::new(),
            asset_ids: BTreeSet::new(),
            document_count: 0,
        });
        Ok(
            json!({"hydrationTransaction": true, "active": true, "projectId": project_id, "projectRevision": project_revision, "validateOnly": validate_only}),
        )
    }

    fn append_hydration(&mut self, params: &Value) -> Result<Value, String> {
        let draft = self
            .hydration
            .as_mut()
            .ok_or("invalid_request|no hydration transaction is active")?;
        let object = params
            .as_object()
            .ok_or("invalid_request|hydration page must be an object")?;
        if let Some(project_id) = object.get("projectId").and_then(Value::as_str) {
            if project_id != draft.project_id {
                return Err(
                    "invalid_project|hydration projectId does not match beginHydration".into(),
                );
            }
        }
        if let Some(revision) = object.get("projectRevision").and_then(Value::as_u64) {
            if revision != draft.project_revision {
                return Err(
                    "invalid_project|hydration projectRevision does not match beginHydration"
                        .into(),
                );
            }
        }
        let mut appended = 0_usize;
        let mut has_domain_page = false;
        if let Some(domain) = object.get("domain").and_then(Value::as_str) {
            has_domain_page = true;
            let schema_version = object
                .get("schemaVersion")
                .and_then(Value::as_u64)
                .ok_or("invalid_project|domain schemaVersion is required")?;
            if schema_version != 1 {
                return Err(
                    "unsupported_version|project domain schema version is unsupported".into(),
                );
            }
            let documents = object
                .get("documents")
                .and_then(Value::as_array)
                .ok_or("invalid_project|domain documents are required")?;
            if domain.is_empty()
                || domain.len() > 128
                || !domain
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            {
                return Err("invalid_project|domain name is invalid".into());
            }
            if documents.len() > 256
                || draft.document_count.saturating_add(documents.len()) > 16_384
            {
                return Err("invalid_project|hydration document limit exceeded".into());
            }
            let entries = draft.domains.entry(domain.into()).or_default();
            entries.extend(documents.iter().cloned());
            draft.document_count += documents.len();
            appended = documents.len();
        } else if let Some(domains) = object.get("domains").and_then(Value::as_object) {
            has_domain_page = true;
            for (domain, value) in domains {
                let page = value
                    .as_object()
                    .ok_or("invalid_project|domain must be an object")?;
                if page.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
                    return Err(
                        "unsupported_version|project domain schema version is unsupported".into(),
                    );
                }
                let documents = page
                    .get("documents")
                    .and_then(Value::as_array)
                    .ok_or("invalid_project|domain documents are required")?;
                if domain.is_empty()
                    || domain.len() > 128
                    || !domain
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                    || documents.len() > 256
                    || draft.document_count.saturating_add(documents.len()) > 16_384
                {
                    return Err("invalid_project|hydration document limit exceeded or domain name is invalid".into());
                }
                draft
                    .domains
                    .entry(domain.clone())
                    .or_default()
                    .extend(documents.iter().cloned());
                draft.document_count += documents.len();
                appended += documents.len();
            }
        }
        if let Some(asset_ids) = object.get("assetIds").and_then(Value::as_array) {
            if asset_ids.len() > 256
                || draft.asset_ids.len().saturating_add(asset_ids.len()) > 16_384
            {
                return Err("invalid_project|hydration asset limit exceeded".into());
            }
            for value in asset_ids {
                let asset_id = value
                    .as_str()
                    .ok_or("invalid_project|assetIds must contain strings")?;
                if asset_id.len() != 64
                    || !asset_id
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return Err("invalid_project|assetId is invalid".into());
                }
                draft.asset_ids.insert(asset_id.into());
            }
        }
        if !has_domain_page && object.get("assetIds").is_none() {
            return Err("invalid_request|hydration page must contain a domain or assetIds".into());
        }
        Ok(
            json!({"hydrationTransaction": true, "active": true, "documentsAppended": appended, "documentCount": draft.document_count, "assetCount": draft.asset_ids.len()}),
        )
    }

    fn commit_hydration(&mut self) -> Result<Value, String> {
        let draft = self
            .hydration
            .clone()
            .ok_or("invalid_request|no hydration transaction is active")?;
        let domains = draft
            .domains
            .iter()
            .map(|(domain, documents)| {
                (
                    domain.clone(),
                    json!({"schemaVersion": 1, "documents": documents}),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let params = json!({"projectId": draft.project_id, "projectRevision": draft.project_revision, "domains": domains, "assetIds": draft.asset_ids});
        let (project_id, project_revision, entities, asset_ids, render_state) =
            project_candidate(&params)?;
        let mut candidate = NativeWorld::new();
        let snapshot = candidate
            .hydrate(project_revision, entities)
            .map_err(world_error_message)?;
        self.hydration = None;
        if draft.validate_only {
            return Ok(
                json!({"hydrationTransaction": true, "committed": false, "valid": true, "projectId": project_id, "projectRevision": project_revision}),
            );
        }
        self.world = candidate;
        self.project_id = Some(project_id.clone());
        self.project_revision = Some(project_revision);
        self.render_state = render_state;
        let (queued_assets, deferred_assets) = self.submit_asset_ids(&asset_ids);
        let mut result = self.snapshot_value(snapshot, &Value::Null)?;
        if let Some(object) = result.as_object_mut() {
            object.insert("hydrationTransaction".into(), json!(true));
            object.insert("projectId".into(), json!(project_id));
            object.insert("projectRevision".into(), json!(project_revision));
            object.insert("assetJobsQueued".into(), json!(queued_assets));
            object.insert("assetJobsDeferred".into(), json!(deferred_assets));
        }
        Ok(result)
    }

    fn abort_hydration(&mut self) -> Result<Value, String> {
        let active = self.hydration.take().is_some();
        Ok(json!({"hydrationTransaction": true, "aborted": active, "active": false}))
    }

    fn hydrate_world(&mut self, params: &Value) -> Result<Value, String> {
        let (project_id, project_revision, entities, asset_ids, render_state) =
            project_candidate(params)?;
        let mut candidate = NativeWorld::new();
        let snapshot = candidate
            .hydrate(project_revision, entities)
            .map_err(world_error_message)?;
        self.world = candidate;
        self.project_id = Some(project_id.clone());
        self.project_revision = Some(project_revision);
        self.render_state = render_state;
        let (queued_assets, deferred_assets) = self.submit_asset_ids(&asset_ids);
        let mut result = self.snapshot_value(snapshot, params)?;
        if let Some(object) = result.as_object_mut() {
            object.insert("projectId".into(), json!(project_id));
            object.insert("projectRevision".into(), json!(project_revision));
            object.insert("replayHash".into(), json!(self.world.replay_hash()));
            object.insert("assetJobsQueued".into(), json!(queued_assets));
            object.insert("assetJobsDeferred".into(), json!(deferred_assets));
        }
        Ok(result)
    }

    fn close_project(&mut self) -> Result<Value, String> {
        self.world = NativeWorld::new();
        self.project_id = None;
        self.project_revision = None;
        self.render_state = ProjectRenderState::default();
        for cancellation in self.asset_jobs.values() {
            cancellation.cancel();
        }
        self.asset_jobs.clear();
        self.pending_asset_ids.clear();
        self.world_snapshot(&Value::Null)
    }

    fn submit_asset_ids(&mut self, asset_ids: &[String]) -> (usize, usize) {
        self.pending_asset_ids.extend(asset_ids.iter().cloned());
        self.retry_pending_asset_jobs()
    }

    fn retry_pending_asset_jobs(&mut self) -> (usize, usize) {
        let Some(cooker) = self.cooker.as_ref() else {
            return (0, self.pending_asset_ids.len());
        };
        let mut queued = 0;
        let mut failed = 0;
        for source_id in self.pending_asset_ids.clone() {
            match cooker.submit_deferred(&source_id) {
                Ok(submission) => {
                    self.asset_jobs
                        .insert(submission.job_id, submission.cancellation);
                    self.pending_asset_ids.remove(&source_id);
                    queued += 1;
                }
                Err(error) if error.code == "queue_full" => break,
                Err(_) => {
                    self.pending_asset_ids.remove(&source_id);
                    failed += 1;
                }
            }
        }
        (queued, self.pending_asset_ids.len() + failed)
    }

    fn reap_asset_jobs(&mut self) {
        let Some(cooker) = self.cooker.as_ref() else {
            self.asset_jobs.clear();
            return;
        };
        let finished = self
            .asset_jobs
            .keys()
            .copied()
            .filter(|job_id| {
                cooker.status(*job_id).is_some_and(|status| {
                    matches!(
                        status.state,
                        auvra_native::assets::JobState::Completed
                            | auvra_native::assets::JobState::Failed
                            | auvra_native::assets::JobState::Cancelled
                    )
                })
            })
            .collect::<Vec<_>>();
        for job_id in finished {
            self.asset_jobs.remove(&job_id);
        }
    }

    fn advance_world(&mut self, params: &Value) -> Result<Value, String> {
        let object = params.as_object();
        let workers = object
            .and_then(|v| v.get("workers"))
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .min(64) as usize;
        let report =
            if let Some(steps) = object.and_then(|v| v.get("steps")).and_then(Value::as_u64) {
                self.world
                    .advance_steps(steps.min(u64::from(u32::MAX)) as u32, workers)
            } else {
                let elapsed = object
                    .and_then(|v| v.get("elapsedNanos"))
                    .and_then(Value::as_u64)
                    .ok_or("elapsedNanos or steps is required")?;
                self.world.advance_frame(elapsed, workers)
            }
            .map_err(|e| e.to_string())?;
        serde_json::to_value(report).map_err(|e| e.to_string())
    }

    fn replay_snapshot(&self) -> Result<Value, String> {
        serde_json::to_value(self.world.replay_snapshot()).map_err(|e| e.to_string())
    }

    fn recover_renderer(&mut self) -> Result<Value, String> {
        self.renderer = Renderer::new()?;
        let extraction = self.build_extraction(&Value::Null)?;
        let viewport_reopened = if let Some(viewport) = self.viewport.as_mut() {
            viewport.recover(&mut self.renderer, &extraction)?;
            true
        } else {
            false
        };
        Ok(
            json!({"recovered": true, "viewport_reopened": viewport_reopened, "capabilities": self.renderer.capabilities(), "world_revision": self.world.revision()}),
        )
    }

    fn submit_asset(&mut self, params: &Value) -> Result<Value, String> {
        let source_id = params
            .as_object()
            .and_then(|v| v.get("sourceId"))
            .and_then(Value::as_str)
            .ok_or("sourceId is required")?;
        let cooker = self
            .cooker
            .as_ref()
            .ok_or("asset cooker roots are not configured")?;
        let submission = cooker.submit(source_id).map_err(|e| e.to_string())?;
        self.asset_jobs
            .insert(submission.job_id, submission.cancellation);
        Ok(json!({"jobId": submission.job_id, "sourceId": source_id, "state": "Queued"}))
    }

    fn asset_status(&self, params: &Value) -> Result<Value, String> {
        let job_id = params
            .as_object()
            .and_then(|v| v.get("jobId"))
            .and_then(Value::as_u64)
            .ok_or("jobId is required")?;
        let status = self
            .cooker
            .as_ref()
            .and_then(|cooker| cooker.status(job_id))
            .ok_or("asset job not found")?;
        serde_json::to_value(status).map_err(|e| e.to_string())
    }

    fn cancel_asset(&mut self, params: &Value) -> Result<Value, String> {
        let job_id = params
            .as_object()
            .and_then(|v| v.get("jobId"))
            .and_then(Value::as_u64)
            .ok_or("jobId is required")?;
        let token = self.asset_jobs.get(&job_id).ok_or("asset job not found")?;
        token.cancel();
        Ok(json!({"jobId": job_id, "cancelled": true}))
    }

    fn render_extract(&self, params: &Value) -> Result<Value, String> {
        let extraction = self.build_extraction(params)?;
        serde_json::to_value(extraction).map_err(|e| e.to_string())
    }

    fn build_extraction(&self, params: &Value) -> Result<RenderExtraction, String> {
        let snapshot = self.world.snapshot();
        let render_entities = snapshot
            .entities
            .iter()
            .filter_map(|entity| {
                if entity
                    .render
                    .as_ref()
                    .is_some_and(|render| !render.visible)
                    || self
                        .render_state
                        .object_visibility
                        .get(&entity.id)
                        .is_some_and(|visible| !visible)
                {
                    return None;
                }
                let asset_hash = entity
                    .render
                    .as_ref()
                    .and_then(|render| render.asset_hash.as_deref());
                let material_id = self
                    .render_state
                    .object_materials
                    .get(&entity.id)
                    .copied()
                    .unwrap_or(1);
                let material = self
                    .render_state
                    .materials
                    .get(&material_id)
                    .copied()
                    .unwrap_or(MaterialReference {
                        material_id,
                        base_color_factor: entity
                            .color
                            .map(|value| value.clamp(0.0, 1.0) as f32),
                        metallic: 0.0,
                        roughness: 1.0,
                        base_color_texture: asset_hash
                            .and_then(|asset| self.render_state.model_base_color_textures.get(asset))
                            .copied(),
                        normal_texture: None,
                        metallic_roughness_texture: None,
                    });
                Some(WorldRenderEntity {
                    id: stable_id(&entity.id),
                    mesh_id: asset_hash.map(stable_id).unwrap_or(1),
                    position: entity.position.map(|value| value as f32),
                    rotation: entity.rotation.map(|value| value as f32),
                    scale: entity.scale.map(|value| value as f32),
                    radius: self
                        .render_state
                        .object_radii
                        .get(&entity.id)
                        .copied()
                        .unwrap_or(1.0),
                    material,
                    lods: self
                        .render_state
                        .object_lods
                        .get(&entity.id)
                        .cloned()
                        .unwrap_or_else(|| {
                            vec![LodLevel {
                                level: 0,
                                max_distance: f32::MAX,
                            }]
                        }),
                    animation: self
                        .render_state
                        .object_animations
                        .get(&entity.id)
                        .copied()
                        .or_else(|| entity.animation.as_ref().map(world_animation_input)),
                    selected: self.render_state.object_selected.contains(&entity.id),
                })
            })
            .collect();
        let mut lights = self.render_state.lights.clone();
        lights.extend(snapshot.entities.iter().filter_map(|entity| {
            entity
                .light
                .as_ref()
                .and_then(|light| world_light_input(&entity.id, entity.position, light))
        }));
        let mut input = WorldRenderInput {
            world_revision: snapshot.revision,
            fixed_tick: snapshot.tick,
            camera_position: self.render_state.camera_position,
            frustum: wide_frustum(),
            entities: render_entities,
            lights,
            ibl: self.render_state.ibl,
            post_effects: self.render_state.post_effects.clone(),
            msaa_samples: params
                .as_object()
                .and_then(|v| v.get("msaaSamples"))
                .and_then(Value::as_u64)
                .unwrap_or(u64::from(self.render_state.msaa_samples))
                .min(16) as u8,
            fxaa: params
                .as_object()
                .and_then(|v| v.get("fxaa"))
                .and_then(Value::as_bool)
                .unwrap_or(self.render_state.fxaa),
        };
        if params
            .as_object()
            .and_then(|value| value.get("sceneId"))
            .and_then(Value::as_str)
            .unwrap_or("")
            == "basic"
        {
            input = reference_input(snapshot.revision, snapshot.tick);
        }
        extract_render_world(&input, gpu::capabilities()).map_err(|e| e.to_string())
    }

    fn open_viewport(&mut self, params: &Value) -> Result<Value, String> {
        if let Some(viewport) = &self.viewport {
            return Ok(
                json!({"open": true, "alreadyOpen": true, "width": viewport.width, "height": viewport.height, "ownership": "separate-native-surface", "dockSupport": "unsupported", "dockActive": false, "dockReason": "same-build-native-parenting-gate-not-passed"}),
            );
        }
        let object = params.as_object();
        if let Some(parent_handle) = object.and_then(|v| v.get("parentHandle")) {
            if parent_handle.as_u64().is_none() || parent_handle.as_u64() == Some(0) {
                return Err("invalid_request|viewport parent handle is invalid".into());
            }
        }
        let width = object
            .and_then(|v| v.get("width"))
            .and_then(Value::as_u64)
            .unwrap_or(640);
        let height = object
            .and_then(|v| v.get("height"))
            .and_then(Value::as_u64)
            .unwrap_or(480);
        let title = object
            .and_then(|v| v.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("Auvra Native Viewport")
            .to_string();
        if !(320..=4096).contains(&width)
            || !(240..=4096).contains(&height)
            || title.is_empty()
            || title.len() > 256
        {
            return Err("invalid viewport dimensions or title".into());
        }
        let extraction = self.build_extraction(&Value::Null)?;
        self.viewport = Some(Viewport::open(
            &mut self.renderer,
            width as u32,
            height as u32,
            title,
            &extraction,
        )?);
        Ok(
            json!({"open": true, "alreadyOpen": false, "width": width, "height": height, "ownership": "separate-native-surface", "dockSupport": "unsupported", "dockActive": false, "dockReason": "same-build-native-parenting-gate-not-passed"}),
        )
    }
}

fn world_error_message(error: auvra_native::world::WorldError) -> String {
    match error {
        auvra_native::world::WorldError::RevisionConflict { expected, actual } => format!(
            "revision_conflict|expected revision {expected}, current revision is {actual}|expected={expected}|actual={actual}"
        ),
        other => format!("invalid_project|{other}"),
    }
}

fn project_candidate(
    params: &Value,
) -> Result<(String, u64, Vec<Entity>, Vec<String>, ProjectRenderState), String> {
    let object = params
        .as_object()
        .ok_or("invalid_project|project hydration must be an object")?;
    let project_id = object
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or("invalid_project|projectId is required")?;
    if project_id.is_empty()
        || project_id.len() > 128
        || !project_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:".contains(&byte))
    {
        return Err("invalid_project|projectId is invalid".into());
    }
    let project_revision = object
        .get("projectRevision")
        .and_then(Value::as_u64)
        .ok_or("invalid_project|projectRevision is required")?;
    let domains = object
        .get("domains")
        .and_then(Value::as_object)
        .ok_or("invalid_project|domains are required")?;
    let mut documents = serde_json::Map::new();
    for (domain, value) in domains {
        if domain.len() > 128
            || !domain
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err("invalid_project|domain name is invalid".into());
        }
        let domain_object = value
            .as_object()
            .ok_or("invalid_project|domain must be an object")?;
        match domain_object.get("schemaVersion").and_then(Value::as_u64) {
            Some(1) => (),
            Some(_) => {
                return Err(
                    "unsupported_version|project domain schema version is unsupported".into(),
                );
            }
            None => return Err("invalid_project|domain schemaVersion is required".into()),
        }
        let docs = domain_object
            .get("documents")
            .and_then(Value::as_array)
            .ok_or("invalid_project|domain documents are required")?;
        if docs.len() > 16_384 {
            return Err("invalid_project|domain document limit exceeded".into());
        }
        documents.insert(domain.clone(), Value::Array(docs.clone()));
    }
    let models = documents
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut model_assets = std::collections::BTreeMap::<String, String>::new();
    for model in models {
        let model = model
            .as_object()
            .ok_or("invalid_project|model document is invalid")?;
        let id = model
            .get("id")
            .and_then(Value::as_str)
            .ok_or("invalid_project|model id is required")?;
        let asset_id = model
            .get("assetId")
            .and_then(Value::as_str)
            .ok_or("invalid_project|model assetId is required")?;
        if asset_id.len() != 64
            || !asset_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("invalid_project|model assetId is invalid".into());
        }
        model_assets.insert(id.into(), asset_id.into());
    }
    let objects = documents
        .get("objects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let level_ids = documents
        .get("levels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect::<std::collections::BTreeSet<_>>();
    let mut entities = Vec::with_capacity(objects.len());
    let mut ids = std::collections::BTreeSet::new();
    for value in objects {
        let value = value
            .as_object()
            .ok_or("invalid_project|object document is invalid")?;
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .ok_or("invalid_project|object id is required")?;
        if !ids.insert(id.to_string()) {
            return Err("invalid_project|duplicate object id".into());
        }
        let level_id = value
            .get("levelId")
            .and_then(Value::as_str)
            .ok_or("invalid_project|object levelId is required")?;
        if !level_ids.contains(level_id) {
            return Err("invalid_project|object references a missing level".into());
        }
        let position = vector3(value.get("position"), [0.0, 0.0, 0.0])?;
        let rotation = vector4(value.get("rotation"), [0.0, 0.0, 0.0, 1.0])?;
        let scale = vector3(value.get("scale"), [1.0, 1.0, 1.0])?;
        let color = vector4(value.get("color"), [0.7, 0.7, 0.7, 1.0])?;
        let render = if let Some(model_id) = value.get("modelId").and_then(Value::as_str) {
            let asset_hash = model_assets
                .get(model_id)
                .ok_or("invalid_project|object references a missing model")?;
            Some(auvra_native::world::RenderData {
                asset_hash: Some(asset_hash.clone()),
                visible: true,
                cast_shadow: true,
                receive_shadow: true,
                layer: 0,
            })
        } else {
            None
        };
        entities.push(Entity {
            id: id.into(),
            position,
            color,
            generation: 0,
            rotation,
            scale,
            velocity: [0.0; 3],
            render,
            light: None,
            animation: None,
        });
    }
    let render_state = project_render_state(&documents, &model_assets)?;
    let mut asset_ids = std::collections::BTreeSet::new();
    if let Some(values) = object.get("assetIds").and_then(Value::as_array) {
        for value in values {
            let asset_id = value
                .as_str()
                .ok_or("invalid_project|assetIds must contain strings")?;
            if asset_id.len() != 64
                || !asset_id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err("invalid_project|assetId is invalid".into());
            }
            asset_ids.insert(asset_id.to_string());
        }
    }
    asset_ids.extend(model_assets.into_values());
    Ok((
        project_id.into(),
        project_revision,
        entities,
        asset_ids.into_iter().collect(),
        render_state,
    ))
}

fn project_render_state(
    documents: &serde_json::Map<String, Value>,
    _model_assets: &BTreeMap<String, String>,
) -> Result<ProjectRenderState, String> {
    let mut state = ProjectRenderState::default();
    let mut animations = BTreeMap::<String, AnimationInput>::new();

    for document in domain_values(documents, "animations") {
        let object = document
            .as_object()
            .ok_or("invalid_project|animation document is invalid")?;
        let id = required_string(object, "id", "animation id")?;
        let duration_ticks = optional_u64(object, "durationTicks")
            .or_else(|| optional_u64(object, "duration"))
            .unwrap_or(1)
            .max(1);
        let speed_numerator = optional_u64(object, "speedNumerator")
            .unwrap_or(1)
            .min(u64::from(u32::MAX)) as u32;
        let speed_denominator = optional_u64(object, "speedDenominator")
            .unwrap_or(1)
            .min(u64::from(u32::MAX)) as u32;
        if speed_numerator == 0 || speed_denominator == 0 {
            return Err("invalid_project|animation speed must be positive".into());
        }
        let looped = object
            .get("looped")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        animations.insert(
            id.to_owned(),
            AnimationInput {
                clip_id: stable_id(id),
                duration_ticks,
                speed_numerator,
                speed_denominator,
                looped,
            },
        );
    }

    for document in domain_values(documents, "materials") {
        let object = document
            .as_object()
            .ok_or("invalid_project|material document is invalid")?;
        let id = required_string(object, "id", "material id")?;
        let base_color_factor = fixed_vec4(
            object
                .get("baseColorFactor")
                .or_else(|| object.get("baseColor")),
            [0.7, 0.7, 0.7, 1.0],
            "material baseColorFactor",
        )?;
        let metallic = optional_f32(object, "metallic")?.unwrap_or(0.0);
        let roughness = optional_f32(object, "roughness")?.unwrap_or(1.0);
        if !(0.0..=1.0).contains(&metallic) || !(0.0..=1.0).contains(&roughness) {
            return Err("invalid_project|material metallic/roughness is out of range".into());
        }
        let texture_ids = object
            .get("textureIds")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(stable_id)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let base_color_texture = string_handle(
            object
                .get("baseColorTexture")
                .or_else(|| object.get("baseColorTextureId")),
        )?
        .or_else(|| texture_ids.first().copied());
        let normal_texture = string_handle(
            object
                .get("normalTexture")
                .or_else(|| object.get("normalTextureId")),
        )?;
        let metallic_roughness_texture = string_handle(
            object
                .get("metallicRoughnessTexture")
                .or_else(|| object.get("metallicRoughnessTextureId")),
        )?;
        state.materials.insert(
            stable_id(id),
            MaterialReference {
                material_id: stable_id(id),
                base_color_factor,
                metallic,
                roughness,
                base_color_texture,
                normal_texture,
                metallic_roughness_texture,
            },
        );
    }

    for document in domain_values(documents, "models") {
        let object = document
            .as_object()
            .ok_or("invalid_project|model document is invalid")?;
        let _model_id = required_string(object, "id", "model id")?;
        let asset_id = required_string(object, "assetId", "model assetId")?;
        if let Some(texture_id) = object
            .get("textureOverrides")
            .and_then(Value::as_object)
            .and_then(|overrides| overrides.values().find_map(Value::as_str))
        {
            state
                .model_base_color_textures
                .insert(asset_id.to_owned(), stable_id(texture_id));
        }
    }

    for document in domain_values(documents, "objects") {
        let object = document
            .as_object()
            .ok_or("invalid_project|object document is invalid")?;
        let id = required_string(object, "id", "object id")?;
        if let Some(material_id) = object
            .get("materialId")
            .or_else(|| object.get("material"))
            .and_then(Value::as_str)
        {
            state
                .object_materials
                .insert(id.to_owned(), stable_id(material_id));
        } else if let Some(material) = object.get("material").and_then(Value::as_object) {
            let material_id = material
                .get("id")
                .and_then(Value::as_str)
                .map(stable_id)
                .unwrap_or_else(|| stable_id(&format!("object-material:{id}")));
            state.materials.insert(
                material_id,
                material_reference(material, material_id)?,
            );
            state.object_materials.insert(id.to_owned(), material_id);
        }
        if let Some(render) = object.get("render").and_then(Value::as_object) {
            if let Some(visible) = render.get("visible").and_then(Value::as_bool) {
                state.object_visibility.insert(id.to_owned(), visible);
            }
            if let Some(radius) = render.get("radius") {
                state.object_radii.insert(id.to_owned(), bounded_radius(radius)?);
            }
            if render
                .get("selected")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                state.object_selected.insert(id.to_owned());
            }
            if let Some(lods) = render.get("lods") {
                state.object_lods.insert(id.to_owned(), parse_lods(lods)?);
            }
        }
        if let Some(radius) = object.get("radius") {
            state.object_radii.insert(id.to_owned(), bounded_radius(radius)?);
        }
        if object
            .get("selected")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            state.object_selected.insert(id.to_owned());
        }
        if let Some(lods) = object.get("lods") {
            state.object_lods.insert(id.to_owned(), parse_lods(lods)?);
        }
        if let Some(animation_id) = object.get("animationId").and_then(Value::as_str) {
            if let Some(animation) = animations.get(animation_id) {
                state.object_animations.insert(id.to_owned(), *animation);
            }
        } else if let Some(animation) = object.get("animation").and_then(Value::as_object) {
            state
                .object_animations
                .insert(id.to_owned(), animation_input(animation, &format!("object {id} animation"))?);
        }
    }

    let mut lights = BTreeMap::new();
    for domain in ["worlds", "scenes", "levels", "environment", "lights"] {
        for (index, document) in domain_values(documents, domain).into_iter().enumerate() {
            if domain == "lights"
                && document
                    .get("kind")
                    .or_else(|| document.get("type"))
                    .and_then(Value::as_str)
                    .is_some()
            {
                let light = parse_render_light(document, index)?;
                lights.insert(light.id, light);
            } else {
                collect_render_settings(document, &mut state, &mut lights)?;
            }
        }
    }
    state.lights = lights.into_values().collect();
    Ok(state)
}

fn domain_values<'a>(documents: &'a serde_json::Map<String, Value>, domain: &str) -> Vec<&'a Value> {
    documents
        .get(domain)
        .and_then(Value::as_array)
        .map(|values| values.iter().collect())
        .unwrap_or_default()
}

fn required_string<'a>(object: &'a serde_json::Map<String, Value>, key: &str, label: &str) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("invalid_project|{label} is required"))
}

fn optional_u64(object: &serde_json::Map<String, Value>, key: &str) -> Option<u64> {
    object.get(key).and_then(Value::as_u64)
}

fn optional_f32(object: &serde_json::Map<String, Value>, key: &str) -> Result<Option<f32>, String> {
    object
        .get(key)
        .map(|value| finite_f32(value, key).map(Some))
        .unwrap_or(Ok(None))
}

fn finite_f32(value: &Value, label: &str) -> Result<f32, String> {
    let number = value
        .as_f64()
        .ok_or_else(|| format!("invalid_project|{label} must be numeric"))?;
    if !number.is_finite() || number.abs() > f64::from(f32::MAX) {
        return Err(format!("invalid_project|{label} is not finite"));
    }
    Ok(number as f32)
}

fn fixed_vec3(value: Option<&Value>, default: [f32; 3], label: &str) -> Result<[f32; 3], String> {
    let Some(value) = value else {
        return Ok(default);
    };
    if let Some(values) = value.as_array() {
        if values.len() != 3 {
            return Err(format!("invalid_project|{label} must contain three values"));
        }
        return Ok([
            finite_f32(&values[0], label)?,
            finite_f32(&values[1], label)?,
            finite_f32(&values[2], label)?,
        ]);
    }
    let object = value
        .as_object()
        .ok_or_else(|| format!("invalid_project|{label} is invalid"))?;
    Ok([
        finite_f32(object.get("x").ok_or_else(|| format!("invalid_project|{label}.x is required"))?, label)?,
        finite_f32(object.get("y").ok_or_else(|| format!("invalid_project|{label}.y is required"))?, label)?,
        finite_f32(object.get("z").ok_or_else(|| format!("invalid_project|{label}.z is required"))?, label)?,
    ])
}

fn fixed_vec4(value: Option<&Value>, default: [f32; 4], label: &str) -> Result<[f32; 4], String> {
    let Some(value) = value else {
        return Ok(default);
    };
    let values = value
        .as_array()
        .ok_or_else(|| format!("invalid_project|{label} is invalid"))?;
    if values.len() != 4 {
        return Err(format!("invalid_project|{label} must contain four values"));
    }
    Ok([
        finite_f32(&values[0], label)?,
        finite_f32(&values[1], label)?,
        finite_f32(&values[2], label)?,
        finite_f32(&values[3], label)?,
    ])
}

fn string_handle(value: Option<&Value>) -> Result<Option<u64>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    if let Some(id) = value.as_str() {
        return Ok(Some(stable_id(id)));
    }
    value
        .as_u64()
        .filter(|id| *id > 0)
        .map(Some)
        .ok_or("invalid_project|renderer asset handle is invalid".into())
}

fn material_reference(
    object: &serde_json::Map<String, Value>,
    material_id: u64,
) -> Result<MaterialReference, String> {
    let base_color_factor = fixed_vec4(
        object
            .get("baseColorFactor")
            .or_else(|| object.get("baseColor")),
        [0.7, 0.7, 0.7, 1.0],
        "material baseColorFactor",
    )?;
    let metallic = object
        .get("metallic")
        .map(|value| finite_f32(value, "material metallic"))
        .transpose()?
        .unwrap_or(0.0);
    let roughness = object
        .get("roughness")
        .map(|value| finite_f32(value, "material roughness"))
        .transpose()?
        .unwrap_or(1.0);
    if !(0.0..=1.0).contains(&metallic) || !(0.0..=1.0).contains(&roughness) {
        return Err("invalid_project|material metallic/roughness is out of range".into());
    }
    Ok(MaterialReference {
        material_id,
        base_color_factor,
        metallic,
        roughness,
        base_color_texture: string_handle(
            object
                .get("baseColorTexture")
                .or_else(|| object.get("baseColorTextureId")),
        )?,
        normal_texture: string_handle(
            object
                .get("normalTexture")
                .or_else(|| object.get("normalTextureId")),
        )?,
        metallic_roughness_texture: string_handle(
            object
                .get("metallicRoughnessTexture")
                .or_else(|| object.get("metallicRoughnessTextureId")),
        )?,
    })
}

fn bounded_radius(value: &Value) -> Result<f32, String> {
    let radius = finite_f32(value, "object radius")?;
    if !(0.0..=1_000_000.0).contains(&radius) {
        return Err("invalid_project|object radius is out of range".into());
    }
    Ok(radius)
}

fn parse_lods(value: &Value) -> Result<Vec<LodLevel>, String> {
    let values = value
        .as_array()
        .ok_or("invalid_project|object LODs must be an array")?;
    if values.is_empty() || values.len() > 8 {
        return Err("invalid_project|object LOD count is out of range".into());
    }
    let mut result = Vec::with_capacity(values.len());
    for value in values {
        let object = value
            .as_object()
            .ok_or("invalid_project|object LOD is invalid")?;
        let level = object
            .get("level")
            .and_then(Value::as_u64)
            .filter(|level| *level <= u64::from(u8::MAX))
            .ok_or("invalid_project|object LOD level is invalid")?;
        let max_distance = object
            .get("maxDistance")
            .map(|value| finite_f32(value, "object LOD maxDistance"))
            .transpose()?
            .unwrap_or(f32::MAX);
        if max_distance < 0.0 {
            return Err("invalid_project|object LOD maxDistance is invalid".into());
        }
        result.push(LodLevel {
            level: level as u8,
            max_distance,
        });
    }
    Ok(result)
}

fn animation_input(
    object: &serde_json::Map<String, Value>,
    label: &str,
) -> Result<AnimationInput, String> {
    let clip_id = object
        .get("clipId")
        .or_else(|| object.get("id"))
        .and_then(Value::as_str)
        .map(stable_id)
        .unwrap_or_else(|| stable_id(label));
    let duration_ticks = object
        .get("durationTicks")
        .and_then(Value::as_u64)
        .or_else(|| object.get("duration").and_then(Value::as_u64))
        .unwrap_or(1)
        .max(1);
    let speed_numerator = object
        .get("speedNumerator")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .min(u64::from(u32::MAX)) as u32;
    let speed_denominator = object
        .get("speedDenominator")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .min(u64::from(u32::MAX)) as u32;
    if speed_numerator == 0 || speed_denominator == 0 {
        return Err(format!("invalid_project|{label} speed must be positive"));
    }
    Ok(AnimationInput {
        clip_id,
        duration_ticks,
        speed_numerator,
        speed_denominator,
        looped: object
            .get("looped")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    })
}

fn collect_render_settings(
    value: &Value,
    state: &mut ProjectRenderState,
    lights: &mut BTreeMap<u64, WorldRenderLight>,
) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    apply_render_settings(object, state, lights)?;
    for key in ["settings", "lighting", "render", "camera"] {
        if let Some(nested) = object.get(key).and_then(Value::as_object) {
            apply_render_settings(nested, state, lights)?;
        }
    }
    Ok(())
}

fn apply_render_settings(
    object: &serde_json::Map<String, Value>,
    state: &mut ProjectRenderState,
    lights: &mut BTreeMap<u64, WorldRenderLight>,
) -> Result<(), String> {
    if let Some(camera) = object.get("camera").and_then(Value::as_object) {
        if let Some(position) = camera.get("position") {
            state.camera_position = fixed_vec3(Some(position), state.camera_position, "camera position")?;
        }
    }
    if let Some(position) = object.get("cameraPosition") {
        state.camera_position = fixed_vec3(Some(position), state.camera_position, "camera position")?;
    }
    if let Some(ibl) = object.get("ibl").and_then(Value::as_object) {
        let environment_id = string_handle(ibl.get("environmentId"))?;
        let irradiance_id = string_handle(ibl.get("irradianceId"))?;
        let prefiltered_id = string_handle(ibl.get("prefilteredId"))?;
        let brdf_lut_id = string_handle(ibl.get("brdfLutId").or_else(|| ibl.get("brdfLUTId")))?;
        if let (Some(environment_id), Some(irradiance_id), Some(prefiltered_id), Some(brdf_lut_id)) =
            (environment_id, irradiance_id, prefiltered_id, brdf_lut_id)
        {
            state.ibl = Some(IblInput {
                environment_id,
                irradiance_id,
                prefiltered_id,
                brdf_lut_id,
            });
        }
    }
    if let Some(effects) = object.get("postEffects").and_then(Value::as_array) {
        for effect in effects {
            let name = effect
                .as_str()
                .or_else(|| effect.get("type").and_then(Value::as_str))
                .unwrap_or_default()
                .to_ascii_lowercase();
            let parsed = match name.as_str() {
                "bloom" => Some(PostEffect::Bloom),
                "colorgrading" | "color_grading" | "color-grading" => {
                    Some(PostEffect::ColorGrading)
                }
                "vignette" => Some(PostEffect::Vignette),
                "sharpen" => Some(PostEffect::Sharpen),
                "fxaa" => Some(PostEffect::Fxaa),
                _ => None,
            };
            if let Some(effect) = parsed {
                if !state.post_effects.contains(&effect) {
                    state.post_effects.push(effect);
                }
            }
        }
    }
    if let Some(samples) = object.get("msaaSamples").and_then(Value::as_u64) {
        if samples > 16 || samples != 0 && !samples.is_power_of_two() {
            return Err("invalid_project|MSAA sample count is invalid".into());
        }
        state.msaa_samples = samples as u8;
    }
    if let Some(fxaa) = object.get("fxaa").and_then(Value::as_bool) {
        state.fxaa = fxaa;
    }
    if let Some(values) = object.get("lights").and_then(Value::as_array) {
        for (index, value) in values.iter().enumerate() {
            let light = parse_render_light(value, index)?;
            lights.insert(light.id, light);
        }
    }
    Ok(())
}

fn parse_render_light(value: &Value, index: usize) -> Result<WorldRenderLight, String> {
    let object = value
        .as_object()
        .ok_or("invalid_project|render light is invalid")?;
    let fallback = format!("project-light-{index}");
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .map(stable_id)
        .unwrap_or_else(|| stable_id(&fallback));
    let kind_name = object
        .get("kind")
        .or_else(|| object.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("directional")
        .to_ascii_lowercase();
    let kind = match kind_name.as_str() {
        "directional" | "directional_light" | "directionallight" => LightKind::Directional,
        "point" | "point_light" | "pointlight" => LightKind::Point,
        "spot" | "spot_light" | "spotlight" => LightKind::Spot,
        _ => return Err("invalid_project|render light kind is unsupported".into()),
    };
    let position = fixed_vec3(object.get("position"), [0.0, 0.0, 0.0], "render light position")?;
    let direction = fixed_vec3(object.get("direction"), [0.0, -1.0, 0.0], "render light direction")?;
    let range = object
        .get("range")
        .map(|value| finite_f32(value, "render light range"))
        .transpose()?
        .unwrap_or(if matches!(kind, LightKind::Directional) { 0.0 } else { 10.0 });
    let inner_angle = object
        .get("spotInnerAngle")
        .or_else(|| object.get("spot_inner_angle"))
        .map(|value| finite_f32(value, "render light inner angle"))
        .transpose()?
        .unwrap_or(0.0);
    let outer_angle = object
        .get("spotOuterAngle")
        .or_else(|| object.get("spot_outer_angle"))
        .map(|value| finite_f32(value, "render light outer angle"))
        .transpose()?
        .unwrap_or(std::f32::consts::FRAC_PI_4);
    if range < 0.0 || inner_angle < 0.0 || outer_angle < inner_angle || outer_angle > std::f32::consts::PI {
        return Err("invalid_project|render light values are out of range".into());
    }
    Ok(WorldRenderLight {
        id,
        kind,
        position,
        direction,
        range,
        spot_inner_cos: inner_angle.cos(),
        spot_outer_cos: outer_angle.cos(),
        casts_shadow: object
            .get("castsShadow")
            .or_else(|| object.get("castShadow"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn world_light_input(
    entity_id: &str,
    position: [f64; 3],
    light: &auvra_native::world::LightData,
) -> Option<WorldRenderLight> {
    let kind = match light.kind.as_str() {
        "directional" => LightKind::Directional,
        "point" => LightKind::Point,
        "spot" => LightKind::Spot,
        _ => return None,
    };
    Some(WorldRenderLight {
        id: stable_id(&format!("entity-light:{entity_id}")),
        kind,
        position: position.map(|value| value as f32),
        direction: [0.0, -1.0, 0.0],
        range: light.range as f32,
        spot_inner_cos: light.spot_inner_angle.cos() as f32,
        spot_outer_cos: light.spot_outer_angle.cos() as f32,
        casts_shadow: true,
    })
}

fn world_animation_input(animation: &auvra_native::world::AnimationData) -> AnimationInput {
    AnimationInput {
        clip_id: stable_id(&animation.clip),
        duration_ticks: 1,
        speed_numerator: (animation.speed.abs().round() as u64)
            .max(1)
            .min(u64::from(u32::MAX)) as u32,
        speed_denominator: 1,
        looped: animation.looping,
    }
}

fn vector3(value: Option<&Value>, default: [f64; 3]) -> Result<[f64; 3], String> {
    let Some(value) = value else {
        return Ok(default);
    };
    if let Some(array) = value.as_array() {
        if array.len() != 3 {
            return Err("invalid_project|vector3 must have three values".into());
        }
        return Ok([
            array[0]
                .as_f64()
                .ok_or("invalid_project|vector3 value is invalid")?,
            array[1]
                .as_f64()
                .ok_or("invalid_project|vector3 value is invalid")?,
            array[2]
                .as_f64()
                .ok_or("invalid_project|vector3 value is invalid")?,
        ]);
    }
    let map = value
        .as_object()
        .ok_or("invalid_project|vector3 is invalid")?;
    Ok([
        map.get("x")
            .and_then(Value::as_f64)
            .ok_or("invalid_project|vector3 x is invalid")?,
        map.get("y")
            .and_then(Value::as_f64)
            .ok_or("invalid_project|vector3 y is invalid")?,
        map.get("z")
            .and_then(Value::as_f64)
            .ok_or("invalid_project|vector3 z is invalid")?,
    ])
}

fn vector4(value: Option<&Value>, default: [f64; 4]) -> Result<[f64; 4], String> {
    let Some(value) = value else {
        return Ok(default);
    };
    let array = value
        .as_array()
        .ok_or("invalid_project|vector4 is invalid")?;
    if array.len() != 4 {
        return Err("invalid_project|vector4 must have four values".into());
    }
    Ok([
        array[0]
            .as_f64()
            .ok_or("invalid_project|vector4 value is invalid")?,
        array[1]
            .as_f64()
            .ok_or("invalid_project|vector4 value is invalid")?,
        array[2]
            .as_f64()
            .ok_or("invalid_project|vector4 value is invalid")?,
        array[3]
            .as_f64()
            .ok_or("invalid_project|vector4 value is invalid")?,
    ])
}
fn stable_id(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash.max(1)
}
fn wide_frustum() -> Frustum {
    Frustum {
        planes: [Plane {
            normal: [1.0, 0.0, 0.0],
            distance: 1_000_000_000.0,
        }; 6],
    }
}
fn reference_input(revision: u64, tick: u64) -> WorldRenderInput {
    let material = |id| MaterialReference {
        material_id: id,
        base_color_factor: [0.35, 0.58, 0.82, 1.0],
        metallic: 0.35,
        roughness: 0.55,
        base_color_texture: None,
        normal_texture: None,
        metallic_roughness_texture: None,
    };
    let entity = |id, position, selected| WorldRenderEntity {
        id,
        mesh_id: 7,
        position,
        rotation: [0.0, 0.0, 0.0, 1.0],
        scale: [1.0, 1.0, 1.0],
        radius: 0.35,
        material: material(3),
        lods: vec![
            LodLevel {
                level: 0,
                max_distance: 2.0,
            },
            LodLevel {
                level: 1,
                max_distance: 40.0,
            },
        ],
        animation: Some(AnimationInput {
            clip_id: 11,
            duration_ticks: 120,
            speed_numerator: 1,
            speed_denominator: 1,
            looped: true,
        }),
        selected,
    };
    WorldRenderInput {
        world_revision: revision,
        fixed_tick: tick,
        camera_position: [0.0, 0.0, 2.0],
        frustum: wide_frustum(),
        entities: vec![
            entity(1, [-0.4, 0.0, 0.0], true),
            entity(2, [0.0, 0.2, 0.0], false),
            entity(3, [0.4, -0.1, 0.0], false),
        ],
        lights: vec![
            WorldRenderLight {
                id: 21,
                kind: LightKind::Directional,
                position: [0.0, 2.0, 2.0],
                direction: [-0.3, -1.0, -0.2],
                range: 0.0,
                spot_inner_cos: 1.0,
                spot_outer_cos: 1.0,
                casts_shadow: true,
            },
            WorldRenderLight {
                id: 22,
                kind: LightKind::Point,
                position: [1.0, 1.0, 1.0],
                direction: [0.0, -1.0, 0.0],
                range: 10.0,
                spot_inner_cos: 1.0,
                spot_outer_cos: 1.0,
                casts_shadow: true,
            },
            WorldRenderLight {
                id: 23,
                kind: LightKind::Spot,
                position: [-1.0, 1.0, 1.0],
                direction: [0.0, -1.0, 0.0],
                range: 8.0,
                spot_inner_cos: 0.9,
                spot_outer_cos: 0.7,
                casts_shadow: false,
            },
        ],
        ibl: Some(IblInput {
            environment_id: 31,
            irradiance_id: 32,
            prefiltered_id: 33,
            brdf_lut_id: 34,
        }),
        post_effects: vec![
            PostEffect::Bloom,
            PostEffect::ColorGrading,
            PostEffect::Vignette,
            PostEffect::Sharpen,
            PostEffect::Fxaa,
        ],
        msaa_samples: 4,
        fxaa: true,
    }
}

fn run_ipc() -> Result<(), String> {
    let mut app = App::new()?;
    diagnostic("info", "native.ready", None, None);
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let (sender, receiver) = mpsc::channel::<Result<Option<Vec<u8>>, String>>();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        loop {
            let result = read_frame(&mut input);
            let finished = matches!(&result, Ok(None) | Err(_));
            if sender.send(result).is_err() || finished {
                break;
            }
        }
    });
    run_ipc_live_loop(&mut app, &receiver, &mut output)
}

fn pump_viewport(app: &mut App) -> Result<(), String> {
    if app.viewport.is_none() {
        return Ok(());
    }
    let extraction = app.build_extraction(&Value::Null)?;
    let mut viewport = app
        .viewport
        .take()
        .ok_or("viewport disappeared during event pump")?;
    let still_open = viewport.pump_events(&mut app.renderer, &extraction)?;
    if still_open {
        app.viewport = Some(viewport);
    }
    Ok(())
}

fn dispatch_ipc_frame(
    app: &mut App,
    bytes: Vec<u8>,
    output: &mut impl Write,
) -> Result<bool, String> {
    let mut req: Request =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid request schema: {e}"))?;
    let method = req.method.clone();
    let diagnostic_context = take_diagnostic_context(&mut req.params);
    let trace = NativeTraceGuard::begin(&method, req.id, diagnostic_context);
    let result = app.dispatch(req);
    match result {
        Ok(resp) => {
            let response_ok = resp.ok;
            let write_outcome = match write_response(output, &resp) {
                Ok(outcome) => outcome,
                Err(error) => {
                    trace.finish(false);
                    diagnostic(
                        "error",
                        "native.protocol_failed",
                        Some(&method),
                        Some("fatal_protocol_error"),
                    );
                    return Err(format!("fatal response write error: {error}"));
                }
            };
            trace.finish(write_outcome.operation_succeeded(response_ok));
            Ok(method == "shutdown")
        }
        Err(_error) => {
            trace.finish(false);
            diagnostic(
                "error",
                "native.protocol_failed",
                Some(&method),
                Some("fatal_protocol_error"),
            );
            Err("fatal protocol error".into())
        }
    }
}

fn run_ipc_live_loop(
    app: &mut App,
    receiver: &mpsc::Receiver<Result<Option<Vec<u8>>, String>>,
    output: &mut impl Write,
) -> Result<(), String> {
    loop {
        if app.viewport.is_some() {
            pump_viewport(app)?;
        }
        let next = if app.viewport.is_some() {
            receiver.recv_timeout(Duration::from_millis(16))
        } else {
            match receiver.recv() {
                Ok(value) => Ok(value),
                Err(_) => Err(mpsc::RecvTimeoutError::Disconnected),
            }
        };
        let bytes = match next {
            Ok(Ok(Some(bytes))) => bytes,
            Ok(Ok(None)) => {
                diagnostic("info", "native.eof", None, None);
                return Ok(());
            }
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("native input channel disconnected".into());
            }
        };
        if dispatch_ipc_frame(app, bytes, output)? {
            diagnostic("info", "native.stopped", Some("shutdown"), None);
            return Ok(());
        }
    }
}

fn run_ipc_loop(
    app: &mut App,
    input: &mut impl Read,
    output: &mut impl Write,
) -> Result<(), String> {
    loop {
        let Some(bytes) = read_frame(input)? else {
            diagnostic("info", "native.eof", None, None);
            return Ok(());
        };
        let shutdown = dispatch_ipc_frame(app, bytes, output)?;
        if !shutdown {
            pump_viewport(app)?;
        } else {
            diagnostic("info", "native.stopped", Some("shutdown"), None);
            return Ok(());
        }
    }
}

fn run_self_test() -> Result<(), String> {
    let started = Instant::now();
    let mut app = App::new()?;
    let token = std::env::var("AUVRA_NATIVE_SESSION_TOKEN")
        .map_err(|_| "session token is unavailable for self-test")?;
    let challenge = "0000000000000000000000000000000000000000000000000000000000000001";
    let hello = app.dispatch(Request {
        id: 1,
        protocol: PROTOCOL.into(),
        method: "session.hello".into(),
        params: json!({
            "editorSession": "self-test",
            "challenge": challenge,
            "proof": session_proof(&token, challenge, "self-test"),
        }),
    })?;
    let applied = app.dispatch(Request { id: 2, protocol: PROTOCOL.into(), method: "world.apply".into(), params: json!({"expectedRevision": 0, "entities": [{"id":"reference","position":[1.25,-0.5,0.0],"color":[0.2,0.6,1.0,1.0]}]}) })?;
    let rendered = app.dispatch(Request {
        id: 3,
        protocol: PROTOCOL.into(),
        method: "renderer.renderReference".into(),
        params: json!({"width": 96, "height": 80}),
    })?;
    let cached = app.dispatch(Request {
        id: 4,
        protocol: PROTOCOL.into(),
        method: "renderer.renderReference".into(),
        params: json!({"width": 96, "height": 80}),
    })?;
    let opened = app.dispatch(Request {
        id: 5,
        protocol: PROTOCOL.into(),
        method: "viewport.open".into(),
        params: json!({"width": 320, "height": 240, "title": "Auvra Stage 8 Self-Test"}),
    })?;
    let recovered = app.dispatch(Request {
        id: 6,
        protocol: PROTOCOL.into(),
        method: "renderer.recover".into(),
        params: Value::Null,
    })?;
    let closed = app.dispatch(Request {
        id: 7,
        protocol: PROTOCOL.into(),
        method: "viewport.close".into(),
        params: Value::Null,
    })?;
    let stopped = app.dispatch(Request {
        id: 8,
        protocol: PROTOCOL.into(),
        method: "shutdown".into(),
        params: Value::Null,
    })?;
    let cache_hit = cached
        .result
        .as_ref()
        .and_then(|v| v.get("pipeline_cache_hits"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        >= 1;
    let viewport_reopened = recovered
        .result
        .as_ref()
        .and_then(|v| v.get("viewport_reopened"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let clean_shutdown = stopped.ok
        && stopped
            .result
            .as_ref()
            .and_then(|v| v.get("stopped"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
    if !(hello.ok
        && applied.ok
        && rendered.ok
        && cached.ok
        && cache_hit
        && opened.ok
        && recovered.ok
        && viewport_reopened
        && closed.ok
        && clean_shutdown
        && app.world.revision() == 1)
    {
        return Err("native self-test acceptance failed".into());
    }
    let evidence = json!({"probe": "auvra-native-self-test", "protocol": PROTOCOL, "hello_ok": hello.ok, "world_apply_ok": applied.ok, "world_revision": app.world.revision(), "reference_render_ok": rendered.ok, "reference": rendered.result, "pipeline_cache_hit": cache_hit, "viewport_open_ok": opened.ok, "recovery_ok": recovered.ok, "viewport_reopened": viewport_reopened, "viewport_close_ok": closed.ok, "clean_shutdown": clean_shutdown, "elapsed_ms": started.elapsed().as_secs_f64() * 1000.0});
    println!(
        "{}",
        serde_json::to_string(&evidence).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn run_headless_self_test() -> Result<(), String> {
    let started = Instant::now();
    let mut app = App::new()?;
    let token = std::env::var("AUVRA_NATIVE_SESSION_TOKEN")
        .map_err(|_| "session token is unavailable for self-test")?;
    let challenge = "0000000000000000000000000000000000000000000000000000000000000002";
    let hello = app.dispatch(Request {
        id: 1,
        protocol: PROTOCOL.into(),
        method: "session.hello".into(),
        params: json!({
            "editorSession": "headless-self-test",
            "challenge": challenge,
            "proof": session_proof(&token, challenge, "headless-self-test"),
        }),
    })?;
    let asset_id = "0000000000000000000000000000000000000000000000000000000000000000";
    let hydrated = app.dispatch(Request { id: 2, protocol: PROTOCOL.into(), method: "world.hydrate".into(), params: json!({"projectId":"headless-reference","projectRevision":7,"domains":{"objects":{"schemaVersion":1,"documents":[{"id":"reference","levelId":"level","modelId":"model","name":"Reference","type":"mesh","position":[0.0,0.0,0.0],"color":[0.2,0.6,1.0,1.0]}]},"models":{"schemaVersion":1,"documents":[{"id":"model","name":"Reference","assetId":asset_id}]},"levels":{"schemaVersion":1,"documents":[{"id":"level"}]}},"assetIds":[]}) })?;
    let advanced = app.dispatch(Request {
        id: 3,
        protocol: PROTOCOL.into(),
        method: "world.advance".into(),
        params: json!({"steps":2,"workers":2}),
    })?;
    let extracted = app.dispatch(Request {
        id: 4,
        protocol: PROTOCOL.into(),
        method: "renderer.extract".into(),
        params: Value::Null,
    })?;
    let rendered = app.dispatch(Request {
        id: 5,
        protocol: PROTOCOL.into(),
        method: "renderer.renderReference".into(),
        params: json!({"sceneId":"basic","width":32,"height":32}),
    })?;
    let replay = app
        .world
        .replay_from_hydration(2)
        .map_err(world_error_message)?;
    let replay_matches = replay.world_hash == app.world.snapshot().world_hash;
    let rendered_twice = app.dispatch(Request {
        id: 6,
        protocol: PROTOCOL.into(),
        method: "renderer.renderReference".into(),
        params: json!({"sceneId":"basic","width":32,"height":32}),
    })?;
    let render_matches = rendered
        .result
        .as_ref()
        .and_then(|value| value.get("signature"))
        == rendered_twice
            .result
            .as_ref()
            .and_then(|value| value.get("signature"))
        && rendered
            .result
            .as_ref()
            .and_then(|value| value.get("extractionHash"))
            == rendered_twice
                .result
                .as_ref()
                .and_then(|value| value.get("extractionHash"));
    let cook_root = std::env::temp_dir().join(format!(
        "auvra-headless-cook-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos()
    ));
    let source_root = cook_root.join("source");
    let derived_root = cook_root.join("derived");
    std::fs::create_dir_all(&source_root).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&derived_root).map_err(|error| error.to_string())?;
    let cook_asset_id = "7e3669e2c7c58ec4cfd8a3c7dfefe4a21169789217f071c703c057753ffcea66";
    std::fs::write(
        source_root.join(cook_asset_id),
        br#"{"asset":{"version":"2.0"},"buffers":[],"meshes":[],"nodes":[],"scenes":[]}"#,
    )
    .map_err(|error| error.to_string())?;
    let cook_config = CookConfig::new(&source_root, &derived_root);
    let cooked_once = cook_source(&cook_config, cook_asset_id, &CancellationToken::new())
        .map_err(|error| error.to_string())?;
    let cooked_twice = cook_source(&cook_config, cook_asset_id, &CancellationToken::new())
        .map_err(|error| error.to_string())?;
    let cook_matches = cooked_once.artifact_sha256 == cooked_twice.artifact_sha256
        && cooked_once.artifact_size == cooked_twice.artifact_size
        && serde_json::to_vec(&cooked_once.manifest).map_err(|error| error.to_string())?
            == serde_json::to_vec(&cooked_twice.manifest).map_err(|error| error.to_string())?;
    let cook_artifact_id = cooked_once.artifact_sha256.clone();
    std::fs::remove_dir_all(&cook_root).map_err(|error| error.to_string())?;
    let closed = app.dispatch(Request {
        id: 7,
        protocol: PROTOCOL.into(),
        method: "world.closeProject".into(),
        params: Value::Null,
    })?;
    let close_idempotent = app.dispatch(Request {
        id: 8,
        protocol: PROTOCOL.into(),
        method: "world.closeProject".into(),
        params: Value::Null,
    })?;
    let closed_ok = closed.ok
        && close_idempotent.ok
        && closed
            .result
            .as_ref()
            .and_then(|value| value.get("projectId"))
            .map(Value::is_null)
            .unwrap_or(false);
    if !(hello.ok
        && hydrated.ok
        && advanced.ok
        && extracted.ok
        && rendered.ok
        && rendered_twice.ok
        && render_matches
        && replay_matches
        && cook_matches
        && closed_ok)
    {
        return Err("headless native self-test acceptance failed".into());
    }
    let evidence = json!({"probe":"auvra-native-headless-self-test","protocol":PROTOCOL,"hello_ok":hello.ok,"hydration_ok":hydrated.ok,"advance_ok":advanced.ok,"extraction_ok":extracted.ok,"reference_render_ok":rendered.ok,"reference_render_repeat_ok":rendered_twice.ok,"reference_deterministic":render_matches,"replay_matches":replay_matches,"cook_ok":cook_matches,"cook_artifact_sha256":cook_artifact_id,"close_project_ok":closed_ok,"world_revision":app.world.revision(),"world_tick":app.world.tick(),"world_hash":app.world.snapshot().world_hash,"replay_hash":app.world.replay_hash(),"backend":format!("{:?}", app.renderer.info.backend),"adapter":app.renderer.info.name,"reference":rendered.result,"elapsed_ms":started.elapsed().as_secs_f64()*1000.0});
    println!(
        "{}",
        serde_json::to_string(&evidence).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn main() {
    match std::env::var("AUVRA_NATIVE_SESSION_TOKEN") {
        Ok(token) if valid_session_token(&token) => (),
        _ => {
            diagnostic(
                "error",
                "native.configuration_failed",
                None,
                Some("invalid_session_token"),
            );
            std::process::exit(2);
        }
    };
    let result = if std::env::args().any(|arg| arg == "--headless-self-test") {
        run_headless_self_test()
    } else if std::env::args().any(|arg| arg == "--self-test") {
        run_self_test()
    } else {
        run_ipc()
    };
    if let Err(_error) = result {
        diagnostic("error", "native.fatal", None, Some("fatal_error"));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_trace_span_ids_include_request_identity() {
        let context = DiagnosticContext {
            trace_id: Some("trace-repeat".into()),
            span_id: Some("parent-span".into()),
            ..DiagnosticContext::default()
        };
        let first = NativeTraceGuard::begin("world.getReplay", 41, context.clone());
        let first_id = first.trace.span_id.clone();
        first.finish(true);
        let second = NativeTraceGuard::begin("world.getReplay", 42, context);
        let second_id = second.trace.span_id.clone();
        second.finish(true);
        assert_ne!(first_id, second_id);
    }

    #[test]
    fn session_hello_rejects_missing_or_invalid_proof() {
        let mut app = App::new().unwrap();
        let response = app
            .dispatch(Request {
                id: 1,
                protocol: PROTOCOL.into(),
                method: "session.hello".into(),
                params: json!({
                    "editorSession": "test",
                    "challenge": "0000000000000000000000000000000000000000000000000000000000000001",
                    "proof": "0000000000000000000000000000000000000000000000000000000000000000",
                }),
            })
            .unwrap();
        assert!(!response.ok);
        assert_eq!(
            response.error.as_ref().map(|error| error.code),
            Some("authentication_failed")
        );
        assert!(!app.authenticated);
    }

    #[test]
    fn oversized_replay_response_is_bounded_and_followup_still_writes() {
        let mut app = App::new().unwrap();
        app.authenticated = true;
        let entities = (0..1024)
            .map(|index| Entity {
                id: format!("entity-{index:04}"),
                position: [0.0, 0.0, 0.0],
                color: [0.7, 0.7, 0.7, 1.0],
                generation: 0,
                rotation: [0.0, 0.0, 0.0, 1.0],
                scale: [1.0, 1.0, 1.0],
                velocity: [0.0, 0.0, 0.0],
                render: None,
                light: None,
                animation: None,
            })
            .collect();
        app.world.hydrate(0, entities).unwrap();
        assert!(
            serde_json::to_vec(&app.world.replay_snapshot())
                .unwrap()
                .len()
                > MAX_FRAME
        );

        let mut input = Vec::new();
        for (id, method) in [
            (41, "world.getReplay"),
            (42, "world.getSnapshot"),
            (43, "shutdown"),
        ] {
            let body = serde_json::to_vec(&json!({
                "id": id,
                "protocol": PROTOCOL,
                "method": method,
                "params": {},
            }))
            .unwrap();
            input.extend_from_slice(&(body.len() as u32).to_be_bytes());
            input.extend_from_slice(&body);
        }
        let mut output = Vec::new();
        run_ipc_loop(&mut app, &mut input.as_slice(), &mut output).unwrap();

        let first_length = u32::from_be_bytes(output[0..4].try_into().unwrap()) as usize;
        assert!(first_length <= MAX_FRAME);
        let first: Value = serde_json::from_slice(&output[4..4 + first_length]).unwrap();
        assert_eq!(first.get("id").and_then(Value::as_u64), Some(41));
        assert_eq!(first.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            first
                .get("error")
                .and_then(|error| error.get("code"))
                .and_then(Value::as_str),
            Some("operation_failed")
        );

        let second_start = 4 + first_length;
        let second_length =
            u32::from_be_bytes(output[second_start..second_start + 4].try_into().unwrap()) as usize;
        assert!(second_length <= MAX_FRAME);
        let second: Value =
            serde_json::from_slice(&output[second_start + 4..second_start + 4 + second_length])
                .unwrap();
        assert_eq!(second.get("id").and_then(Value::as_u64), Some(42));
        assert_eq!(second.get("ok").and_then(Value::as_bool), Some(true));

        let third_start = second_start + 4 + second_length;
        let third_length =
            u32::from_be_bytes(output[third_start..third_start + 4].try_into().unwrap()) as usize;
        let third: Value =
            serde_json::from_slice(&output[third_start + 4..third_start + 4 + third_length])
                .unwrap();
        assert_eq!(third.get("id").and_then(Value::as_u64), Some(43));
        assert_eq!(third.get("ok").and_then(Value::as_bool), Some(true));
    }

    fn project_payload() -> Value {
        json!({"projectId":"test-project","projectRevision":4,"domains":{"levels":{"schemaVersion":1,"documents":[{"id":"level"}]},"models":{"schemaVersion":1,"documents":[{"id":"model","name":"Model","assetId":"0000000000000000000000000000000000000000000000000000000000000000"}]},"objects":{"schemaVersion":1,"documents":[{"id":"object","levelId":"level","modelId":"model","name":"Object","type":"mesh","position":[1.0,2.0,3.0]}]}}})
    }

    #[test]
    fn project_domains_map_deterministically_to_native_entities() {
        let first = project_candidate(&project_payload()).unwrap();
        let second = project_candidate(&project_payload()).unwrap();
        assert_eq!(first.0, "test-project");
        assert_eq!(first.1, 4);
        assert_eq!(first.2, second.2);
        assert_eq!(first.2.len(), 1);
        assert_eq!(
            first.2[0]
                .render
                .as_ref()
                .and_then(|render| render.asset_hash.as_deref()),
            Some("0000000000000000000000000000000000000000000000000000000000000000")
        );
    }

    #[test]
    fn project_render_domains_survive_native_extraction() {
        let asset = "0000000000000000000000000000000000000000000000000000000000000000";
        let payload = json!({
            "projectId": "render-project",
            "projectRevision": 9,
            "domains": {
                "worlds": {"schemaVersion": 1, "documents": []},
                "levels": {"schemaVersion": 1, "documents": [{
                    "id": "level",
                    "cameraPosition": [1.0, 2.0, 3.0],
                    "lights": [{"id": "key", "kind": "directional", "direction": [0.0, -1.0, 0.0], "castsShadow": true}],
                    "postEffects": ["bloom", "vignette"],
                    "msaaSamples": 4,
                    "fxaa": true,
                    "ibl": {"environmentId": "environment", "irradianceId": "irradiance", "prefilteredId": "prefiltered", "brdfLutId": "brdf"}
                }]},
                "models": {"schemaVersion": 1, "documents": [{"id": "model", "name": "Model", "assetId": asset, "textureOverrides": {"Body": "albedo"}}]},
                "animations": {"schemaVersion": 1, "documents": [{"id": "run", "name": "Run", "assetId": asset, "modelId": "model", "durationTicks": 120, "speedNumerator": 2, "speedDenominator": 1, "looped": true}]},
                "materials": {"schemaVersion": 1, "documents": [{"id": "red", "name": "Red", "baseColorFactor": [1.0, 0.1, 0.1, 1.0], "metallic": 0.8, "roughness": 0.25}]},
                "objects": {"schemaVersion": 1, "documents": [{"id": "object", "levelId": "level", "modelId": "model", "name": "Object", "type": "mesh", "position": [0.0, 0.0, 0.5], "materialId": "red", "radius": 2.0, "lods": [{"level": 0, "maxDistance": 4.0}, {"level": 1, "maxDistance": 40.0}], "animationId": "run", "selected": true}]}
            }
        });
        let mut app = App::new().unwrap();
        app.authenticated = true;
        let response = app
            .dispatch(Request { id: 1, protocol: PROTOCOL.into(), method: "world.hydrate".into(), params: payload })
            .unwrap();
        assert!(response.ok);
        let extraction = app.build_extraction(&Value::Null).unwrap();
        let entity = &extraction.snapshot.entities[0];
        assert_eq!(entity.material.material_id, stable_id("red"));
        assert_eq!(entity.material.base_color_factor, [1.0, 0.1, 0.1, 1.0]);
        assert_eq!(entity.material.base_color_texture, None);
        assert_eq!(entity.lod, 0);
        assert_eq!(entity.animation.unwrap().clip_id, stable_id("run"));
        assert_eq!(extraction.snapshot.lights.len(), 1);
        assert_eq!(extraction.snapshot.post_effects.as_ref(), &[PostEffect::Bloom, PostEffect::Vignette]);
        assert_eq!(extraction.snapshot.msaa_samples, 4);
        assert!(extraction.snapshot.fxaa);
        assert_eq!(extraction.snapshot.ibl.unwrap().environment_id, stable_id("environment"));
        assert_eq!(extraction.snapshot.gizmos.len(), 1);
    }

    #[test]
    fn hydration_candidate_rejects_without_mutating_an_existing_world() {
        let world = NativeWorld::new();
        let before = world.snapshot();
        let invalid = json!({"projectId":"test","projectRevision":1,"domains":{"objects":{"schemaVersion":2,"documents":[]}}});
        assert!(project_candidate(&invalid).is_err());
        assert_eq!(world.snapshot(), before);
    }

    #[test]
    fn revision_errors_preserve_machine_readable_details() {
        let response = App::operation_error_response(
            9,
            "revision_conflict|expected revision 2, current revision is 7|expected=2|actual=7",
        );
        let details = response.error.unwrap().details.unwrap();
        assert_eq!(details.get("expected").and_then(Value::as_u64), Some(2));
        assert_eq!(details.get("actual").and_then(Value::as_u64), Some(7));
    }

    #[test]
    fn paged_hydration_is_atomic_and_validate_only_does_not_mutate() {
        let mut app = App::new().unwrap();
        app.authenticated = true;
        let begin = app
            .dispatch(Request {
                id: 1,
                protocol: PROTOCOL.into(),
                method: "world.beginHydration".into(),
                params: json!({"projectId":"paged","projectRevision":3}),
            })
            .unwrap();
        assert!(
            begin.ok
                && begin
                    .result
                    .as_ref()
                    .and_then(|value| value.get("hydrationTransaction"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        );
        let empty = app
            .dispatch(Request {
                id: 2,
                protocol: PROTOCOL.into(),
                method: "world.appendHydration".into(),
                params: json!({"domain":"levels","schemaVersion":1,"documents":[]}),
            })
            .unwrap();
        assert!(empty.ok);
        let pages = [
            json!({"domain":"levels","schemaVersion":1,"documents":[{"id":"level"}]}),
            json!({"domain":"models","schemaVersion":1,"documents":[{"id":"model","assetId":"0000000000000000000000000000000000000000000000000000000000000000"}]}),
            json!({"domain":"objects","schemaVersion":1,"documents":[{"id":"object","levelId":"level","modelId":"model"}]}),
        ];
        for (index, page) in pages.into_iter().enumerate() {
            let response = app
                .dispatch(Request {
                    id: index as u64 + 3,
                    protocol: PROTOCOL.into(),
                    method: "world.appendHydration".into(),
                    params: page,
                })
                .unwrap();
            assert!(response.ok);
        }
        let committed = app
            .dispatch(Request {
                id: 6,
                protocol: PROTOCOL.into(),
                method: "world.commitHydration".into(),
                params: Value::Null,
            })
            .unwrap();
        assert!(committed.ok);
        assert_eq!(app.project_id.as_deref(), Some("paged"));
        assert_eq!(app.world.snapshot().entities.len(), 1);
        let before = app.world.snapshot();
        app.dispatch(Request {
            id: 7,
            protocol: PROTOCOL.into(),
            method: "world.beginHydration".into(),
            params: json!({"projectId":"check","projectRevision":1,"validateOnly":true}),
        })
        .unwrap();
        app.dispatch(Request {
            id: 8,
            protocol: PROTOCOL.into(),
            method: "world.appendHydration".into(),
            params: json!({"domain":"levels","schemaVersion":1,"documents":[]}),
        })
        .unwrap();
        let validation = app
            .dispatch(Request {
                id: 9,
                protocol: PROTOCOL.into(),
                method: "world.commitHydration".into(),
                params: Value::Null,
            })
            .unwrap();
        assert!(
            validation.ok
                && validation
                    .result
                    .as_ref()
                    .and_then(|value| value.get("committed"))
                    .and_then(Value::as_bool)
                    == Some(false)
        );
        assert_eq!(app.world.snapshot(), before);
        assert!(
            app.dispatch(Request {
                id: 10,
                protocol: PROTOCOL.into(),
                method: "world.abortHydration".into(),
                params: Value::Null
            })
            .unwrap()
            .ok
        );
    }

    #[test]
    fn hydration_asset_submission_does_not_drop_queue_tail() {
        let root = std::env::temp_dir().join(format!("auvra-main-deferred-{}", std::process::id()));
        let derived = root.join("derived");
        std::fs::create_dir_all(&root).unwrap();
        let mut app = App::new().unwrap();
        app.cooker = Some(
            CookWorker::new(CookConfig::new(&root, &derived).with_queue_capacity(1)).unwrap(),
        );
        let ids = (0..32)
            .map(|index| format!("{index:064x}"))
            .collect::<Vec<_>>();
        let (queued, deferred) = app.submit_asset_ids(&ids);
        assert_eq!(queued, ids.len());
        assert_eq!(deferred, 0);
        assert!(app.pending_asset_ids.is_empty());
        drop(app);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn closing_project_cancels_and_releases_asset_tokens() {
        let root = std::env::temp_dir().join(format!("auvra-main-close-assets-{}", std::process::id()));
        let derived = root.join("derived");
        std::fs::create_dir_all(&root).unwrap();
        let mut app = App::new().unwrap();
        app.cooker = Some(
            CookWorker::new(CookConfig::new(&root, &derived).with_queue_capacity(1)).unwrap(),
        );
        let submission = app.cooker.as_ref().unwrap().submit_deferred(&format!("{:064x}", 1)).unwrap();
        let cancellation = submission.cancellation.clone();
        app.asset_jobs.insert(submission.job_id, submission.cancellation);
        app.close_project().unwrap();
        assert!(cancellation.is_cancelled());
        assert!(app.asset_jobs.is_empty());
        assert!(app.pending_asset_ids.is_empty());
        drop(app);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn terminal_asset_tokens_are_reaped_from_app_bookkeeping() {
        let root = std::env::temp_dir().join(format!("auvra-main-reap-assets-{}", std::process::id()));
        let derived = root.join("derived");
        std::fs::create_dir_all(&root).unwrap();
        let mut app = App::new().unwrap();
        app.cooker = Some(CookWorker::new(CookConfig::new(&root, &derived)).unwrap());
        let submission = app.cooker.as_ref().unwrap().submit(&format!("{:064x}", 2)).unwrap();
        app.asset_jobs.insert(submission.job_id, submission.cancellation);
        for _ in 0..100 {
            if app.cooker.as_ref().unwrap().status(submission.job_id).is_some_and(|status| {
                matches!(
                    status.state,
                    auvra_native::assets::JobState::Completed
                        | auvra_native::assets::JobState::Failed
                        | auvra_native::assets::JobState::Cancelled
                )
            }) {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        app.reap_asset_jobs();
        assert!(!app.asset_jobs.contains_key(&submission.job_id));
        drop(app);
        let _ = std::fs::remove_dir_all(root);
    }
}
