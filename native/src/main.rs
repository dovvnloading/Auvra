use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::sync::Arc;
use std::time::Instant;
use winit::{event_loop::EventLoop, platform::run_on_demand::EventLoopExtRunOnDemand, window::Window};

const MAX_FRAME: usize = 64 * 1024;
const PROTOCOL: &str = "auvra.native/1";

#[derive(Debug, Serialize)]
struct Diagnostic<'a> {
    event: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

fn diagnostic(event: &'static str, method: Option<&str>, detail: Option<String>) {
    let line = serde_json::to_string(&Diagnostic { event, method, detail }).unwrap_or_else(|_| "{\"event\":\"diagnostic_failure\"}".to_string());
    eprintln!("{line}");
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
}

fn response(id: u64, result: Value) -> Response {
    Response { id, protocol: PROTOCOL, ok: true, result: Some(result), error: None }
}

fn error_response(id: u64, code: &'static str, message: impl Into<String>) -> Response {
    Response { id, protocol: PROTOCOL, ok: false, result: None, error: Some(ErrorBody { code, message: message.into() }) }
}

fn read_frame(input: &mut impl Read) -> Result<Option<Vec<u8>>, String> {
    let mut header = [0_u8; 4];
    let mut read = 0;
    while read < 4 {
        let count = input.read(&mut header[read..]).map_err(|e| e.to_string())?;
        if count == 0 {
            return if read == 0 { Ok(None) } else { Err("truncated length prefix".into()) };
        }
        read += count;
    }
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(format!("frame length {length} exceeds 64 KiB protocol limit"));
    }
    let mut body = vec![0_u8; length];
    input.read_exact(&mut body).map_err(|e| format!("truncated frame: {e}"))?;
    Ok(Some(body))
}

fn write_frame(output: &mut impl Write, value: &impl Serialize) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if body.is_empty() || body.len() > MAX_FRAME {
        return Err("response exceeds 64 KiB protocol limit".into());
    }
    output.write_all(&(body.len() as u32).to_be_bytes()).map_err(|e| e.to_string())?;
    output.write_all(&body).map_err(|e| e.to_string())?;
    output.flush().map_err(|e| e.to_string())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Entity {
    id: String,
    position: [f64; 3],
    color: [f64; 4],
}

#[derive(Debug, Serialize)]
struct WorldSnapshot {
    revision: u64,
    entities: Vec<Entity>,
}

#[derive(Debug)]
struct World {
    revision: u64,
    entities: Vec<Entity>,
}

impl World {
    fn new() -> Self {
        Self { revision: 0, entities: vec![Entity { id: "reference".into(), position: [0.0, 0.0, 0.0], color: [0.2, 0.6, 1.0, 1.0] }] }
    }

