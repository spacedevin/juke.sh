//! Metal drum preview + textured card instances, category labels, empty slots.

use std::f32::consts::PI;
use std::sync::{Arc, Mutex};

use metal::{
    Buffer, CommandQueue, CompileOptions, Device, MTLBlendFactor, MTLClearColor, MTLIndexType,
    MTLLoadAction, MTLPixelFormat, MTLPrimitiveType, MTLRegion, MTLResourceOptions,
    MTLSamplerAddressMode, MTLSamplerMinMagFilter, MTLSize, MTLStoreAction, MTLTextureUsage,
    MTLVertexStepFunction, MetalDrawableRef, RenderPassDescriptor, RenderPipelineDescriptor,
    SamplerDescriptor, TextureDescriptor, VertexDescriptor,
};

use crate::camera::{base_cam_dist, CameraParams};
use crate::scene_data::{CardInstance, PreparedScene};

const SHADER: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct SceneUniforms {
    float angle;
    float aspect;
    float cam_dist;
    float proj_f;
    float active_slot;
    float lighting;
    float time;
    float neon_intensity;
    float show_categories;
    float zoom_display;
    float dir_light_az;
    float neon_emissive;
    float _pad0;
    float3 neon_color1;
    float _pad1;
    float3 neon_color2;
    float _pad2;
    float3 active_accent;
    float _pad3;
    float3 active_bg;
    float _pad4;
    float3 active_alt;
    float _pad5;
};

struct CardUniforms {
    uint queued[16];
    uint slot_count;
    uint2 _pad;
};

struct SolidIn {
    float3 position [[attribute(0)]];
    float3 color [[attribute(1)]];
    float emissive [[attribute(2)]];
    float3 normal [[attribute(3)]];
    float flags [[attribute(4)]];
};

struct TexIn {
    float3 position [[attribute(0)]];
    float2 uv [[attribute(1)]];
    float slot_index [[attribute(2)]];
    float2 local_uv [[attribute(3)]];
    float is_empty [[attribute(4)]];
    float3 normal [[attribute(5)]];
};

struct SolidOut {
    float4 position [[position]];
    float3 color;
    float emissive;
    float3 world_pos;
    float3 world_normal;
    float flags;
};

struct TexOut {
    float4 position [[position]];
    float2 uv;
    float slot_index;
    float2 local_uv;
    float is_empty;
    float3 world_pos;
    float3 world_normal;
};

