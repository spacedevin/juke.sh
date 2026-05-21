//! Metal drum preview + optional textured card instances.

use std::f32::consts::PI;
use std::sync::{Arc, Mutex};

use metal::{
    Buffer, CommandQueue, CompileOptions, Device, MTLClearColor, MTLIndexType, MTLLoadAction,
    MTLPixelFormat, MTLPrimitiveType, MTLRegion, MTLResourceOptions, MTLSamplerAddressMode,
    MTLSamplerMinMagFilter, MTLSize, MTLStoreAction, MTLTextureUsage, MTLVertexStepFunction,
    MetalDrawableRef, RenderPassDescriptor, RenderPipelineDescriptor, SamplerDescriptor,
    TextureDescriptor, VertexDescriptor,
};

use crate::scene_data::{CardInstance, PreparedScene};

const SHADER: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct Uniforms {
    float angle;
    float aspect;
    float cam_dist;
    float active_index;
};

struct CardUniforms {
    uint queued_lo;
    uint queued_hi;
    uint2 _pad;
};

struct SolidIn {
    float3 position [[attribute(0)]];
    float3 color [[attribute(1)]];
};

struct TexIn {
    float3 position [[attribute(0)]];
    float2 uv [[attribute(1)]];
    float card_index [[attribute(2)]];
    float2 local_uv [[attribute(3)]];
};

struct SolidOut {
    float4 position [[position]];
    float3 color;
};

struct TexOut {
    float4 position [[position]];
    float2 uv;
    float card_index;
    float2 local_uv;
};