    fn snapshot(&self) -> WorldSnapshot {
        WorldSnapshot { revision: self.revision, entities: self.entities.clone() }
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
    pipeline_key: String,
    gpu_timing_supported: bool,
    gpu_timing_fallback: Option<String>,
    reference_bind_layout: Option<wgpu::BindGroupLayout>,
    reference_pipeline: Option<wgpu::RenderPipeline>,
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
            force_fallback_adapter: false,
            apply_limit_buckets: false,
        })).map_err(|e| format!("adapter request failed: {e:?}"))?;
        let info = adapter.get_info();
        let available = adapter.features();
        let gpu_timing_supported = available.contains(wgpu::Features::TIMESTAMP_QUERY) && available.contains(wgpu::Features::TIMESTAMP_QUERY_INSIDE_PASSES);
        let required_features = if gpu_timing_supported { wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_PASSES } else { wgpu::Features::empty() };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("auvra-native-device"),
            required_features,
            required_limits: wgpu::Limits::downlevel_defaults(),
            experimental_features: wgpu::ExperimentalFeatures::disabled(),
            memory_hints: wgpu::MemoryHints::Performance,
            trace: wgpu::Trace::Off,
        })).map_err(|e| format!("device request failed: {e:?}"))?;
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
            pipeline_key: "reference-v1|rgba8unorm-srgb|triangle|procedural-lit-texture".into(),
            gpu_timing_supported,
            gpu_timing_fallback: (!gpu_timing_supported).then(|| "timestamp_query_unavailable_cpu_submit".into()),
            reference_bind_layout: None,
            reference_pipeline: None,
            pipeline_cache_hits: 0,
            pipeline_cache_misses: 0,
        })
    }

    fn capabilities(&self) -> Value {
        json!({"backend": format!("{:?}", self.info.backend), "adapter": self.info.name, "device_type": format!("{:?}", self.info.device_type), "driver": self.info.driver, "format": format!("{:?}", self.format), "gpu_timing": {"supported": self.gpu_timing_supported, "fallback": self.gpu_timing_fallback}, "pipeline_cache_key": self.pipeline_key, "pipeline_cache_hits": self.pipeline_cache_hits, "pipeline_cache_misses": self.pipeline_cache_misses})
    }

    fn reference_pipeline(&mut self) -> (wgpu::BindGroupLayout, wgpu::RenderPipeline) {
        if let (Some(layout), Some(pipeline)) = (&self.reference_bind_layout, &self.reference_pipeline) {
            self.pipeline_cache_hits += 1;
            return (layout.clone(), pipeline.clone());
        }
        let shader = self.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("auvra-reference-wgsl"), source: wgpu::ShaderSource::Wgsl(r#"
            struct Light { time: f32, intensity: f32, tint: f32, alpha: f32 }
            @group(0) @binding(0) var<uniform> light: Light;
            @group(0) @binding(1) var tex: texture_2d<f32>;
            @group(0) @binding(2) var samp: sampler;
            struct Out { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) normal: vec3<f32> }
            @vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
                var p = array<vec2<f32>, 3>(vec2(-0.8,-0.8), vec2(0.0,0.8), vec2(0.8,-0.8));
                var uv = array<vec2<f32>, 3>(vec2(0.0,1.0), vec2(0.5,0.0), vec2(1.0,1.0));
                var o: Out; o.position = vec4(p[i], 0.0, 1.0); o.uv = uv[i]; o.normal = normalize(vec3(0.0, 0.0, 1.0)); return o;
            }
            @fragment fn fs(i: Out) -> @location(0) vec4<f32> {
                let base = textureSample(tex, samp, i.uv); let lit = max(dot(i.normal, normalize(vec3(0.3,0.4,1.0))), 0.0) * light.intensity;
                return vec4(base.rgb * (0.25 + lit) * vec3(light.time + 0.7, light.tint + 0.4, 1.0), 1.0);
            }
        "#.into()) });
        let layout = self.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("auvra-reference-bind-layout"), entries: &[
            wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
            wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
            wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
        ] });
        let pipeline_layout = self.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("auvra-reference-pipeline-layout"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let pipeline = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor { label: Some("auvra-reference-pipeline"), layout: Some(&pipeline_layout), vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() }, fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some("fs"), targets: &[Some(wgpu::ColorTargetState { format: self.format, blend: Some(wgpu::BlendState::REPLACE), write_mask: wgpu::ColorWrites::ALL })], compilation_options: Default::default() }), primitive: wgpu::PrimitiveState::default(), depth_stencil: None, multisample: wgpu::MultisampleState::default(), multiview_mask: None, cache: None });
        self.pipeline_cache_misses += 1;
        self.reference_bind_layout = Some(layout.clone());
        self.reference_pipeline = Some(pipeline.clone());
        (layout, pipeline)
    }

    fn render_reference(&mut self, params: &Value) -> Result<Value, String> {
        let (width, height) = dimensions(params)?;
        let width = width;
        let height = height;
        let frame_started = Instant::now();
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("auvra-reference-target"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let texture_data: [u8; 16] = [220, 35, 30, 255, 35, 220, 40, 255, 35, 70, 220, 255, 220, 220, 40, 255];
        let source_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("auvra-reference-procedural-texture"),
            size: wgpu::Extent3d { width: 2, height: 2, depth_or_array_layers: 1 },
            mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        self.queue.write_texture(wgpu::TexelCopyTextureInfo { texture: &source_texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }, &texture_data, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(8), rows_per_image: Some(2) }, wgpu::Extent3d { width: 2, height: 2, depth_or_array_layers: 1 });
        let source_view = source_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor { label: Some("auvra-reference-sampler"), mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
        let uniform_data: [u8; 16] = [205, 204, 76, 62, 0, 0, 128, 63, 205, 204, 76, 62, 154, 153, 153, 63];
        let uniform = self.device.create_buffer(&wgpu::BufferDescriptor { label: Some("auvra-reference-light-uniform"), size: 16, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        self.queue.write_buffer(&uniform, 0, &uniform_data);
        let (bind_layout, pipeline) = self.reference_pipeline();
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("auvra-reference-bind-group"), layout: &bind_layout, entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&source_view) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&sampler) },
        ] });
        let bytes_per_row = wgpu::util::align_to(width * 4, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let pixel_bytes = u64::from(bytes_per_row) * u64::from(height);
        let timestamp_offset = pixel_bytes;
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor { label: Some("auvra-reference-readback"), size: pixel_bytes + 16, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        let timestamp_readback = self.gpu_timing_supported.then(|| self.device.create_buffer(&wgpu::BufferDescriptor { label: Some("auvra-reference-timestamp-resolve"), size: 16, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false }));
        let query_set = self.gpu_timing_supported.then(|| self.device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("auvra-reference-gpu-timestamps"), ty: wgpu::QueryType::Timestamp, count: 2 }));
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("auvra-reference-command-encoder") });
        { let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("auvra-reference-pass"), color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.02, g: 0.04, b: 0.08, a: 1.0 }), store: wgpu::StoreOp::Store } })], depth_stencil_attachment: None, occlusion_query_set: None, timestamp_writes: query_set.as_ref().map(|q| wgpu::RenderPassTimestampWrites { query_set: q, beginning_of_pass_write_index: Some(0), end_of_pass_write_index: Some(1) }), multiview_mask: None }); pass.set_pipeline(&pipeline); pass.set_bind_group(0, &bind_group, &[]); pass.draw(0..3, 0..1); }
        encoder.copy_texture_to_buffer(wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }, wgpu::TexelCopyBufferInfo { buffer: &readback, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bytes_per_row), rows_per_image: Some(height) } }, wgpu::Extent3d { width, height, depth_or_array_layers: 1 });
        if let (Some(q), Some(timestamp_readback)) = (&query_set, &timestamp_readback) { encoder.resolve_query_set(q, 0..2, timestamp_readback, 0); encoder.copy_buffer_to_buffer(timestamp_readback, 0, &readback, timestamp_offset, 16); }
        self.queue.submit(Some(encoder.finish()));
        let submit_ms = frame_started.elapsed().as_secs_f64() * 1000.0;
        let slice = readback.slice(..); let (tx, rx) = std::sync::mpsc::channel(); slice.map_async(wgpu::MapMode::Read, move |r| { let _ = tx.send(r); }); self.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| format!("poll failed: {e:?}"))?; rx.recv().map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
        let mapped = slice.get_mapped_range().map_err(|e| e.to_string())?; let mut pixels = Vec::with_capacity((width * height * 4) as usize); for row in mapped[..pixel_bytes as usize].chunks_exact(bytes_per_row as usize).take(height as usize) { pixels.extend_from_slice(&row[..(width * 4) as usize]); } let hash = fnv1a(&pixels); let gpu_ms = if self.gpu_timing_supported { let start = u64::from_le_bytes(mapped[timestamp_offset as usize..timestamp_offset as usize + 8].try_into().unwrap()); let end = u64::from_le_bytes(mapped[timestamp_offset as usize + 8..timestamp_offset as usize + 16].try_into().unwrap()); Some((end.saturating_sub(start) as f64) * f64::from(self.queue.get_timestamp_period()) / 1_000_000.0) } else { None }; drop(mapped); readback.unmap();
        self.last_frame_ms = Some(submit_ms); self.last_gpu_ms = gpu_ms; self.last_hash = Some(format!("0x{hash:016x}"));
        self.last_memory_bytes = u64::from(width) * u64::from(height) * 4 + 16 + 16 + pixel_bytes + 16 + if self.gpu_timing_supported { 16 } else { 0 };
        Ok(json!({"width": width, "height": height, "format": format!("{:?}", self.format), "pixel_hash_fnv1a64": format!("0x{hash:016x}"), "frame_submit_ms": submit_ms, "gpu_timing": {"supported": self.gpu_timing_supported, "value_ms": gpu_ms, "fallback": self.gpu_timing_fallback}, "pipeline_cache_key": self.pipeline_key, "pipeline_cache_hits": self.pipeline_cache_hits, "pipeline_cache_misses": self.pipeline_cache_misses}))
    }

    fn present_surface(&mut self, surface: &wgpu::Surface<'_>, format: wgpu::TextureFormat) -> Result<(), String> {
        let frame = match surface.get_current_texture() { wgpu::CurrentSurfaceTexture::Success(frame) | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame, status => return Err(format!("surface acquire failed: {status:?}")) };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let shader = self.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("auvra-viewport-reference-shader"), source: wgpu::ShaderSource::Wgsl(r#"@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> { var p = array<vec2<f32>,3>(vec2(-0.7,-0.7),vec2(0.0,0.7),vec2(0.7,-0.7)); return vec4(p[i],0.0,1.0); } @fragment fn fs() -> @location(0) vec4<f32> { return vec4(0.18,0.62,0.95,1.0); }"#.into()) });
        let pipeline = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor { label: Some("auvra-viewport-reference-pipeline"), layout: None, vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() }, fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some("fs"), targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::REPLACE), write_mask: wgpu::ColorWrites::ALL })], compilation_options: Default::default() }), primitive: wgpu::PrimitiveState::default(), depth_stencil: None, multisample: wgpu::MultisampleState::default(), multiview_mask: None, cache: None });
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("auvra-viewport-reference-encoder") });
        { let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("auvra-viewport-reference-pass"), color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.02, g: 0.04, b: 0.08, a: 1.0 }), store: wgpu::StoreOp::Store } })], depth_stencil_attachment: None, occlusion_query_set: None, timestamp_writes: None, multiview_mask: None }); pass.set_pipeline(&pipeline); pass.draw(0..3, 0..1); }
        self.queue.submit(Some(encoder.finish())); self.queue.present(frame); Ok(())
    }

    fn metrics(&self) -> Value { json!({"startup_ms": self.startup_ms, "last_frame_submit_ms": self.last_frame_ms, "gpu_frame_ms": self.last_gpu_ms, "memory_bytes": self.last_memory_bytes, "last_readback_hash": self.last_hash, "backend": format!("{:?}", self.info.backend), "adapter": self.info.name, "gpu_timing": {"supported": self.gpu_timing_supported, "fallback": self.gpu_timing_fallback}}) }
}

