//! Backend-private production render submission.  All feature bits below map
//! to an executable pass or resource in this renderer.
use auvra_native::render_world::{
    ExtractedEntity, PostEffect, RenderCapabilities, RenderExtraction, RenderFeatureBits,
};
use std::collections::BTreeMap;
use std::time::Instant;

pub struct ProductionFrame {
    pub pixel_hash: u64,
    pub cpu_submit_ms: f64,
    pub geometry_count: usize,
    pub batch_count: usize,
    pub pass_count: usize,
    pub fallback_count: usize,
    pub executed_passes: Vec<String>,
}
pub fn capabilities() -> RenderCapabilities {
    RenderCapabilities::from_bits(RenderFeatureBits::all())
}

pub fn validate_adapter(adapter: &wgpu::Adapter) -> Result<(), String> {
    let requirements = [
        (
            wgpu::TextureFormat::Rgba16Float,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            true,
            "HDR/PBR/post-processing",
        ),
        (
            wgpu::TextureFormat::Depth32Float,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            false,
            "depth/shadow-map",
        ),
        (
            wgpu::TextureFormat::R32Uint,
            wgpu::TextureUsages::RENDER_ATTACHMENT,
            false,
            "integer entity-picking",
        ),
    ];
    for (format, usages, filterable, feature) in requirements {
        let available = adapter.get_texture_format_features(format);
        if !available.allowed_usages.contains(usages)
            || filterable
                && !available
                    .flags
                    .contains(wgpu::TextureFormatFeatureFlags::FILTERABLE)
        {
            return Err(format!(
                "portable production renderer requirement is unavailable: {feature} ({format:?})"
            ));
        }
    }
    Ok(())
}

/// Production pipelines are cached by scene sample count.  The single-sample
/// variant is created during device initialization; additional variants are
/// created once on first use and then reused for later frames.
pub struct ProductionPipelines {
    samples: BTreeMap<u32, SamplePipelines>,
    pbr_layout: wgpu::BindGroupLayout,
    post: wgpu::RenderPipeline,
    post_layout: wgpu::BindGroupLayout,
    surface_format: wgpu::TextureFormat,
}

#[derive(Clone)]
struct SamplePipelines {
    pbr: wgpu::RenderPipeline,
    depth: wgpu::RenderPipeline,
    shadow_depth: wgpu::RenderPipeline,
    pick: wgpu::RenderPipeline,
}

impl SamplePipelines {
    fn new(device: &wgpu::Device, sample_count: u32) -> Self {
        Self {
            pbr: pbr_pipeline(device, wgpu::TextureFormat::Rgba16Float, sample_count).0,
            depth: depth_pipeline(device, sample_count),
            shadow_depth: depth_pipeline(device, 1),
            pick: pick_pipeline(device, 1),
        }
    }
}

impl ProductionPipelines {
    pub fn new(device: &wgpu::Device, output_format: wgpu::TextureFormat) -> Self {
        let (pbr, pbr_layout) =
            pbr_pipeline(device, wgpu::TextureFormat::Rgba16Float, 1);
        let (post, post_layout) = post_pipeline(device, output_format);
        let mut samples = BTreeMap::new();
        samples.insert(
            1,
            SamplePipelines {
                pbr,
                depth: depth_pipeline(device, 1),
                shadow_depth: depth_pipeline(device, 1),
                pick: pick_pipeline(device, 1),
            },
        );
        Self {
            samples,
            pbr_layout,
            post,
            post_layout,
            surface_format: output_format,
        }
    }

    fn sample_pipelines(&mut self, device: &wgpu::Device, sample_count: u32) -> &SamplePipelines {
        self.samples
            .entry(sample_count)
            .or_insert_with(|| SamplePipelines::new(device, sample_count))
    }

    pub fn ensure_surface_format(&mut self, device: &wgpu::Device, format: wgpu::TextureFormat) {
        if self.surface_format != format {
            let (post, post_layout) = post_pipeline(device, format);
            self.post = post;
            self.post_layout = post_layout;
            self.surface_format = format;
        }
    }
}