float3 rotate_y(float3 p, float a) {
    float c = cos(a);
    float s = sin(a);
    return float3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

float4 project(float3 p, constant Uniforms& u) {
    float3 eye = float3(p.x, p.y + 0.15, p.z - u.cam_dist);
    float f = 1.0 / tan(0.41421356237);
    float2 ndc = float2(eye.x * f / u.aspect, eye.y * f) / (-eye.z);
    float depth = clamp((-eye.z - 0.1) / 99.9, 0.0, 1.0);
    return float4(ndc, depth, 1.0);
}

bool card_is_queued(int idx, constant CardUniforms& cu) {
    if (idx < 0 || idx >= 64) { return false; }
    uint bit = idx < 32 ? ((cu.queued_lo >> idx) & 1u) : ((cu.queued_hi >> (idx - 32)) & 1u);
    return bit != 0u;
}

vertex SolidOut solid_vertex(SolidIn in [[stage_in]],
                             constant Uniforms& u [[buffer(1)]]) {
    SolidOut vert;
    float3 wp = rotate_y(in.position, u.angle);
    vert.position = project(wp, u);
    vert.color = in.color;
    return vert;
}

fragment float4 solid_fragment(SolidOut in [[stage_in]]) {
    return float4(in.color, 1.0);
}

vertex TexOut tex_vertex(TexIn in [[stage_in]],
                         constant Uniforms& u [[buffer(1)]]) {
    TexOut vert;
    float3 wp = rotate_y(in.position, u.angle);
    vert.position = project(wp, u);
    vert.uv = in.uv;
    vert.card_index = in.card_index;
    vert.local_uv = in.local_uv;
    return vert;
}

fragment float4 tex_fragment(TexOut in [[stage_in]],
                             constant Uniforms& u [[buffer(1)]],
                             constant CardUniforms& cu [[buffer(2)]],
                             texture2d<float> atlas [[texture(0)]],
                             sampler atlas_sm [[sampler(0)]]) {
    float4 c = atlas.sample(atlas_sm, in.uv);
    if (c.a < 0.05) { discard_fragment(); }
    int idx = int(in.card_index + 0.5);
    bool is_active = u.active_index >= 0.0 && abs(in.card_index - u.active_index) < 0.5;
    bool is_queued = card_is_queued(idx, cu);
    float glow = 0.0;
    if (is_queued) {
        glow = smoothstep(0.72, 1.0, in.local_uv.y) * 0.85;
    }
    if (is_active) {
        float edge = min(min(in.local_uv.x, 1.0 - in.local_uv.x),
                         min(in.local_uv.y, 1.0 - in.local_uv.y));
        glow = max(glow, smoothstep(0.05, 0.0, edge) * 0.55);
    }
    float3 cyan = float3(0.0, 0.95, 1.0);
    c.rgb = mix(c.rgb, cyan, glow);
    return c;
}
"#;

#[repr(C)]
#[derive(Clone, Copy)]
struct SolidVertex {
    position: [f32; 3],
    color: [f32; 3],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct TexVertex {
    position: [f32; 3],
    uv: [f32; 2],
    card_index: f32,
    local_uv: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Uniforms {
    angle: f32,
    aspect: f32,
    cam_dist: f32,
    active_index: f32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CardUniforms {
    queued_lo: u32,
    queued_hi: u32,
    _pad: [u32; 2],
}

pub struct SceneState {
    pub angle: f32,
    pub drag_velocity: f32,
    pub spin: f32,
    pub cols: u32,
    pub zoom: f32,
    pub active_index: Option<usize>,
    pub angle_target: Option<f32>,
    pub zoom_target: Option<f32>,
    pub queued_bits: u64,
    pub touch_active: bool,
}

pub struct DrumRenderer {
    device: Device,
    queue: CommandQueue,
    solid_pipeline: metal::RenderPipelineState,
    tex_pipeline: Option<metal::RenderPipelineState>,
    depth: metal::DepthStencilState,
    sampler: Option<metal::SamplerState>,
    drum_vertex_buffer: Buffer,
    drum_index_buffer: Buffer,
    drum_index_count: u32,
    card_vertex_buffer: Option<Buffer>,
    card_index_buffer: Option<Buffer>,
    card_index_count: u32,
    uniform_buffer: Buffer,
    card_uniform_buffer: Buffer,
    atlas_texture: Option<metal::Texture>,
    depth_texture: Option<metal::Texture>,
    depth_size: (u32, u32),
    base_cam_dist: f32,
    state: Arc<Mutex<SceneState>>,
}

impl DrumRenderer {
    pub fn new(state: Arc<Mutex<SceneState>>, prepared: Option<&PreparedScene>) -> Option<Self> {
        let device = Device::system_default()?;
        let queue = device.new_command_queue();

        let library = device
            .new_library_with_source(SHADER, &CompileOptions::new())
            .ok()?;
        let solid_vfn = library.get_function("solid_vertex", None).ok()?;
        let solid_ffn = library.get_function("solid_fragment", None).ok()?;

        let solid_layout = {
            let mut vd = VertexDescriptor::new();
            let pos = vd.attributes().object_at(0).unwrap();
            pos.set_format(metal::MTLVertexFormat::Float3);
            pos.set_offset(0);
            pos.set_buffer_index(0);
            let color = vd.attributes().object_at(1).unwrap();
            color.set_format(metal::MTLVertexFormat::Float3);
            color.set_offset(12);
            color.set_buffer_index(0);
            let layout = vd.layouts().object_at(0).unwrap();
            layout.set_stride(24);
            layout.set_step_function(MTLVertexStepFunction::PerVertex);
            vd
        };

        let solid_pipeline = {
            let mut d = RenderPipelineDescriptor::new();
            d.set_vertex_function(Some(&solid_vfn));
            d.set_fragment_function(Some(&solid_ffn));
            d.set_vertex_descriptor(Some(&solid_layout));
            d.color_attachments()
                .object_at(0)
                .unwrap()
                .set_pixel_format(MTLPixelFormat::BGRA8Unorm);
            d.set_depth_attachment_pixel_format(MTLPixelFormat::Depth32Float);
            device.new_render_pipeline_state(&d).ok()?
        };

        let depth_desc = metal::DepthStencilDescriptor::new();
        depth_desc.set_depth_compare_function(metal::MTLCompareFunction::Less);
        depth_desc.set_depth_write_enabled(true);
        let depth = device.new_depth_stencil_state(&depth_desc);

        let drum_radius = prepared
            .map(|p| p.layout.radius)
            .unwrap_or(default_drum_radius(1));
        let cam_dist = camera_distance(drum_radius);
        let drum_half_h = prepared
            .map(|p| p.layout.height_total * 0.5)
            .unwrap_or(default_drum_half_h(1));
        let (drum_vertices, drum_indices) = build_drum_mesh(drum_radius, drum_half_h);
        let drum_vertex_buffer = device.new_buffer_with_data(
            drum_vertices.as_ptr() as *const _,
            (drum_vertices.len() * std::mem::size_of::<SolidVertex>()) as u64,
            MTLResourceOptions::StorageModeShared,
        );
        let drum_index_buffer = device.new_buffer_with_data(
            drum_indices.as_ptr() as *const _,
            (drum_indices.len() * std::mem::size_of::<u16>()) as u64,
            MTLResourceOptions::StorageModeShared,
        );

        let uniform_buffer = device.new_buffer(
            std::mem::size_of::<Uniforms>() as u64,
            MTLResourceOptions::StorageModeShared,
        );
        let card_uniform_buffer = device.new_buffer(
            std::mem::size_of::<CardUniforms>() as u64,
            MTLResourceOptions::StorageModeShared,
        );

        let mut tex_pipeline = None;
        let mut sampler = None;
        let mut card_vertex_buffer = None;
        let mut card_index_buffer = None;
        let mut card_index_count = 0;
        let mut atlas_texture = None;

        if let Some(scene) = prepared {
            if !scene.cards.is_empty() {
                let tex_vfn = library.get_function("tex_vertex", None).ok()?;
                let tex_ffn = library.get_function("tex_fragment", None).ok()?;
                let tex_layout = {
                    let mut vd = VertexDescriptor::new();
                    let pos = vd.attributes().object_at(0).unwrap();
                    pos.set_format(metal::MTLVertexFormat::Float3);
                    pos.set_offset(0);
                    pos.set_buffer_index(0);
                    let uv = vd.attributes().object_at(1).unwrap();
                    uv.set_format(metal::MTLVertexFormat::Float2);
                    uv.set_offset(12);
                    uv.set_buffer_index(0);
                    let card_idx = vd.attributes().object_at(2).unwrap();
                    card_idx.set_format(metal::MTLVertexFormat::Float);
                    card_idx.set_offset(20);
                    card_idx.set_buffer_index(0);
                    let local_uv = vd.attributes().object_at(3).unwrap();
                    local_uv.set_format(metal::MTLVertexFormat::Float2);
                    local_uv.set_offset(24);
                    local_uv.set_buffer_index(0);
                    let layout = vd.layouts().object_at(0).unwrap();
                    layout.set_stride(32);
                    layout.set_step_function(MTLVertexStepFunction::PerVertex);
                    vd
                };
                tex_pipeline = {
                    let mut d = RenderPipelineDescriptor::new();
                    d.set_vertex_function(Some(&tex_vfn));
                    d.set_fragment_function(Some(&tex_ffn));
                    d.set_vertex_descriptor(Some(&tex_layout));
                    d.color_attachments()
                        .object_at(0)
                        .unwrap()
                        .set_pixel_format(MTLPixelFormat::BGRA8Unorm);
                    d.set_depth_attachment_pixel_format(MTLPixelFormat::Depth32Float);
                    device.new_render_pipeline_state(&d).ok()
                };

                let sampler_desc = SamplerDescriptor::new();
                sampler_desc.set_min_filter(MTLSamplerMinMagFilter::Linear);
                sampler_desc.set_mag_filter(MTLSamplerMinMagFilter::Linear);
                sampler_desc.set_address_mode_s(MTLSamplerAddressMode::ClampToEdge);
                sampler_desc.set_address_mode_t(MTLSamplerAddressMode::ClampToEdge);
                sampler = Some(device.new_sampler(&sampler_desc));

                let card_w = slot_card_width(scene.layout.cols, scene.layout.radius);
                let (card_vertices, card_indices) =
                    build_card_mesh(&scene.cards, card_w, CARD_H);
                card_vertex_buffer = Some(device.new_buffer_with_data(
                    card_vertices.as_ptr() as *const _,
                    (card_vertices.len() * std::mem::size_of::<TexVertex>()) as u64,
                    MTLResourceOptions::StorageModeShared,
                ));
                card_index_buffer = Some(device.new_buffer_with_data(
                    card_indices.as_ptr() as *const _,
                    (card_indices.len() * std::mem::size_of::<u16>()) as u64,
                    MTLResourceOptions::StorageModeShared,
                ));
                card_index_count = card_indices.len() as u32;
                atlas_texture = upload_atlas(&device, scene);
            }
        }

        Some(Self {
            device,
            queue,
            solid_pipeline,
            tex_pipeline,
            depth,
            sampler,
            drum_vertex_buffer,
            drum_index_buffer,
            drum_index_count: drum_indices.len() as u32,
            card_vertex_buffer,
            card_index_buffer,
            card_index_count,
            uniform_buffer,
            card_uniform_buffer,
            atlas_texture,
            depth_texture: None,
            depth_size: (0, 0),
            base_cam_dist: cam_dist,
            state,
        })
    }

    pub fn draw(&mut self, drawable: &MetalDrawableRef, width: f32, height: f32) {
        let texture = drawable.texture();
        self.ensure_depth(width as u32, height as u32);

        {
            let s = self.state.lock().unwrap();
            let cam_dist = self.base_cam_dist * (1.0 - s.zoom * 0.55).max(0.4);
            let active_index = s
                .active_index
                .map(|i| i as f32)
                .unwrap_or(-1.0);
            let u = Uniforms {
                angle: s.angle,
                aspect: width / height.max(1.0),
                cam_dist,
                active_index,
            };
            let cu = CardUniforms {
                queued_lo: s.queued_bits as u32,
                queued_hi: (s.queued_bits >> 32) as u32,
                _pad: [0, 0],
            };
            unsafe {
                *(self.uniform_buffer.contents() as *mut Uniforms) = u;
                *(self.card_uniform_buffer.contents() as *mut CardUniforms) = cu;
            }
        }

        let Some(depth) = self.depth_texture.as_ref() else {
            return;
        };

        let pass = RenderPassDescriptor::new();
        let ca = pass.color_attachments().object_at(0).unwrap();
        ca.set_texture(Some(texture));
        ca.set_load_action(MTLLoadAction::Clear);
        ca.set_store_action(MTLStoreAction::Store);
        ca.set_clear_color(MTLClearColor::new(0.08, 0.06, 0.12, 1.0));
        let da = pass.depth_attachment().unwrap();
        da.set_texture(Some(depth));
        da.set_load_action(MTLLoadAction::Clear);
        da.set_store_action(MTLStoreAction::DontCare);
        da.set_clear_depth(1.0);

        let cmd = self.queue.new_command_buffer();
        let enc = cmd.new_render_command_encoder(&pass);
        enc.set_viewport(metal::MTLViewport {
            originX: 0.0,
            originY: 0.0,
            width: width as f64,
            height: height as f64,
            znear: 0.0,
            zfar: 1.0,
        });
        enc.set_depth_stencil_state(&self.depth);
        enc.set_cull_mode(metal::MTLCullMode::None);
        enc.set_vertex_buffer(1, Some(&self.uniform_buffer), 0);

        enc.set_render_pipeline_state(&self.solid_pipeline);
        enc.set_vertex_buffer(0, Some(&self.drum_vertex_buffer), 0);
        enc.draw_indexed_primitives(
            MTLPrimitiveType::Triangle,
            self.drum_index_count as u64,
            MTLIndexType::UInt16,
            &self.drum_index_buffer,
            0,
        );

        if self.card_index_count > 0 {
            if let (Some(tex_pipe), Some(atlas), Some(sampler), Some(vb), Some(ib)) = (
                self.tex_pipeline.as_ref(),
                self.atlas_texture.as_ref(),
                self.sampler.as_ref(),
                self.card_vertex_buffer.as_ref(),
                self.card_index_buffer.as_ref(),
            ) {
                enc.set_render_pipeline_state(tex_pipe);
                enc.set_vertex_buffer(0, Some(vb), 0);
                enc.set_fragment_buffer(1, Some(&self.uniform_buffer), 0);
                enc.set_fragment_buffer(2, Some(&self.card_uniform_buffer), 0);
                enc.set_fragment_texture(0, Some(atlas));
                enc.set_fragment_sampler_state(0, Some(sampler));
                enc.draw_indexed_primitives(
                    MTLPrimitiveType::Triangle,
                    self.card_index_count as u64,
                    MTLIndexType::UInt16,
                    ib,
                    0,
                );
            }
        }

        enc.end_encoding();
        cmd.present_drawable(drawable);
        cmd.commit();
    }

    fn ensure_depth(&mut self, w: u32, h: u32) {
        if self.depth_size == (w, h) && self.depth_texture.is_some() {
            return;
        }
        let desc = TextureDescriptor::new();
        desc.set_width(w as u64);
        desc.set_height(h as u64);
        desc.set_pixel_format(MTLPixelFormat::Depth32Float);
        desc.set_usage(MTLTextureUsage::RenderTarget);
        desc.set_storage_mode(metal::MTLStorageMode::Private);
        self.depth_texture = Some(self.device.new_texture(&desc));
        self.depth_size = (w, h);
    }
}

const CARD_W: f32 = 3.2;
const CARD_GAP: f32 = 0.3;
pub(crate) const CARD_H: f32 = 1.25;
pub(crate) const CARD_SURFACE_PUSH: f32 = 0.08;
const PREVIEW_COLS: u32 = 1;

fn default_drum_radius(cols: u32) -> f32 {
    (cols as f32 * (CARD_W + CARD_GAP)) / (2.0 * PI)
}

fn default_drum_half_h(rows: u32) -> f32 {
    ((rows as f32 * 1.4) + 0.6) * 0.5
}

pub(crate) fn slot_card_width(cols: u32, radius: f32) -> f32 {
    let arc = (2.0 * PI * radius) / cols.max(1) as f32;
    CARD_W.min(arc * 0.92)
}

pub(crate) fn camera_distance(radius: f32) -> f32 {
    let base = default_drum_radius(PREVIEW_COLS).max(0.5);
    6.5 * (radius / base).max(0.35)
}

fn upload_atlas(device: &Device, scene: &PreparedScene) -> Option<metal::Texture> {
    let desc = TextureDescriptor::new();
    desc.set_width(scene.atlas_width as u64);
    desc.set_height(scene.atlas_height as u64);
    desc.set_pixel_format(MTLPixelFormat::RGBA8Unorm);
    desc.set_usage(MTLTextureUsage::ShaderRead);
    desc.set_storage_mode(metal::MTLStorageMode::Shared);
    let tex = device.new_texture(&desc);
    let region = MTLRegion {
        origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
        size: MTLSize {
            width: scene.atlas_width as u64,
            height: scene.atlas_height as u64,
            depth: 1,
        },
    };
    tex.replace_region(
        region,
        0,
        scene.atlas_rgba.as_ptr() as *const _,
        (scene.atlas_width * 4) as u64,
    );
    Some(tex)
}

fn build_drum_mesh(radius: f32, half_h: f32) -> (Vec<SolidVertex>, Vec<u16>) {
    let segments = 32usize;
    let rows = 8usize;
    let half_h = half_h.max(0.8);
    let palette: [[f32; 3]; 6] = [
        [0.95, 0.12, 0.18],
        [1.0, 0.72, 0.0],
        [0.0, 1.0, 0.53],
        [0.95, 0.2, 0.55],
        [0.2, 0.75, 1.0],
        [0.98, 0.98, 0.92],
    ];

    let mut vertices = Vec::new();
    let mut indices = Vec::new();

    for row in 0..rows {
        let y0 = -half_h + (row as f32 / rows as f32) * (half_h * 2.0);
        let y1 = -half_h + ((row + 1) as f32 / rows as f32) * (half_h * 2.0);
        let color = palette[row % palette.len()];
        for seg in 0..segments {
            let a0 = (seg as f32 / segments as f32) * PI * 2.0;
            let a1 = ((seg + 1) as f32 / segments as f32) * PI * 2.0;
            let base = vertices.len() as u16;
            vertices.extend_from_slice(&[
                SolidVertex {
                    position: [a0.cos() * radius, y0, a0.sin() * radius],
                    color,
                },
                SolidVertex {
                    position: [a1.cos() * radius, y0, a1.sin() * radius],
                    color,
                },
                SolidVertex {
                    position: [a1.cos() * radius, y1, a1.sin() * radius],
                    color,
                },
                SolidVertex {
                    position: [a0.cos() * radius, y1, a0.sin() * radius],
                    color,
                },
            ]);
            indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        }
    }

    (vertices, indices)
}

fn transform_card_point(local: [f32; 3], card: &CardInstance) -> [f32; 3] {
    let c = card.theta.cos();
    let s = card.theta.sin();
    let rx = c * local[0] + s * local[2];
    let ry = local[1];
    let rz = -s * local[0] + c * local[2];
    let mut wx = rx + card.x;
    let wy = ry + card.y;
    let mut wz = rz + card.z;
    let radial = (card.x * card.x + card.z * card.z).sqrt().max(1e-4);
    wx += (card.x / radial) * CARD_SURFACE_PUSH;
    wz += (card.z / radial) * CARD_SURFACE_PUSH;
    [wx, wy, wz]
}

fn build_card_mesh(cards: &[CardInstance], card_w: f32, card_h: f32) -> (Vec<TexVertex>, Vec<u16>) {
    let hw = card_w * 0.5;
    let hh = card_h * 0.5;
    let locals = [
        [-hw, -hh, 0.0],
        [hw, -hh, 0.0],
        [hw, hh, 0.0],
        [-hw, hh, 0.0],
    ];
    let uvs = [
        [0.0, 1.0],
        [1.0, 1.0],
        [1.0, 0.0],
        [0.0, 0.0],
    ];

    let mut vertices = Vec::new();
    let mut indices = Vec::new();

    for card in cards {
        let base = vertices.len() as u16;
        let card_index = card.index as f32;
        let mut i = 0;
        while i < 4 {
            let wp = transform_card_point(locals[i], card);
            let lu = uvs[i][0];
            let lv = uvs[i][1];
            let u = card.u0 + (card.u1 - card.u0) * lu;
            let v = card.v0 + (card.v1 - card.v0) * lv;
            vertices.push(TexVertex {
                position: wp,
                uv: [u, v],
                card_index,
                local_uv: [lu, lv],
            });
            i += 1;
        }
        indices.extend_from_slice(&[
            base,
            base + 1,
            base + 2,
            base,
            base + 2,
            base + 3,
        ]);
    }

    (vertices, indices)
}