float3 rotate_y(float3 p, float a) {
    float c = cos(a);
    float s = sin(a);
    return float3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

float4 project(float3 p, constant SceneUniforms& u) {
    float3 eye = float3(p.x, p.y + 0.15, p.z - u.cam_dist);
    float2 ndc = float2(eye.x * u.proj_f / u.aspect, eye.y * u.proj_f) / (-eye.z);
    float depth = clamp((-eye.z - 0.1) / 99.9, 0.0, 1.0);
    return float4(ndc, depth, 1.0);
}

bool slot_is_queued(int idx, constant CardUniforms& cu) {
    if (idx < 0 || idx >= (int)cu.slot_count) { return false; }
    uint word = (uint)idx / 32u;
    uint bit = (uint)idx % 32u;
    if (word >= 16u) { return false; }
    return ((cu.queued[word] >> bit) & 1u) != 0u;
}

float ftt(float fit, float tight, float z) {
    return fit + (tight - fit) * z;
}

float3 shade_surface(float3 base, float3 world_pos, float3 world_normal, float emissive,
                     constant SceneUniforms& u) {
    float L = u.lighting;
    float z = u.zoom_display;
    float3 N = normalize(world_normal);

    float d_hemi = ftt(0.95, 0.0, z);
    float d_dir = ftt(1.5, 0.0, z);
    float d_amb = ftt(0.0, 1.1, z);
    float d_cam = ftt(0.0, 0.4, z);

    float r_hemi;
    float r_dir;
    bool has_active = u.active_slot >= 0.0;
    if (has_active && L > 0.25) {
        r_hemi = ftt(0.05, 0.0, z);
        r_dir = ftt(0.05, 0.0, z);
    } else {
        r_hemi = ftt(0.15, 0.0, z);
        r_dir = ftt(0.25, 0.0, z);
    }

    float hemi_i = mix(d_hemi, r_hemi, L);
    float dir_i = mix(d_dir, r_dir, L);
    float amb_i = d_amb * (1.0 - L);
    float cam_i = d_cam * (1.0 - L);

    float3 warm_sky = float3(1.0, 0.98, 0.94);
    float3 cool_sky = float3(0.55, 0.65, 0.85);
    float3 sky = mix(warm_sky, cool_sky, L * 0.6);
    float3 ground = mix(float3(0.12, 0.10, 0.08), float3(0.02, 0.02, 0.06), L);
    float hemi_factor = dot(N, float3(0.0, 1.0, 0.0)) * 0.5 + 0.5;
    float3 hemi_lit = mix(ground, sky, hemi_factor) * hemi_i;

    float az = u.dir_light_az;
    float3 light_pos = float3(sin(az) * 100.0, 100.0, cos(az) * 100.0);
    float3 light_dir = normalize(-light_pos);
    float3 dir_col = mix(float3(1.0, 0.93, 0.87), (u.neon_color1 + u.neon_color2) * 0.5, L * 0.5);
    float NdotL = max(dot(N, light_dir), 0.0);
    float3 diffuse = dir_col * NdotL * dir_i;

    float3 amb_warm = float3(1.0, 0.88, 0.72);
    float3 ambient = amb_warm * amb_i * 0.35;

    float az_off = az + 1.2566370614359172;
    float3 fill_pos = float3(sin(az_off) * 35.0, 22.0, cos(az_off) * 35.0);
    float3 to_center = normalize(float3(0.0, 0.15, 0.0) - fill_pos);
    float fill_front = max(dot(N, to_center), 0.0) * L * 0.30 * z;
    float3 fill_amber = float3(1.0, 0.85, 0.6) * fill_front;

    float3 fill_pink_dir = normalize(float3(12.0, 18.0, -8.0));
    float fill_pink = max(dot(N, fill_pink_dir), 0.0) * L * 1.4 * 0.12 * z;
    float3 pink = float3(1.0, 0.4, 0.7) * fill_pink;

    float3 cam_pos = float3(0.45, 0.15, -u.cam_dist);
    float3 cam_dir = normalize(float3(0.0, 0.0, 0.0) - cam_pos);
    float cam_fill = max(dot(N, cam_dir), 0.0) * cam_i * 0.5;
    float3 cam_lit = float3(1.0, 0.9, 0.75) * cam_fill;

    float3 lit = base * (hemi_lit + diffuse + ambient + fill_amber + pink + cam_lit);

    if (emissive > 1.5) {
        float3 neon_c = mix(u.neon_color1, u.neon_color2, step(0.0, world_pos.y));
        lit += neon_c * emissive * u.neon_intensity * 0.12;
    } else if (emissive > 0.01) {
        lit += base * emissive * u.neon_emissive * 0.35;
    }

    if (has_active && L > 0.25) {
        float cycle = (sin(u.time * 1.5) + 1.0) * 0.5;
        float3 accent_mix = mix(u.active_accent, u.active_bg, cycle);
        lit = mix(lit, lit * accent_mix * 1.35, L * 0.30);
    }

    return lit;
}

vertex SolidOut solid_vertex(SolidIn in [[stage_in]], constant SceneUniforms& u [[buffer(1)]]) {
    SolidOut vert;
    float3 wp;
    float3 wn;
    if (in.flags > 0.5) {
        wp = in.position;
        wn = in.normal;
    } else {
        wp = rotate_y(in.position, u.angle);
        wn = rotate_y(in.normal, u.angle);
    }
    vert.position = project(wp, u);
    vert.color = in.color;
    vert.emissive = in.emissive;
    vert.world_pos = wp;
    vert.world_normal = wn;
    vert.flags = in.flags;
    return vert;
}

fragment float4 solid_fragment(SolidOut in [[stage_in]], constant SceneUniforms& u [[buffer(1)]]) {
    float3 base = in.color;
    if (in.flags > 0.5 && in.flags < 1.5) {
        float2 uv = in.world_pos.xz / 25.0;
        float2 cell = floor(uv);
        float checker = fmod(cell.x + cell.y, 2.0);
        base = mix(float3(0.02, 0.02, 0.02), float3(0.91, 0.91, 0.91), checker);
        base *= float3(0.70, 0.72, 0.75);
        float dist = length(in.world_pos.xz);
        float drum_shadow = smoothstep(14.0, 4.0, dist);
        base *= mix(1.0, 0.38, drum_shadow);
    }
    float3 rgb = shade_surface(base, in.world_pos, in.world_normal, in.emissive, u);
    return float4(rgb, 1.0);
}

fragment float4 glass_fragment(SolidOut in [[stage_in]], constant SceneUniforms& u [[buffer(1)]]) {
    float fresnel = pow(1.0 - abs(dot(normalize(in.world_normal),
        normalize(float3(0.0, 0.15, -u.cam_dist) - in.world_pos))), 2.0);
    float3 base = mix(in.color, float3(0.85, 0.92, 1.0), 0.35);
    float3 rgb = shade_surface(base, in.world_pos, in.world_normal, 0.05, u);
    rgb += float3(0.4, 0.55, 0.7) * fresnel * 0.25;
    return float4(rgb, 0.20 + fresnel * 0.15);
}

vertex TexOut tex_vertex(TexIn in [[stage_in]], constant SceneUniforms& u [[buffer(1)]]) {
    TexOut vert;
    float3 wp = rotate_y(in.position, u.angle);
    float3 wn = rotate_y(in.normal, u.angle);
    vert.position = project(wp, u);
    vert.uv = in.uv;
    vert.slot_index = in.slot_index;
    vert.local_uv = in.local_uv;
    vert.is_empty = in.is_empty;
    vert.world_pos = wp;
    vert.world_normal = wn;
    return vert;
}

fragment float4 tex_fragment(TexOut in [[stage_in]],
                             constant SceneUniforms& u [[buffer(1)]],
                             constant CardUniforms& cu [[buffer(2)]],
                             texture2d<float> atlas [[texture(0)]],
                             sampler atlas_sm [[sampler(0)]]) {
    float4 c;
    if (in.is_empty > 0.5) {
        float edge = min(min(in.local_uv.x, 1.0 - in.local_uv.x),
                         min(in.local_uv.y, 1.0 - in.local_uv.y));
        float border = smoothstep(0.08, 0.02, edge);
        c = float4(0.06, 0.05, 0.08, 0.55 + border * 0.25);
    } else {
        c = atlas.sample(atlas_sm, in.uv);
        if (c.a < 0.05) { discard_fragment(); }
    }
    int idx = int(in.slot_index + 0.5);
    bool is_active = u.active_slot >= 0.0 && abs(in.slot_index - u.active_slot) < 0.5;
    bool is_queued = slot_is_queued(idx, cu);
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
    float3 rgb = shade_surface(c.rgb, in.world_pos, in.world_normal, glow * 0.6, u);
    return float4(rgb, c.a);
}

fragment float4 cat_fragment(TexOut in [[stage_in]],
                              constant SceneUniforms& u [[buffer(1)]],
                              texture2d<float> cat_atlas [[texture(1)]],
                              sampler cat_sm [[sampler(0)]]) {
    if (u.show_categories < 0.5) { discard_fragment(); }
    float4 c = cat_atlas.sample(cat_sm, in.uv);
    if (c.a < 0.05) { discard_fragment(); }
    float3 rgb = shade_surface(c.rgb, in.world_pos, in.world_normal, 0.35, u);
    return float4(rgb, c.a);
}
"#;

#[repr(C)]
#[derive(Clone, Copy)]
struct SolidVertex {
    position: [f32; 3],
    color: [f32; 3],
    emissive: f32,
    normal: [f32; 3],
    flags: f32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct TexVertex {
    position: [f32; 3],
    uv: [f32; 2],
    slot_index: f32,
    local_uv: [f32; 2],
    is_empty: f32,
    normal: [f32; 3],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SceneUniforms {
    angle: f32,
    aspect: f32,
    cam_dist: f32,
    proj_f: f32,
    active_slot: f32,
    lighting: f32,
    time: f32,
    neon_intensity: f32,
    show_categories: f32,
    zoom_display: f32,
    dir_light_az: f32,
    neon_emissive: f32,
    _pad0: f32,
    neon_color1: [f32; 3],
    _pad1: f32,
    neon_color2: [f32; 3],
    _pad2: f32,
    active_accent: [f32; 3],
    _pad3: f32,
    active_bg: [f32; 3],
    _pad4: f32,
    active_alt: [f32; 3],
    _pad5: f32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CardUniforms {
    queued: [u32; 16],
    slot_count: u32,
    _pad: [u32; 2],
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DragAxis {
    None,
    Horizontal,
    Vertical,
}

pub struct SceneState {
    pub angle: f32,
    pub drag_velocity: f32,
    pub spin: f32,
    pub cols: u32,
    pub zoom: f32,
    pub zoom_display: f32,
    pub zoom_velocity: f32,
    pub pinch_active: bool,
    pub lighting: f32,
    pub zoom_tight: f32,
    pub zoom_flat: f32,
    pub show_categories: bool,
    pub audio_enabled: bool,
    pub active_slot: Option<usize>,
    pub active_uri: String,
    pub active_title: String,
    pub angle_target: Option<f32>,
    pub zoom_pending_after_snap: bool,
    pub queued_mask: Vec<u32>,
    pub total_slots: u32,
    pub touch_active: bool,
    pub press_started_at: Option<f64>,
    pub drag_axis: DragAxis,
    pub time: f32,
    pub active_accent: [f32; 3],
    pub active_bg: [f32; 3],
    pub active_alt: [f32; 3],
    pub height_total: f32,
    pub radius: f32,
}

struct MeshBatch {
    vertex_buffer: Buffer,
    index_buffer: Buffer,
    index_count: u32,
    /// When true, skip this batch.
    skip: bool,
    /// When true, draw with alpha-blended glass pipeline.
    glass: bool,
}

pub struct DrumRenderer {
    device: Device,
    queue: CommandQueue,
    solid_pipeline: metal::RenderPipelineState,
    glass_pipeline: Option<metal::RenderPipelineState>,
    tex_pipeline: Option<metal::RenderPipelineState>,
    cat_pipeline: Option<metal::RenderPipelineState>,
    depth: metal::DepthStencilState,
    sampler: Option<metal::SamplerState>,
    drum_batches: Vec<MeshBatch>,
    card_vertex_buffer: Option<Buffer>,
    card_index_buffer: Option<Buffer>,
    card_index_count: u32,
    cat_vertex_buffer: Option<Buffer>,
    cat_index_buffer: Option<Buffer>,
    cat_index_count: u32,
    scene_uniform_buffer: Buffer,
    card_uniform_buffer: Buffer,
    atlas_texture: Option<metal::Texture>,
    category_texture: Option<metal::Texture>,
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
            let emissive = vd.attributes().object_at(2).unwrap();
            emissive.set_format(metal::MTLVertexFormat::Float);
            emissive.set_offset(24);
            emissive.set_buffer_index(0);
            let normal = vd.attributes().object_at(3).unwrap();
            normal.set_format(metal::MTLVertexFormat::Float3);
            normal.set_offset(28);
            normal.set_buffer_index(0);
            let flags = vd.attributes().object_at(4).unwrap();
            flags.set_format(metal::MTLVertexFormat::Float);
            flags.set_offset(40);
            flags.set_buffer_index(0);
            let layout = vd.layouts().object_at(0).unwrap();
            layout.set_stride(44);
            layout.set_step_function(MTLVertexStepFunction::PerVertex);
            vd
        };
        let solid_pipeline = build_solid_pipeline(&device, &library, &solid_layout)?;
        let glass_pipeline = build_glass_pipeline(&device, &library, &solid_layout);

        let depth_desc = metal::DepthStencilDescriptor::new();
        depth_desc.set_depth_compare_function(metal::MTLCompareFunction::Less);
        depth_desc.set_depth_write_enabled(true);
        let depth = device.new_depth_stencil_state(&depth_desc);

        let scene = prepared?;
        let drum_radius = scene.layout.radius;
        let drum_half_h = scene.layout.height_total * 0.5;
        let cam_dist = base_cam_dist(drum_radius);
        let drum_batches = build_drum_batches(&device, drum_radius, drum_half_h, scene.layout.cols);

        let scene_uniform_buffer = device.new_buffer(
            std::mem::size_of::<SceneUniforms>() as u64,
            MTLResourceOptions::StorageModeShared,
        );
        let card_uniform_buffer = device.new_buffer(
            std::mem::size_of::<CardUniforms>() as u64,
            MTLResourceOptions::StorageModeShared,
        );

        let sampler_desc = SamplerDescriptor::new();
        sampler_desc.set_min_filter(MTLSamplerMinMagFilter::Linear);
        sampler_desc.set_mag_filter(MTLSamplerMinMagFilter::Linear);
        sampler_desc.set_address_mode_s(MTLSamplerAddressMode::ClampToEdge);
        sampler_desc.set_address_mode_t(MTLSamplerAddressMode::ClampToEdge);
        let sampler = device.new_sampler(&sampler_desc);

        let card_w = slot_card_width(scene.layout.cols, scene.layout.radius);
        let (card_vertices, card_indices) = build_card_mesh(&scene.cards, card_w, CARD_H);
        let card_vertex_buffer = device.new_buffer_with_data(
            card_vertices.as_ptr() as *const _,
            (card_vertices.len() * std::mem::size_of::<TexVertex>()) as u64,
            MTLResourceOptions::StorageModeShared,
        );
        let card_index_buffer = device.new_buffer_with_data(
            card_indices.as_ptr() as *const _,
            (card_indices.len() * std::mem::size_of::<u16>()) as u64,
            MTLResourceOptions::StorageModeShared,
        );
        let card_index_count = card_indices.len() as u32;

        let (cat_v, cat_i) = build_category_mesh(scene);
        let (cat_vertex_buffer, cat_index_buffer, cat_index_count) = if !cat_i.is_empty() {
            (
                Some(device.new_buffer_with_data(
                    cat_v.as_ptr() as *const _,
                    (cat_v.len() * std::mem::size_of::<TexVertex>()) as u64,
                    MTLResourceOptions::StorageModeShared,
                )),
                Some(device.new_buffer_with_data(
                    cat_i.as_ptr() as *const _,
                    (cat_i.len() * std::mem::size_of::<u16>()) as u64,
                    MTLResourceOptions::StorageModeShared,
                )),
                cat_i.len() as u32,
            )
        } else {
            (None, None, 0)
        };

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
            let slot = vd.attributes().object_at(2).unwrap();
            slot.set_format(metal::MTLVertexFormat::Float);
            slot.set_offset(20);
            slot.set_buffer_index(0);
            let local_uv = vd.attributes().object_at(3).unwrap();
            local_uv.set_format(metal::MTLVertexFormat::Float2);
            local_uv.set_offset(24);
            local_uv.set_buffer_index(0);
            let empty = vd.attributes().object_at(4).unwrap();
            empty.set_format(metal::MTLVertexFormat::Float);
            empty.set_offset(32);
            empty.set_buffer_index(0);
            let normal = vd.attributes().object_at(5).unwrap();
            normal.set_format(metal::MTLVertexFormat::Float3);
            normal.set_offset(36);
            normal.set_buffer_index(0);
            let layout = vd.layouts().object_at(0).unwrap();
            layout.set_stride(48);
            layout.set_step_function(MTLVertexStepFunction::PerVertex);
            vd
        };
        let tex_pipeline = build_tex_pipeline(&device, &library, &tex_layout, false);
        if tex_pipeline.is_none() {
            eprintln!("[juke-scene] tex pipeline creation failed");
        }
        let cat_pipeline = build_tex_pipeline(&device, &library, &tex_layout, true);

        let atlas_texture =
            upload_rgba(&device, scene.atlas_width, scene.atlas_height, &scene.atlas_rgba);
        if let Some(ref atlas) = atlas_texture {
            let opaque = scene
                .atlas_rgba
                .chunks(4)
                .filter(|px| px.len() == 4 && px[3] > 8)
                .count();
            eprintln!(
                "[juke-scene] atlas {}x{} cards={} opaque_px={}",
                scene.atlas_width,
                scene.atlas_height,
                scene.cards.len(),
                opaque
            );
        }
        let category_texture = if scene.category_atlas_width > 0 {
            upload_rgba(
                &device,
                scene.category_atlas_width,
                scene.category_atlas_height,
                &scene.category_atlas_rgba,
            )
        } else {
            None
        };

        Some(Self {
            device,
            queue,
            solid_pipeline,
            glass_pipeline,
            tex_pipeline,
            cat_pipeline,
            depth,
            sampler: Some(sampler),
            drum_batches,
            card_vertex_buffer: Some(card_vertex_buffer),
            card_index_buffer: Some(card_index_buffer),
            card_index_count,
            cat_vertex_buffer,
            cat_index_buffer,
            cat_index_count,
            scene_uniform_buffer,
            card_uniform_buffer,
            atlas_texture,
            category_texture,
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
            let mut s = self.state.lock().unwrap();
            s.time += 1.0 / 60.0;
            let aspect = width / height.max(1.0);
            let params = CameraParams {
                zoom: s.zoom_display,
                zoom_tight: s.zoom_tight,
                zoom_flat: s.zoom_flat,
                aspect,
                height_total: s.height_total,
                radius: s.radius,
            };
            let neon = 0.5 + s.lighting * 5.0;
            let neon_emissive = 1.0 + s.lighting * 3.5;
            let (neon_color1, neon_color2) = compute_neon_colors(
                s.time,
                s.lighting,
                s.active_slot.is_some(),
                s.active_accent,
                s.active_bg,
                s.active_alt,
            );
            let mut queued = [0u32; 16];
            for (i, w) in s.queued_mask.iter().take(16).enumerate() {
                queued[i] = *w;
            }
            let su = SceneUniforms {
                angle: s.angle,
                aspect,
                cam_dist: params.cam_dist(),
                proj_f: params.proj_f(),
                active_slot: s.active_slot.map(|i| i as f32).unwrap_or(-1.0),
                lighting: s.lighting,
                time: s.time,
                neon_intensity: neon,
                show_categories: if s.show_categories { 1.0 } else { 0.0 },
                zoom_display: s.zoom_display,
                dir_light_az: 0.0,
                neon_emissive,
                _pad0: 0.0,
                neon_color1,
                _pad1: 0.0,
                neon_color2,
                _pad2: 0.0,
                active_accent: s.active_accent,
                _pad3: 0.0,
                active_bg: s.active_bg,
                _pad4: 0.0,
                active_alt: s.active_alt,
                _pad5: 0.0,
            };
            let cu = CardUniforms {
                queued,
                slot_count: s.total_slots,
                _pad: [0, 0],
            };
            unsafe {
                *(self.scene_uniform_buffer.contents() as *mut SceneUniforms) = su;
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
        ca.set_clear_color(MTLClearColor::new(10.0 / 255.0, 5.0 / 255.0, 8.0 / 255.0, 1.0));
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
        enc.set_vertex_buffer(1, Some(&self.scene_uniform_buffer), 0);

        enc.set_render_pipeline_state(&self.solid_pipeline);
        for batch in &self.drum_batches {
            if batch.skip || batch.glass || batch.index_count == 0 {
                continue;
            }
            enc.set_vertex_buffer(0, Some(&batch.vertex_buffer), 0);
            enc.draw_indexed_primitives(
                MTLPrimitiveType::Triangle,
                batch.index_count as u64,
                MTLIndexType::UInt16,
                &batch.index_buffer,
                0,
            );
        }

        if let (Some(tex_pipe), Some(atlas), Some(sampler), Some(vb), Some(ib)) = (
            self.tex_pipeline.as_ref(),
            self.atlas_texture.as_ref(),
            self.sampler.as_ref(),
            self.card_vertex_buffer.as_ref(),
            self.card_index_buffer.as_ref(),
        ) {
            enc.set_render_pipeline_state(tex_pipe);
            enc.set_vertex_buffer(0, Some(vb), 0);
            enc.set_fragment_buffer(1, Some(&self.scene_uniform_buffer), 0);
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

        if let (Some(cat_pipe), Some(cat_tex), Some(sampler), Some(vb), Some(ib)) = (
            self.cat_pipeline.as_ref(),
            self.category_texture.as_ref(),
            self.sampler.as_ref(),
            self.cat_vertex_buffer.as_ref(),
            self.cat_index_buffer.as_ref(),
        ) {
            if self.cat_index_count > 0 {
                enc.set_render_pipeline_state(cat_pipe);
                enc.set_vertex_buffer(0, Some(vb), 0);
                enc.set_fragment_buffer(1, Some(&self.scene_uniform_buffer), 0);
                enc.set_fragment_texture(1, Some(cat_tex));
                enc.set_fragment_sampler_state(0, Some(sampler));
                enc.draw_indexed_primitives(
                    MTLPrimitiveType::Triangle,
                    self.cat_index_count as u64,
                    MTLIndexType::UInt16,
                    ib,
                    0,
                );
            }
        }

        if let Some(glass_pipe) = self.glass_pipeline.as_ref() {
            enc.set_render_pipeline_state(glass_pipe);
            for batch in &self.drum_batches {
                if batch.skip || !batch.glass || batch.index_count == 0 {
                    continue;
                }
                enc.set_vertex_buffer(0, Some(&batch.vertex_buffer), 0);
                enc.draw_indexed_primitives(
                    MTLPrimitiveType::Triangle,
                    batch.index_count as u64,
                    MTLIndexType::UInt16,
                    &batch.index_buffer,
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

pub(crate) fn slot_card_width(cols: u32, radius: f32) -> f32 {
    let arc = (2.0 * PI * radius) / cols.max(1) as f32;
    CARD_W.min(arc * 0.92)
}

fn build_solid_pipeline(
    device: &Device,
    library: &metal::Library,
    layout: &metal::VertexDescriptorRef,
) -> Option<metal::RenderPipelineState> {
    let vfn = library.get_function("solid_vertex", None).ok()?;
    let ffn = library.get_function("solid_fragment", None).ok()?;
    let mut d = RenderPipelineDescriptor::new();
    d.set_vertex_function(Some(&vfn));
    d.set_fragment_function(Some(&ffn));
    d.set_vertex_descriptor(Some(layout));
    d.color_attachments()
        .object_at(0)
        .unwrap()
        .set_pixel_format(MTLPixelFormat::BGRA8Unorm);
    d.set_depth_attachment_pixel_format(MTLPixelFormat::Depth32Float);
    device.new_render_pipeline_state(&d).ok()
}

fn build_glass_pipeline(
    device: &Device,
    library: &metal::Library,
    layout: &metal::VertexDescriptorRef,
) -> Option<metal::RenderPipelineState> {
    let vfn = library.get_function("solid_vertex", None).ok()?;
    let ffn = library.get_function("glass_fragment", None).ok()?;
    let mut d = RenderPipelineDescriptor::new();
    d.set_vertex_function(Some(&vfn));
    d.set_fragment_function(Some(&ffn));
    d.set_vertex_descriptor(Some(layout));
    let ca = d.color_attachments().object_at(0).unwrap();
    ca.set_pixel_format(MTLPixelFormat::BGRA8Unorm);
    ca.set_blending_enabled(true);
    ca.set_source_rgb_blend_factor(MTLBlendFactor::SourceAlpha);
    ca.set_destination_rgb_blend_factor(MTLBlendFactor::OneMinusSourceAlpha);
    ca.set_source_alpha_blend_factor(MTLBlendFactor::One);
    ca.set_destination_alpha_blend_factor(MTLBlendFactor::OneMinusSourceAlpha);
    d.set_depth_attachment_pixel_format(MTLPixelFormat::Depth32Float);
    device.new_render_pipeline_state(&d).ok()
}

fn build_tex_pipeline(
    device: &Device,
    library: &metal::Library,
    layout: &metal::VertexDescriptorRef,
    category: bool,
) -> Option<metal::RenderPipelineState> {
    let vfn = library.get_function("tex_vertex", None).ok()?;
    let ffn = library.get_function(if category { "cat_fragment" } else { "tex_fragment" }, None).ok()?;
    let mut d = RenderPipelineDescriptor::new();
    d.set_vertex_function(Some(&vfn));
    d.set_fragment_function(Some(&ffn));
    d.set_vertex_descriptor(Some(layout));
    let ca = d.color_attachments().object_at(0).unwrap();
    ca.set_pixel_format(MTLPixelFormat::BGRA8Unorm);
    ca.set_blending_enabled(true);
    ca.set_source_rgb_blend_factor(MTLBlendFactor::SourceAlpha);
    ca.set_destination_rgb_blend_factor(MTLBlendFactor::OneMinusSourceAlpha);
    ca.set_source_alpha_blend_factor(MTLBlendFactor::One);
    ca.set_destination_alpha_blend_factor(MTLBlendFactor::OneMinusSourceAlpha);
    d.set_depth_attachment_pixel_format(MTLPixelFormat::Depth32Float);
    device.new_render_pipeline_state(&d).ok()
}

fn upload_rgba(device: &Device, w: u32, h: u32, rgba: &[u8]) -> Option<metal::Texture> {
    if w == 0 || h == 0 || rgba.is_empty() {
        return None;
    }
    let desc = TextureDescriptor::new();
    desc.set_width(w as u64);
    desc.set_height(h as u64);
    desc.set_pixel_format(MTLPixelFormat::RGBA8Unorm);
    desc.set_usage(MTLTextureUsage::ShaderRead);
    desc.set_storage_mode(metal::MTLStorageMode::Shared);
    let tex = device.new_texture(&desc);
    tex.replace_region(
        MTLRegion {
            origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
            size: MTLSize {
                width: w as u64,
                height: h as u64,
                depth: 1,
            },
        },
        0,
        rgba.as_ptr() as *const _,
        (w * 4) as u64,
    );
    Some(tex)
}

fn push_quad(
    vertices: &mut Vec<SolidVertex>,
    indices: &mut Vec<u16>,
    p0: [f32; 3],
    p1: [f32; 3],
    p2: [f32; 3],
    p3: [f32; 3],
    color: [f32; 3],
    emissive: f32,
    normal: [f32; 3],
    flags: f32,
) {
    let base = vertices.len() as u16;
    vertices.extend_from_slice(&[
        SolidVertex { position: p0, color, emissive, normal, flags },
        SolidVertex { position: p1, color, emissive, normal, flags },
        SolidVertex { position: p2, color, emissive, normal, flags },
        SolidVertex { position: p3, color, emissive, normal, flags },
    ]);
    indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
}

fn radial_normal(angle: f32) -> [f32; 3] {
    [angle.cos(), 0.0, angle.sin()]
}

fn build_cylinder_ring(
    vertices: &mut Vec<SolidVertex>,
    indices: &mut Vec<u16>,
    radius: f32,
    y: f32,
    tube: f32,
    color: [f32; 3],
    emissive: f32,
    segments: usize,
) {
    let inner = radius - tube * 0.5;
    let outer = radius + tube * 0.5;
    for seg in 0..segments {
        let a0 = (seg as f32 / segments as f32) * PI * 2.0;
        let a1 = ((seg + 1) as f32 / segments as f32) * PI * 2.0;
        push_quad(
            vertices,
            indices,
            [a0.cos() * inner, y - tube * 0.5, a0.sin() * inner],
            [a1.cos() * inner, y - tube * 0.5, a1.sin() * inner],
            [a1.cos() * outer, y + tube * 0.5, a1.sin() * outer],
            [a0.cos() * outer, y + tube * 0.5, a0.sin() * outer],
            color,
            emissive,
            radial_normal((a0 + a1) * 0.5),
            0.0,
        );
    }
}

fn build_drum_batches(device: &Device, radius: f32, half_h: f32, cols: u32) -> Vec<MeshBatch> {
    let segments = 48usize;
    let floor_y = -half_h - 3.0;
    let floor_half = 200.0;

    let mut floor_v = Vec::new();
    let mut floor_i = Vec::new();
    push_quad(
        &mut floor_v,
        &mut floor_i,
        [-floor_half, floor_y, -floor_half],
        [floor_half, floor_y, -floor_half],
        [floor_half, floor_y, floor_half],
        [-floor_half, floor_y, floor_half],
        [0.67, 0.67, 0.67],
        0.0,
        [0.0, 1.0, 0.0],
        1.0,
    );

    let mut body_v = Vec::new();
    let mut body_i = Vec::new();
    let body_color = [0.07, 0.07, 0.07];
    for seg in 0..segments {
        let a0 = (seg as f32 / segments as f32) * PI * 2.0;
        let a1 = ((seg + 1) as f32 / segments as f32) * PI * 2.0;
        let n = radial_normal((a0 + a1) * 0.5);
        push_quad(
            &mut body_v,
            &mut body_i,
            [a0.cos() * radius, -half_h, a0.sin() * radius],
            [a1.cos() * radius, -half_h, a1.sin() * radius],
            [a1.cos() * radius, half_h, a1.sin() * radius],
            [a0.cos() * radius, half_h, a0.sin() * radius],
            body_color,
            0.0,
            n,
            0.0,
        );
    }

    let mut gold_v = Vec::new();
    let mut gold_i = Vec::new();
    let gold = [0.9, 0.71, 0.36];
    build_cylinder_ring(&mut gold_v, &mut gold_i, radius + 0.2, half_h, 0.6, gold, 0.15, segments);
    build_cylinder_ring(&mut gold_v, &mut gold_i, radius + 0.2, -half_h, 0.6, gold, 0.15, segments);

    let mut neon_v = Vec::new();
    let mut neon_i = Vec::new();
    build_cylinder_ring(
        &mut neon_v,
        &mut neon_i,
        radius + 1.2,
        half_h + 0.5,
        0.15,
        [0.0, 1.0, 1.0],
        2.0,
        segments,
    );
    build_cylinder_ring(
        &mut neon_v,
        &mut neon_i,
        radius + 1.2,
        -half_h - 0.5,
        0.15,
        [1.0, 0.0, 1.0],
        2.0,
        segments,
    );

    let mut glass_v = Vec::new();
    let mut glass_i = Vec::new();
    let glass_r = radius + 1.6;
    for seg in 0..segments {
        let a0 = (seg as f32 / segments as f32) * PI * 2.0;
        let a1 = ((seg + 1) as f32 / segments as f32) * PI * 2.0;
        push_quad(
            &mut glass_v,
            &mut glass_i,
            [a0.cos() * glass_r, -half_h - 1.0, a0.sin() * glass_r],
            [a1.cos() * glass_r, -half_h - 1.0, a1.sin() * glass_r],
            [a1.cos() * glass_r, half_h + 1.0, a1.sin() * glass_r],
            [a0.cos() * glass_r, half_h + 1.0, a0.sin() * glass_r],
            [0.9, 0.9, 0.95],
            0.05,
            radial_normal((a0 + a1) * 0.5),
            0.0,
        );
    }

    let mut bracket_v = Vec::new();
    let mut bracket_i = Vec::new();
    let col_angle = (2.0 * PI) / cols.max(1) as f32;
    for i in 0..cols {
        let theta = i as f32 * col_angle;
        let bx = theta.sin() * (radius + 0.12);
        let bz = theta.cos() * (radius + 0.12);
        let (color, emissive) = if i % 2 == 0 {
            ([0.0, 0.4, 0.4], 0.0)
        } else {
            ([0.67, 0.67, 0.67], 0.05)
        };
        let hw = 0.25;
        let hh = half_h - 1.0;
        push_quad(
            &mut bracket_v,
            &mut bracket_i,
            [bx - hw, -hh, bz - 0.1],
            [bx + hw, -hh, bz - 0.1],
            [bx + hw, hh, bz + 0.1],
            [bx - hw, hh, bz + 0.1],
            color,
            emissive,
            radial_normal(theta),
            0.0,
        );
    }

    fn make_batch(device: &Device, v: &[SolidVertex], i: &[u16], skip: bool, glass: bool) -> MeshBatch {
        MeshBatch {
            vertex_buffer: device.new_buffer_with_data(
                v.as_ptr() as *const _,
                (v.len() * std::mem::size_of::<SolidVertex>()) as u64,
                MTLResourceOptions::StorageModeShared,
            ),
            index_buffer: device.new_buffer_with_data(
                i.as_ptr() as *const _,
                (i.len() * std::mem::size_of::<u16>()) as u64,
                MTLResourceOptions::StorageModeShared,
            ),
            index_count: i.len() as u32,
            skip,
            glass,
        }
    }

    vec![
        make_batch(device, &floor_v, &floor_i, false, false),
        make_batch(device, &body_v, &body_i, false, false),
        make_batch(device, &gold_v, &gold_i, false, false),
        make_batch(device, &neon_v, &neon_i, false, false),
        make_batch(device, &bracket_v, &bracket_i, false, false),
        make_batch(device, &glass_v, &glass_i, false, true),
    ]
}

fn transform_card_point(local: [f32; 3], card: &CardInstance) -> [f32; 3] {
    let c = card.theta.cos();
    let s = card.theta.sin();
    let rx = c * local[0] + s * local[2];
    let ry = local[1];
    let rz = -s * local[0] + c * local[2];
    let mut wx = rx + card.x;
    let mut wy = ry + card.y;
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
    let uvs = [[0.0, 1.0], [1.0, 1.0], [1.0, 0.0], [0.0, 0.0]];
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    for card in cards {
        let base = vertices.len() as u16;
        let slot_index = card.slot_index as f32;
        let is_empty = if card.empty { 1.0 } else { 0.0 };
        let normal = [card.theta.sin(), 0.0, card.theta.cos()];
        for i in 0..4 {
            let wp = transform_card_point(locals[i], card);
            let lu = uvs[i][0];
            let lv = uvs[i][1];
            let u = if card.empty { 0.0 } else { card.u0 + (card.u1 - card.u0) * lu };
            let v = if card.empty { 0.0 } else { card.v0 + (card.v1 - card.v0) * lv };
            vertices.push(TexVertex {
                position: wp,
                uv: [u, v],
                slot_index,
                local_uv: [lu, lv],
                is_empty,
                normal,
            });
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    (vertices, indices)
}

fn build_category_mesh(scene: &PreparedScene) -> (Vec<TexVertex>, Vec<u16>) {
    if scene.category_atlas_width == 0 || scene.category_count == 0 {
        return (Vec::new(), Vec::new());
    }
    let cols = scene.layout.cols;
    let cat_n = scene.category_count.max(1) as f32;
    let label_w = CARD_W * 0.9;
    let label_h = 0.6;
    let hw = label_w * 0.5;
    let hh = label_h * 0.5;
    let bottom_y = -(scene.layout.height_total * 0.5) - 0.8;
    let col_angle = (2.0 * PI) / cols.max(1) as f32;
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    for c in 0..cols {
        let theta = -PI + c as f32 * col_angle + col_angle / 2.0;
        let radial = scene.layout.radius + CARD_RADIAL_OFFSET - 0.3;
        let x = theta.sin() * radial;
        let z = theta.cos() * radial;
        let card = CardInstance {
            slot_index: c as usize,
            c,
            r: scene.layout.rows.saturating_sub(1),
            title: String::new(),
            uri: String::new(),
            empty: false,
            x,
            y: bottom_y,
            z,
            theta,
            u0: 0.0,
            v0: 0.0,
            u1: 1.0,
            v1: 1.0 / cat_n,
            accent: [0.0; 3],
            bg: [0.0; 3],
            alt: [0.0; 3],
        };
        let row_idx = (c % scene.category_count) as f32;
        let v0 = 1.0 - (row_idx + 1.0) / cat_n;
        let v1 = 1.0 - row_idx / cat_n;
        let locals = [[-hw, -hh, 0.0], [hw, -hh, 0.0], [hw, hh, 0.0], [-hw, hh, 0.0]];
        let uvs = [[0.0, v1], [1.0, v1], [1.0, v0], [0.0, v0]];
        let base = vertices.len() as u16;
        let normal = [card.theta.sin(), 0.0, card.theta.cos()];
        for i in 0..4 {
            let wp = transform_card_point(locals[i], &card);
            vertices.push(TexVertex {
                position: wp,
                uv: uvs[i],
                slot_index: -1.0,
                local_uv: [0.0, 0.0],
                is_empty: 0.0,
                normal,
            });
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    (vertices, indices)
}

const CARD_RADIAL_OFFSET: f32 = 0.12;

fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> [f32; 3] {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h * 6.0;
    let x = c * (1.0 - ((hp % 2.0) - 1.0).abs());
    let (r1, g1, b1) = if hp < 1.0 {
        (c, x, 0.0)
    } else if hp < 2.0 {
        (x, c, 0.0)
    } else if hp < 3.0 {
        (0.0, c, x)
    } else if hp < 4.0 {
        (0.0, x, c)
    } else if hp < 5.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    let m = l - c * 0.5;
    [r1 + m, g1 + m, b1 + m]
}

fn compute_neon_colors(
    time: f32,
    lighting: f32,
    has_active: bool,
    accent: [f32; 3],
    bg: [f32; 3],
    alt: [f32; 3],
) -> ([f32; 3], [f32; 3]) {
    let (r1, r2) = if has_active && lighting > 0.25 {
        let cycle = (time * 1.5).sin() * 0.5 + 0.5;
        (lerp3(accent, bg, cycle), lerp3(bg, alt, 1.0 - cycle))
    } else {
        (
            hsl_to_rgb((time * 0.1) % 1.0, 0.95, 0.55),
            hsl_to_rgb(((time * 0.1) + 0.5) % 1.0, 0.95, 0.55),
        )
    };
    let d1 = [1.0, 0.933, 0.867];
    let d2 = [0.667, 0.933, 1.0];
    (lerp3(d1, r1, lighting), lerp3(d2, r2, lighting))
}