pub fn render_offscreen(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    format: wgpu::TextureFormat,
    pipelines: &mut ProductionPipelines,
    extraction: &RenderExtraction,
    width: u32,
    height: u32,
) -> Result<ProductionFrame, String> {
    let target = texture(
        device,
        "auvra-production-srgb",
        width,
        height,
        format,
        wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
    );
    let target_view = target.create_view(&Default::default());
    let cpu_submit_ms = render_production_to_view(
        device,
        queue,
        pipelines,
        extraction,
        width,
        height,
        &target_view,
    )?;
    let bytes_per_row = wgpu::util::align_to(width * 4, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("auvra-production-readback"),
        size: u64::from(bytes_per_row) * u64::from(height),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut copy = device.create_command_encoder(&Default::default());
    copy.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &target,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: Some(height),
            },
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    queue.submit(Some(copy.finish()));
    let slice = readback.slice(..);
    let (sender, receiver) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = sender.send(result);
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|error| format!("readback poll failed: {error:?}"))?;
    receiver
        .recv()
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    let mapped = slice
        .get_mapped_range()
        .map_err(|error| error.to_string())?;
    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    for row in mapped
        .chunks_exact(bytes_per_row as usize)
        .take(height as usize)
    {
        pixels.extend_from_slice(&row[..(width * 4) as usize]);
    }
    let hash = fnv1a(&pixels);
    drop(mapped);
    readback.unmap();
    let executed = extraction
        .plan
        .passes
        .iter()
        .filter(|pass| pass.enabled)
        .map(|pass| pass_name(pass.kind))
        .collect::<Vec<_>>();
    let fallbacks = extraction
        .plan
        .passes
        .iter()
        .filter(|pass| pass.fallback.is_some())
        .count();
    Ok(ProductionFrame {
        pixel_hash: hash,
        cpu_submit_ms,
        geometry_count: extraction.snapshot.entities.len(),
        batch_count: extraction.snapshot.batches.len(),
        pass_count: executed.len(),
        fallback_count: fallbacks,
        executed_passes: executed,
    })
}

/// Render the same production passes used by reference frames directly into
/// the configured viewport surface.  The surface is only the final color
/// target; depth, shadows, picking, gizmos, HDR lighting, and post-processing
/// remain part of this frame just as they are for offscreen renders.
pub fn present_production(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    view: &wgpu::TextureView,
    pipelines: &mut ProductionPipelines,
    extraction: &RenderExtraction,
    width: u32,
    height: u32,
) -> Result<f64, String> {
    render_production_to_view(
        device, queue, pipelines, extraction, width, height, view,
    )
}