fn dimensions(params: &Value) -> Result<(u32, u32), String> { let obj = params.as_object(); let width = obj.and_then(|v| v.get("width")).and_then(Value::as_u64).unwrap_or(128); let height = obj.and_then(|v| v.get("height")).and_then(Value::as_u64).unwrap_or(128); if !(1..=2048).contains(&width) || !(1..=2048).contains(&height) { return Err("reference dimensions must be between 1 and 2048".into()); } Ok((width as u32, height as u32)) }

fn fnv1a(bytes: &[u8]) -> u64 { let mut h = 0xcbf29ce484222325_u64; for b in bytes { h ^= u64::from(*b); h = h.wrapping_mul(0x100000001b3); } h }

struct Viewport { _event_loop: EventLoop<()>, _window: Arc<Window>, _surface: Option<wgpu::Surface<'static>>, width: u32, height: u32 }

struct ViewportApp { window: Option<Arc<Window>>, width: u32, height: u32, title: String }

impl winit::application::ApplicationHandler for ViewportApp {
    fn resumed(&mut self, event_loop: &winit::event_loop::ActiveEventLoop) {
        if self.window.is_some() { event_loop.exit(); return; }
        let attrs = Window::default_attributes().with_title(self.title.clone()).with_inner_size(winit::dpi::PhysicalSize::new(self.width, self.height));
        match event_loop.create_window(attrs) {
            Ok(window) => { self.window = Some(Arc::new(window)); event_loop.exit(); }
            Err(_) => { event_loop.exit(); }
        }
    }
    fn window_event(&mut self, event_loop: &winit::event_loop::ActiveEventLoop, _window_id: winit::window::WindowId, event: winit::event::WindowEvent) { if matches!(event, winit::event::WindowEvent::CloseRequested) { event_loop.exit(); } }
    fn about_to_wait(&mut self, event_loop: &winit::event_loop::ActiveEventLoop) { event_loop.exit(); }
}

impl Viewport {
    fn open(renderer: &mut Renderer, width: u32, height: u32, title: String) -> Result<Self, String> {
        let mut event_loop = EventLoop::new().map_err(|e| e.to_string())?;
        let mut app = ViewportApp { window: None, width, height, title: title.clone() };
        event_loop.run_app_on_demand(&mut app).map_err(|e| e.to_string())?;
        let window = app.window.take().ok_or("viewport window creation failed")?;
        let surface = renderer.instance.create_surface(window.clone()).map_err(|e| e.to_string())?;
        let caps = surface.get_capabilities(&renderer.adapter); let format = caps.formats.first().copied().ok_or("viewport surface has no formats")?; let present_mode = caps.present_modes.first().copied().ok_or("viewport surface has no present modes")?; let alpha_mode = caps.alpha_modes.first().copied().ok_or("viewport surface has no alpha modes")?;
        surface.configure(&renderer.device, &wgpu::SurfaceConfiguration { usage: wgpu::TextureUsages::RENDER_ATTACHMENT, format, color_space: wgpu::SurfaceColorSpace::Auto, width, height, present_mode, alpha_mode, view_formats: vec![], desired_maximum_frame_latency: 2 });
        renderer.present_surface(&surface, format)?;
        Ok(Self { _event_loop: event_loop, _window: window, _surface: Some(surface), width, height })
    }