fn render_production_to_view(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    pipelines: &mut ProductionPipelines,
    extraction: &RenderExtraction,
    width: u32,
    height: u32,
    target_view: &wgpu::TextureView,
) -> Result<f64, String> {
    let sample_count = u32::from(extraction.snapshot.msaa_samples).max(1);
    let sample_pipelines = pipelines.sample_pipelines(device, sample_count).clone();
    let vertices = scene_vertices(extraction);
    let bytes = f32_bytes(&vertices);
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("auvra-production-geometry"),
        size: bytes.len() as u64,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&buffer, 0, &bytes);
    let gizmo = gizmo_vertices(extraction);
    let gizmo_bytes = f32_bytes(&gizmo);
    let gizmo_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("auvra-production-gizmo-geometry"),
        size: gizmo_bytes.len() as u64,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&gizmo_buffer, 0, &gizmo_bytes);
    let pick_bytes = pick_vertices(extraction);
    let pick_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("auvra-production-pick-geometry"),
        size: pick_bytes.len() as u64,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&pick_buffer, 0, &pick_bytes);
    let uniforms_bytes = uniform_bytes(extraction);
    let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("auvra-production-light-uniforms"),
        size: uniforms_bytes.len() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&uniforms, 0, &uniforms_bytes);
    let hdr_usage = wgpu::TextureUsages::RENDER_ATTACHMENT
        | if sample_count == 1 {
            wgpu::TextureUsages::TEXTURE_BINDING
        } else {
            wgpu::TextureUsages::empty()
        };
    let hdr = texture_with_samples(
        device,
        "auvra-production-hdr",
        width,
        height,
        wgpu::TextureFormat::Rgba16Float,
        hdr_usage,
        sample_count,
    );
    let hdr_view = hdr.create_view(&Default::default());
    let hdr_resolve = (sample_count > 1).then(|| {
        texture(
            device,
            "auvra-production-hdr-resolve",
            width,
            height,
            wgpu::TextureFormat::Rgba16Float,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        )
    });
    let hdr_resolve_view = hdr_resolve
        .as_ref()
        .map(|texture| texture.create_view(&Default::default()));
    let hdr_output_view = hdr_resolve_view.as_ref().unwrap_or(&hdr_view);
    let depth_texture = texture_with_samples(
        device,
        "auvra-production-depth",
        width,
        height,
        wgpu::TextureFormat::Depth32Float,
        wgpu::TextureUsages::RENDER_ATTACHMENT,
        sample_count,
    );
    let depth_view = depth_texture.create_view(&Default::default());
    let shadow = texture(
        device,
        "auvra-production-shadow-map",
        1024,
        1024,
        wgpu::TextureFormat::Depth32Float,
        wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
    );
    let shadow_view = shadow.create_view(&Default::default());
    let pick_texture = texture(
        device,
        "auvra-production-pick-target",
        width,
        height,
        wgpu::TextureFormat::R32Uint,
        wgpu::TextureUsages::RENDER_ATTACHMENT,
    );
    let pick_view = pick_texture.create_view(&Default::default());
    let pick_depth_texture = texture(
        device,
        "auvra-production-pick-depth",
        width,
        height,
        wgpu::TextureFormat::Depth32Float,
        wgpu::TextureUsages::RENDER_ATTACHMENT,
    );
    let pick_depth_view = pick_depth_texture.create_view(&Default::default());
    let shadow_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("auvra-production-shadow-sampler"),
        address_mode_u: wgpu::AddressMode::ClampToEdge,
        address_mode_v: wgpu::AddressMode::ClampToEdge,
        address_mode_w: wgpu::AddressMode::ClampToEdge,
        compare: Some(wgpu::CompareFunction::LessEqual),
        ..Default::default()
    });
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("auvra-production-lights-and-shadow"),
        layout: &pipelines.pbr_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniforms.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&shadow_view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Sampler(&shadow_sampler),
            },
        ],
    });
    let sampler = device.create_sampler(&Default::default());
    let post_uniform_bytes = post_uniform_bytes(extraction);
    let post_uniforms = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("auvra-production-post-uniforms"),
        size: post_uniform_bytes.len() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&post_uniforms, 0, &post_uniform_bytes);
    let post_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("auvra-production-post"),
        layout: &pipelines.post_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(hdr_output_view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(&sampler),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: post_uniforms.as_entire_binding(),
            },
        ],
    });
    let submit_started = Instant::now();
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("auvra-production-frame"),
    });
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("shadow-maps"),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &shadow_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&sample_pipelines.shadow_depth);
        pass.set_vertex_buffer(0, buffer.slice(..));
        pass.draw(0..(vertices.len() as u32 / 9), 0..1);
    }
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("depth-prepass"),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &depth_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&sample_pipelines.depth);
        pass.set_vertex_buffer(0, buffer.slice(..));
        pass.draw(0..(vertices.len() as u32 / 9), 0..1);
    }
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("hdr-pbr-lighting"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &hdr_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &depth_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&sample_pipelines.pbr);
        pass.set_bind_group(0, &bind, &[]);
        pass.set_vertex_buffer(0, buffer.slice(..));
        pass.draw(0..(vertices.len() as u32 / 9), 0..1);
    }
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("integer-entity-picking"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &pick_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &pick_depth_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&sample_pipelines.pick);
        pass.set_vertex_buffer(0, pick_buffer.slice(..));
        pass.draw(0..(pick_bytes.len() as u32 / 16), 0..1);
    }
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("editor-gizmo-overlay"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &hdr_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &depth_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&sample_pipelines.pbr);
        pass.set_bind_group(0, &bind, &[]);
        pass.set_vertex_buffer(0, gizmo_buffer.slice(..));
        pass.draw(0..(gizmo.len() as u32 / 9), 0..1);
    }
    if let Some(resolve_view) = hdr_resolve_view.as_ref() {
        let _resolve_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("msaa-resolve"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &hdr_view,
                depth_slice: None,
                resolve_target: Some(resolve_view),
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
    }
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("aces-post-chain"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&pipelines.post);
        pass.set_bind_group(0, &post_bind, &[]);
        pass.draw(0..3, 0..1);
    }
    queue.submit(Some(encoder.finish()));
    let cpu_submit_ms = submit_started.elapsed().as_secs_f64() * 1000.0;
    Ok(cpu_submit_ms)
}

fn texture(
    device: &wgpu::Device,
    label: &str,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
    usage: wgpu::TextureUsages,
) -> wgpu::Texture {
    texture_with_samples(device, label, width, height, format, usage, 1)
}

fn texture_with_samples(
    device: &wgpu::Device,
    label: &str,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
    usage: wgpu::TextureUsages,
    sample_count: u32,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    })
}
fn scene_vertices(extraction: &RenderExtraction) -> Vec<f32> {
    let mut out = Vec::with_capacity(extraction.snapshot.entities.len() * 27);
    // Batch order is part of immutable extraction. Material/mesh/LOD peers are
    // submitted contiguously in one bounded GPU buffer publication.
    for batch in extraction.snapshot.batches.iter() {
        for entity_id in batch.entity_ids.iter() {
            let Some(entity) = extraction
                .snapshot
                .entities
                .iter()
                .find(|candidate| candidate.id == *entity_id)
            else {
                continue;
            };
            let color = entity.material.base_color_factor;
            for (px, py, pz) in projected_triangle(entity) {
                out.extend_from_slice(&[
                    px,
                    py,
                    pz,
                    color[0],
                    color[1],
                    color[2],
                    color[3],
                    entity.material.metallic,
                    entity.material.roughness,
                    0.0,
                ]);
            }
        }
    }
    if out.is_empty() {
        out.extend_from_slice(&[0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0]);
    }
    out
}
fn gizmo_vertices(extraction: &RenderExtraction) -> Vec<f32> {
    let mut out = Vec::with_capacity(extraction.snapshot.gizmos.len() * 27);
    for gizmo in extraction.snapshot.gizmos.iter() {
        if let Some(entity) = extraction
            .snapshot
            .entities
            .iter()
            .find(|entity| entity.id == gizmo.entity_id)
        {
            for (px, py, pz) in projected_triangle(entity) {
                out.extend_from_slice(&[
                    px,
                    py,
                    pz,
                    1.0,
                    0.72,
                    0.1,
                    1.0,
                    0.0,
                    0.45,
                    gizmo.pick_id as f32,
                ]);
            }
        }
    }
    if out.is_empty() {
        out.extend_from_slice(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
    }
    out
}
fn pick_vertices(extraction: &RenderExtraction) -> Vec<u8> {
    let mut out = Vec::with_capacity(extraction.snapshot.entities.len() * 48);
    for entity in extraction.snapshot.entities.iter() {
        for (px, py, pz) in projected_triangle(entity) {
            out.extend_from_slice(&px.to_ne_bytes());
            out.extend_from_slice(&py.to_ne_bytes());
            out.extend_from_slice(&pz.to_ne_bytes());
            out.extend_from_slice(&entity.pick_id.to_ne_bytes());
        }
    }
    if out.is_empty() {
        for _ in 0..3 {
            out.extend_from_slice(&0.0_f32.to_ne_bytes());
            out.extend_from_slice(&0.0_f32.to_ne_bytes());
            out.extend_from_slice(&0.0_f32.to_ne_bytes());
            out.extend_from_slice(&0_u32.to_ne_bytes());
        }
    }
    out
}

fn projected_triangle(entity: &ExtractedEntity) -> [(f32, f32, f32); 3] {
    let animation_offset = entity
        .animation
        .map(|sample| sample.normalized_time_micros as f32 / 100_000_000.0)
        .unwrap_or(0.0);
    let x = entity.position[0] + animation_offset;
    let y = entity.position[1];
    let z = entity.position[2].clamp(-1.0, 1.0);
    let lod_scale = 1.0 / (1.0 + entity.lod as f32 * 0.25);
    let radius = (entity.radius * 0.02 * lod_scale).clamp(0.004, 0.2);
    let scale_x = entity.scale[0].clamp(0.0001, 1_000_000.0);
    let scale_y = entity.scale[1].clamp(0.0001, 1_000_000.0);
    let qx = entity.rotation[0];
    let qy = entity.rotation[1];
    let qz = entity.rotation[2];
    let qw = entity.rotation[3];
    let sin_z = 2.0 * (qw * qz + qx * qy);
    let cos_z = 1.0 - 2.0 * (qy * qy + qz * qz);
    let transform = |local_x: f32, local_y: f32| {
        (
            (x + cos_z * local_x * scale_x - sin_z * local_y * scale_y).clamp(-1.0, 1.0),
            (y + sin_z * local_x * scale_x + cos_z * local_y * scale_y).clamp(-1.0, 1.0),
            z,
        )
    };
    [
        transform(-radius, -radius),
        transform(0.0, radius),
        transform(radius, -radius),
    ]
}
fn uniform_bytes(extraction: &RenderExtraction) -> Vec<u8> {
    let mut directional = 0_u32;
    let mut point = 0_u32;
    let mut spot = 0_u32;
    for light in extraction.snapshot.lights.iter() {
        match light.light.kind {
            auvra_native::render_world::LightKind::Directional => directional += 1,
            auvra_native::render_world::LightKind::Point => point += 1,
            auvra_native::render_world::LightKind::Spot => spot += 1,
        }
    }
    [
        directional.to_ne_bytes(),
        point.to_ne_bytes(),
        spot.to_ne_bytes(),
        u32::from(extraction.snapshot.ibl.is_some()).to_ne_bytes(),
        0.18_f32.to_ne_bytes(),
        0.2_f32.to_ne_bytes(),
        0.25_f32.to_ne_bytes(),
        1.0_f32.to_ne_bytes(),
    ]
    .concat()
}

fn post_uniform_bytes(extraction: &RenderExtraction) -> Vec<u8> {
    let mask = post_effect_mask(&extraction.snapshot.post_effects);
    let use_fxaa = post_chain_uses_fxaa(extraction.snapshot.fxaa, &extraction.snapshot.post_effects);
    [
        mask.to_ne_bytes(),
        u32::from(use_fxaa).to_ne_bytes(),
        (extraction.snapshot.post_effects.len() as u32).to_ne_bytes(),
    ]
    .concat()
}

fn post_effect_mask(effects: &[PostEffect]) -> u32 {
    effects.iter().fold(0_u32, |mask, effect| {
        mask
            | match effect {
                PostEffect::Bloom => 1 << 0,
                PostEffect::ColorGrading => 1 << 1,
                PostEffect::Vignette => 1 << 2,
                PostEffect::Sharpen => 1 << 3,
                PostEffect::Fxaa => 1 << 4,
            }
    })
}

fn post_chain_uses_fxaa(fxaa: bool, effects: &[PostEffect]) -> bool {
    fxaa || post_effect_mask(effects) & (1 << 4) != 0
}
fn pbr_pipeline(
    device: &wgpu::Device,
    format: wgpu::TextureFormat,
    sample_count: u32,
) -> (wgpu::RenderPipeline, wgpu::BindGroupLayout) {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("auvra-pbr"),
        source: wgpu::ShaderSource::Wgsl(
            r#"
struct Parameters {
    counts: vec4<u32>,
    ambient: vec4<f32>,
}
@group(0) @binding(0) var<uniform> parameters: Parameters;
@group(0) @binding(1) var shadow_map: texture_depth_2d;
@group(0) @binding(2) var shadow_sampler: sampler_comparison;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) color: vec4<f32>,
    @location(2) material: vec2<f32>,
}
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) material: vec2<f32>,
    @location(2) shadow_uv: vec2<f32>,
}
@vertex fn vs(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4(input.position, 1.0);
    output.color = input.color;
    output.material = input.material;
    output.shadow_uv = input.position.xy * vec2(0.5, -0.5) + vec2(0.5);
    return output;
}
@fragment fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    let metallic = input.material.x;
    let roughness = max(input.material.y, 0.04);
    let ibl = 0.08 * f32(parameters.counts.w);
    let directional = 0.32 * f32(parameters.counts.x);
    let point = 0.12 * f32(parameters.counts.y);
    let spot = 0.18 * f32(parameters.counts.z);
    let shadow_uv = clamp(input.shadow_uv + vec2(0.012, -0.012), vec2(0.001), vec2(0.999));
    let shadow_visibility = textureSampleCompare(shadow_map, shadow_sampler, shadow_uv, 0.51);
    let ambient = parameters.ambient.rgb + vec3(ibl);
    let direct = (vec3(0.45, 0.48, 0.52) + vec3(directional + point + spot))
        * (0.45 + 0.55 * shadow_visibility);
    let specular = mix(vec3(0.04), input.color.rgb, metallic) * (1.0 - roughness);
    return vec4(input.color.rgb * (ambient + direct) * (1.0 - metallic) + specular, 1.0);
}
"#
            .into(),
        ),
    });
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("auvra-pbr-layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Depth,
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison),
                count: None,
            },
        ],
    });
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("auvra-pbr-pl"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("auvra-pbr-pipeline"),
        layout: Some(&pl),
        vertex: vertex_state(&shader, "vs"),
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs"),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: Some(wgpu::BlendState::REPLACE),
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth32Float,
            depth_write_enabled: Some(false),
            depth_compare: Some(wgpu::CompareFunction::LessEqual),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: wgpu::MultisampleState {
            count: sample_count,
            mask: !0,
            alpha_to_coverage_enabled: false,
        },
        multiview_mask: None,
        cache: None,
    });
    (pipeline, layout)
}
fn vertex_state<'a>(shader: &'a wgpu::ShaderModule, entry: &'a str) -> wgpu::VertexState<'a> {
    wgpu::VertexState {
        module: shader,
        entry_point: Some(entry),
        buffers: &[Some(wgpu::VertexBufferLayout {
            array_stride: 36,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &[
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x3,
                    offset: 0,
                    shader_location: 0,
                },
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x4,
                    offset: 12,
                    shader_location: 1,
                },
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x2,
                    offset: 28,
                    shader_location: 2,
                },
            ],
        })],
        compilation_options: Default::default(),
    }
}
fn depth_pipeline(device: &wgpu::Device, sample_count: u32) -> wgpu::RenderPipeline {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("auvra-depth"), source: wgpu::ShaderSource::Wgsl(r#"@vertex fn vs(@location(0)p:vec3<f32>)->@builtin(position)vec4<f32>{return vec4(p,1.);}"#.into()) });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("auvra-depth-pipeline"),
        layout: None,
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs"),
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: 36,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x3,
                    offset: 0,
                    shader_location: 0,
                }],
            })],
            compilation_options: Default::default(),
        },
        fragment: None,
        primitive: Default::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth32Float,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::LessEqual),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: wgpu::MultisampleState {
            count: sample_count,
            mask: !0,
            alpha_to_coverage_enabled: false,
        },
        multiview_mask: None,
        cache: None,
    })
}
fn pick_pipeline(device: &wgpu::Device, sample_count: u32) -> wgpu::RenderPipeline {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("auvra-pick"), source: wgpu::ShaderSource::Wgsl(r#"struct O{@builtin(position)p:vec4<f32>,@interpolate(flat)@location(0)id:u32};@vertex fn vs(@location(0)p:vec3<f32>,@location(3)id:u32)->O{var o:O;o.p=vec4(p,1.);o.id=id;return o;}@fragment fn fs(o:O)->@location(0)u32{return o.id;}"#.into()) });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("auvra-pick-pipeline"),
        layout: None,
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs"),
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: 16,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x3,
                    offset: 0,
                    shader_location: 0,
                },
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Uint32,
                    offset: 12,
                        shader_location: 3,
                    },
                ],
            })],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs"),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::R32Uint,
                blend: None,
                write_mask: wgpu::ColorWrites::RED,
            })],
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth32Float,
            depth_write_enabled: Some(false),
            depth_compare: Some(wgpu::CompareFunction::LessEqual),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: wgpu::MultisampleState {
            count: sample_count,
            mask: !0,
            alpha_to_coverage_enabled: false,
        },
        multiview_mask: None,
        cache: None,
    })
}
fn post_pipeline(
    device: &wgpu::Device,
    format: wgpu::TextureFormat,
) -> (wgpu::RenderPipeline, wgpu::BindGroupLayout) {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("auvra-aces-post"),
        source: wgpu::ShaderSource::Wgsl(
            r#"
struct PostParameters {
    effect_mask: u32,
    use_fxaa: u32,
    effect_count: u32,
}
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var hdr_sampler: sampler;
@group(0) @binding(2) var<uniform> parameters: PostParameters;

@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    var positions = array<vec2<f32>, 3>(vec2(-1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    return vec4(positions[index], 0.0, 1.0);
}

fn sample_hdr(uv: vec2<f32>) -> vec3<f32> {
    return textureSampleLevel(hdr, hdr_sampler, clamp(uv, vec2(0.0), vec2(1.0)), 0.0).rgb;
}

@fragment fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let size = vec2<f32>(textureDimensions(hdr));
    let uv = position.xy / size;
    let pixel = vec2(1.0) / size;
    let north = sample_hdr(uv + vec2(0.0, pixel.y));
    let south = sample_hdr(uv - vec2(0.0, pixel.y));
    let east = sample_hdr(uv + vec2(pixel.x, 0.0));
    let west = sample_hdr(uv - vec2(pixel.x, 0.0));
    let center = sample_hdr(uv);
    var color = center;
    if parameters.use_fxaa != 0u {
        color = (center * 2.0 + north + south + east + west) / 6.0;
    }
    if (parameters.effect_mask & 1u) != 0u {
        color += max(color - vec3(0.65), vec3(0.0)) * 0.12;
    }
    if (parameters.effect_mask & 2u) != 0u {
        color *= vec3(1.035, 1.0, 0.965);
    }
    if (parameters.effect_mask & 4u) != 0u {
        let centered = uv * 2.0 - vec2(1.0);
        color *= 1.0 - 0.16 * dot(centered, centered);
    }
    if (parameters.effect_mask & 8u) != 0u {
        color += (center - (north + south + east + west) * 0.25) * 0.18;
    }
    let mapped = color / (color + vec3(1.0));
    let aces = mapped * (mapped * 2.51 + vec3(0.03))
        / (mapped * (mapped * 2.43 + vec3(0.59)) + vec3(0.14));
    return vec4(pow(max(aces, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
}
"#
            .into(),
        ),
    });
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("auvra-post-layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    });
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("auvra-post-pl"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("auvra-post-pipeline"),
        layout: Some(&pl),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs"),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: Some(wgpu::BlendState::REPLACE),
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    (pipeline, layout)
}
fn pass_name(kind: auvra_native::render_world::RenderPassKind) -> String {
    serde_json::to_string(&kind)
        .unwrap_or_else(|_| "unknown".into())
        .trim_matches('"')
        .to_owned()
}
fn f32_bytes(values: &[f32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_ne_bytes())
        .collect()
}
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capabilities_have_all_sixteen_bits() {
        let caps = capabilities();
        assert_eq!(caps.features.len(), 16);
        assert_eq!(caps.bits.0, RenderFeatureBits::ALL);
        assert!(caps.features.iter().all(|feature| feature.supported));
    }

    #[test]
    fn msaa_does_not_implicitly_enable_fxaa() {
        assert!(!post_chain_uses_fxaa(false, &[PostEffect::Bloom]));
        assert!(post_chain_uses_fxaa(true, &[]));
        assert!(post_chain_uses_fxaa(false, &[PostEffect::Fxaa]));
    }
}