    fn recover(&mut self, renderer: &mut Renderer) -> Result<(), String> {
        drop(self._surface.take());
        let surface = renderer.instance.create_surface(self._window.clone()).map_err(|e| e.to_string())?;
        let caps = surface.get_capabilities(&renderer.adapter); let format = caps.formats.first().copied().ok_or("recovered viewport surface has no formats")?; let present_mode = caps.present_modes.first().copied().ok_or("recovered viewport surface has no present modes")?; let alpha_mode = caps.alpha_modes.first().copied().ok_or("recovered viewport surface has no alpha modes")?;
        surface.configure(&renderer.device, &wgpu::SurfaceConfiguration { usage: wgpu::TextureUsages::RENDER_ATTACHMENT, format, color_space: wgpu::SurfaceColorSpace::Auto, width: self.width, height: self.height, present_mode, alpha_mode, view_formats: vec![], desired_maximum_frame_latency: 2 });
        renderer.present_surface(&surface, format)?;
        self._surface = Some(surface);
        Ok(())
    }
}


struct App { authenticated: bool, world: World, renderer: Renderer, viewport: Option<Viewport> }

impl App {
    fn dispatch(&mut self, req: Request) -> Result<Response, String> {
        if req.protocol != PROTOCOL { return Err("unsupported protocol version".into()); }
        if req.method == "session.hello" { self.authenticated = true; return Ok(response(req.id, json!({"protocol": PROTOCOL, "authenticated": true, "world_revision": self.world.revision}))); }
        if !self.authenticated { return Err("session.hello required".into()); }
        match req.method.as_str() {
            "world.getSnapshot" => Ok(response(req.id, serde_json::to_value(self.world.snapshot()).map_err(|e| e.to_string())?)),
            "world.apply" => self.apply_world(req),
            "renderer.getCapabilities" => Ok(response(req.id, self.renderer.capabilities())),
            "renderer.renderReference" => Ok(response(req.id, self.renderer.render_reference(&req.params)?)),
            "renderer.getMetrics" => Ok(response(req.id, self.renderer.metrics())),
            "renderer.recover" => { self.renderer = Renderer::new()?; let viewport_reopened = if let Some(viewport) = self.viewport.as_mut() { viewport.recover(&mut self.renderer)?; true } else { false }; Ok(response(req.id, json!({"recovered": true, "viewport_reopened": viewport_reopened, "capabilities": self.renderer.capabilities(), "world_revision": self.world.revision}))) },
            "viewport.open" => { if self.viewport.is_some() { return Ok(error_response(req.id, "already_open", "viewport is already open")); } let obj = req.params.as_object(); let width = obj.and_then(|v| v.get("width")).and_then(Value::as_u64).unwrap_or(640); let height = obj.and_then(|v| v.get("height")).and_then(Value::as_u64).unwrap_or(480); let title = obj.and_then(|v| v.get("title")).and_then(Value::as_str).unwrap_or("Auvra Native Viewport").to_string(); if !(1..=4096).contains(&width) || !(1..=4096).contains(&height) || title.is_empty() || title.len() > 256 { return Err("invalid viewport dimensions or title".into()); } self.viewport = Some(Viewport::open(&mut self.renderer, width as u32, height as u32, title)?); Ok(response(req.id, json!({"open": true, "width": width, "height": height, "ownership": "separate-native-surface"}))) },
            "viewport.close" => { self.viewport = None; Ok(response(req.id, json!({"open": false, "world_revision": self.world.revision}))) },
            "shutdown" => Ok(response(req.id, json!({"stopped": true}))),
            _ => Ok(error_response(req.id, "unknown_method", "method is not part of auvra.native/1")),
        }
    }

    fn apply_world(&mut self, req: Request) -> Result<Response, String> {
        let obj = req.params.as_object().ok_or_else(|| "params must be an object".to_string())?;
        let expected = obj.get("expectedRevision").and_then(Value::as_u64).ok_or_else(|| "expectedRevision must be an unsigned integer".to_string())?;
        if expected != self.world.revision { return Ok(error_response(req.id, "revision_conflict", format!("expected {}, current {}", expected, self.world.revision))); }
        let entities: Vec<Entity> = serde_json::from_value(obj.get("entities").cloned().ok_or_else(|| "entities are required".to_string())?).map_err(|e| format!("invalid entities: {e}"))?;
        if entities.len() > 1024 || entities.iter().any(|entity| entity.id.is_empty() || entity.id.len() > 128 || entity.position.iter().any(|v| !v.is_finite()) || entity.color.iter().any(|v| !v.is_finite() || *v < 0.0 || *v > 1.0)) { return Err("invalid native world entity".into()); }
        let mut ids = std::collections::HashSet::new();
        if entities.iter().any(|entity| !ids.insert(entity.id.clone())) { return Err("duplicate native entity id".into()); }
        self.world.entities = entities; self.world.revision += 1;
        Ok(response(req.id, serde_json::to_value(self.world.snapshot()).map_err(|e| e.to_string())?))
    }
}

fn run_ipc() -> Result<(), String> {
    let mut app = App { authenticated: false, world: World::new(), renderer: Renderer::new()?, viewport: None };
    diagnostic("native.ready", None, Some(PROTOCOL.into()));
    let stdin = io::stdin(); let stdout = io::stdout(); let mut input = stdin.lock(); let mut output = stdout.lock();
    loop {
        let Some(bytes) = read_frame(&mut input)? else { diagnostic("eof", None, None); return Ok(()); };
        let req: Request = serde_json::from_slice(&bytes).map_err(|e| format!("invalid request schema: {e}"))?;
        let method = req.method.clone(); let id = req.id; let result = app.dispatch(req);
        match result { Ok(resp) => { write_frame(&mut output, &resp)?; if method == "shutdown" { diagnostic("shutdown", Some(&method), Some("clean".into())); return Ok(()); } }, Err(e) => { diagnostic("fatal_protocol_error", Some(&method), Some(e)); return Err("fatal protocol error".into()); } }
        diagnostic("request_complete", Some(&method), Some(format!("id={id}")));
    }
}

fn run_self_test() -> Result<(), String> {
    let started = Instant::now(); let mut app = App { authenticated: false, world: World::new(), renderer: Renderer::new()?, viewport: None };
    let hello = app.dispatch(Request { id: 1, protocol: PROTOCOL.into(), method: "session.hello".into(), params: Value::Null })?;
    let applied = app.dispatch(Request { id: 2, protocol: PROTOCOL.into(), method: "world.apply".into(), params: json!({"expectedRevision": 0, "entities": [{"id":"reference","position":[1.25,-0.5,0.0],"color":[0.2,0.6,1.0,1.0]}]}) })?;
    let rendered = app.dispatch(Request { id: 3, protocol: PROTOCOL.into(), method: "renderer.renderReference".into(), params: json!({"width": 96, "height": 80}) })?;
    let cached = app.dispatch(Request { id: 4, protocol: PROTOCOL.into(), method: "renderer.renderReference".into(), params: json!({"width": 96, "height": 80}) })?;
    let opened = app.dispatch(Request { id: 5, protocol: PROTOCOL.into(), method: "viewport.open".into(), params: json!({"width": 320, "height": 200, "title": "Auvra Stage 6 Self-Test"}) })?;
    let recovered = app.dispatch(Request { id: 6, protocol: PROTOCOL.into(), method: "renderer.recover".into(), params: Value::Null })?;
    let closed = app.dispatch(Request { id: 7, protocol: PROTOCOL.into(), method: "viewport.close".into(), params: Value::Null })?;
    let stopped = app.dispatch(Request { id: 8, protocol: PROTOCOL.into(), method: "shutdown".into(), params: Value::Null })?;
    let cache_hit = cached.result.as_ref().and_then(|v| v.get("pipeline_cache_hits")).and_then(Value::as_u64).unwrap_or(0) >= 1;
    let viewport_reopened = recovered.result.as_ref().and_then(|v| v.get("viewport_reopened")).and_then(Value::as_bool).unwrap_or(false);
    let clean_shutdown = stopped.ok && stopped.result.as_ref().and_then(|v| v.get("stopped")).and_then(Value::as_bool).unwrap_or(false);
    if !(hello.ok && applied.ok && rendered.ok && cached.ok && cache_hit && opened.ok && recovered.ok && viewport_reopened && closed.ok && clean_shutdown && app.world.revision == 1) {
        return Err("native self-test acceptance failed".into());
    }
    let evidence = json!({"probe": "auvra-native-self-test", "protocol": PROTOCOL, "hello_ok": hello.ok, "world_apply_ok": applied.ok, "world_revision": app.world.revision, "reference_render_ok": rendered.ok, "reference": rendered.result, "pipeline_cache_hit": cache_hit, "viewport_open_ok": opened.ok, "recovery_ok": recovered.ok, "viewport_reopened": viewport_reopened, "viewport_close_ok": closed.ok, "clean_shutdown": clean_shutdown, "elapsed_ms": started.elapsed().as_secs_f64() * 1000.0}); println!("{}", serde_json::to_string(&evidence).map_err(|e| e.to_string())?); Ok(())
}

fn main() {
    match std::env::var("AUVRA_NATIVE_SESSION_TOKEN") { Ok(token) if token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()) => (), _ => { diagnostic("fatal_configuration_error", None, Some("AUVRA_NATIVE_SESSION_TOKEN must be a 256-bit hex secret".into())); std::process::exit(2); } };
    let result = if std::env::args().any(|arg| arg == "--self-test") { run_self_test() } else { run_ipc() };
    if let Err(error) = result { diagnostic("fatal_error", None, Some(error)); std::process::exit(1); }
}
