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

use crate::camera::{base_cam_dist, floor_y, CameraParams, DEPTH_FAR, DEPTH_NEAR};
use crate::lights::{advance_lights, advance_local_leds, LightColors, LightIntensities};
use crate::scene_data::{CardInstance, PreparedScene};

const SHADER: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct SceneUniforms {
    float angle;
    float aspect;
    float proj_f;
    float active_slot;
    float lighting;
    float time;
    float neon_intensity;
    float show_categories;
    float zoom_display;
    float neon_emissive;
    float floor_y;
    float depth_near;
    float depth_far;
    float drum_radius;
    float active_theta;
    float tracker_mask;
    float camera_az;
    float hemi_i;
    float dir_i;
    float amb_i;
    float cam_i;
    float fill_white_i;
    float fill_amber_i;
    float fill_pink_i;
    float fill_front_i;
    float _pad_cam0;
    float _pad_cam1;
    float _pad_cam2;
    float4 cam_pos;
    float4 amb_color;
    float4 cam_light_color;
    float4 point_color1;
    float4 point_color2;
    float4 neon_color1;
    float4 neon_color2;
    float4 local_led1;
    float4 local_led2;
    float4 led_color;
    float4 active_accent;
    float4 active_bg;
    float4 active_alt;
    float4 tracker0;
    float4 tracker1;
    float4 tracker2;
    float4 tracker3;
};

struct CardUniforms {
    uint queued[16];
    uint slot_count;
    uint2 _pad;
};

struct FloorIn {
    float3 position [[attribute(0)]];
    float2 uv [[attribute(1)]];
};

struct FloorOut {
    float4 position [[position]];
    float2 uv;
    float3 world_pos;
};

struct TrackerIn {
    float3 position [[attribute(0)]];
    float intensity [[attribute(1)]];
};

struct TrackerOut {
    float4 position [[position]];
    float intensity;
    float3 world_pos;
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

float3 apply_fog(float3 rgb, float3 world_pos, constant SceneUniforms& u) {
    float dist = length(world_pos - u.cam_pos.xyz);
    float fog_near = length(u.cam_pos.xyz) + 30.0;
    float fog_far = fog_near + 250.0;
    float fog = smoothstep(fog_near, fog_far, dist);
    float3 fog_col = float3(0.04, 0.02, 0.03);
    return mix(rgb, fog_col, fog);
}

float4 project(float3 p, constant SceneUniforms& u) {
    float3 cam = u.cam_pos.xyz;
    float3 target = float3(0.0, 0.0, 0.0);
    float3 forward = normalize(target - cam);
    float3 world_up = float3(0.0, 1.0, 0.0);
    float3 right = normalize(cross(forward, world_up));
    float3 up = cross(right, forward);
    float3 rel = p - cam;
    float eye_x = dot(rel, right);
    float eye_y = dot(rel, up);
    float eye_z = dot(rel, forward);
    if (eye_z <= u.depth_near) {
        return float4(0.0, 0.0, 2.0, 1.0);
    }
    float2 ndc = float2(eye_x * u.proj_f / u.aspect, eye_y * u.proj_f) / eye_z;
    float depth = (eye_z - u.depth_near) / (u.depth_far - u.depth_near);
    return float4(ndc, min(depth, 0.9999), 1.0);
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

float3 env_reflection(float3 N, float3 V, constant SceneUniforms& u) {
    float3 R = reflect(-V, N);
    float up = R.y * 0.5 + 0.5;
    float3 env = mix(float3(0.04, 0.02, 0.05), float3(0.25, 0.35, 0.55), up);
    env += u.neon_color1.xyz * pow(max(R.y, 0.0), 3.0) * 0.55;
    env += u.neon_color2.xyz * pow(max(-R.y, 0.0), 2.5) * 0.45;
    float streak = pow(abs(R.x) * 0.7 + abs(R.z) * 0.3, 6.0);
    env += mix(u.neon_color1.xyz, u.neon_color2.xyz, 0.5) * streak * 0.35;
    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.2);
    float L = u.lighting;
    return env * fresnel * (0.22 + L * 0.55);
}

float3 dir_toward_origin(float3 light_pos) {
    return normalize(-light_pos);
}

float3 camera_light_direction(float3 cam_pos) {
    float3 target = float3(0.0);
    float3 to_target = target - cam_pos;
    float3 forward = normalize(to_target);
    float3 up = float3(0.0, 1.0, 0.0);
    float3 right = normalize(cross(forward, up));
    float offset_dist = length(to_target) * 0.6;
    float3 light_pos = cam_pos + right * offset_dist;
    return normalize(target - light_pos);
}

float point_attenuation(float dist, float cutoff) {
    float falloff = 1.0 / max(dist * dist, 0.01);
    if (cutoff > 0.0) {
        float ratio = dist / cutoff;
        float ratio2 = ratio * ratio;
        float pow4 = ratio2 * ratio2;
        falloff *= pow(saturate(1.0 - pow4), 2.0);
    }
    return falloff;
}

float3 add_point_light(float3 N, float3 world_pos, float3 light_pos, float3 color,
                       float intensity, float range) {
    float3 to_light = light_pos - world_pos;
    float dist = length(to_light);
    float3 L = to_light / max(dist, 1e-4);
    float ndotl = max(dot(N, L), 0.0);
    return color * intensity * ndotl * point_attenuation(dist, range);
}

float3 shade_surface(float3 base, float3 world_pos, float3 world_normal, float emissive,
                     constant SceneUniforms& u) {
    float L = u.lighting;
    float3 N = normalize(world_normal);
    float3 V = normalize(u.cam_pos.xyz - world_pos);

    // HemisphereLight(0xffffff, 0x333333) — three-scene.js line 81.
    float hemi_w = dot(N, float3(0.0, 1.0, 0.0)) * 0.5 + 0.5;
    float3 hemi_col = mix(float3(0.2, 0.2, 0.2), float3(1.0, 1.0, 1.0), hemi_w);
    float3 irradiance = hemi_col * u.hemi_i;

    // AmbientLight — color lerps toward 0xffb060 on CPU.
    irradiance += u.amb_color.xyz * u.amb_i;

    // DirectionalLight(0xffeedd) orbiting with camera azimuth.
    float az = u.camera_az;
    float3 dir_pos = float3(sin(az) * 100.0, 100.0, cos(az) * 100.0);
    float3 dir_dir = dir_toward_origin(dir_pos);
    irradiance += float3(1.0, 0.933, 0.867) * u.dir_i * max(dot(N, dir_dir), 0.0);

    // fillWhite(0xffffff) at (0, 30, 50).
    irradiance += float3(1.0) * u.fill_white_i
        * max(dot(N, dir_toward_origin(float3(0.0, 30.0, 50.0))), 0.0);

    // fillAmber(0xffaa55) at (-40, 20, 20).
    irradiance += float3(1.0, 0.667, 0.333) * u.fill_amber_i
        * max(dot(N, dir_toward_origin(float3(-40.0, 20.0, 20.0))), 0.0);

    // fillPink(0xff66cc) at (40, 20, 20).
    irradiance += float3(1.0, 0.4, 0.8) * u.fill_pink_i
        * max(dot(N, dir_toward_origin(float3(40.0, 20.0, 20.0))), 0.0);

    // fillFrontAmber(0xffaa55) orbiting at az + PI/2.5.
    float az_off = az + 1.2566370614359172;
    float3 front_pos = float3(sin(az_off) * 35.0, 22.0, cos(az_off) * 35.0);
    irradiance += float3(1.0, 0.667, 0.333) * u.fill_front_i
        * max(dot(N, dir_toward_origin(front_pos)), 0.0);

    // cameraLight — offset to the right of the camera, aimed at origin.
    float3 cam_l_dir = camera_light_direction(u.cam_pos.xyz);
    irradiance += u.cam_light_color.xyz * u.cam_i * max(dot(N, cam_l_dir), 0.0);

    // pointLight1/2 — PointLight(..., range 80, decay 2).
    irradiance += add_point_light(N, world_pos, float3(-25.0, 10.0, 25.0),
                                  u.point_color1.xyz, u.neon_intensity, 80.0);
    irradiance += add_point_light(N, world_pos, float3(25.0, -10.0, -25.0),
                                  u.point_color2.xyz, u.neon_intensity, 80.0);

    // localLed1/2 — PointLight(0xffd580, intensity, 15) on active card.
    if (u.local_led1.w > 0.001) {
        irradiance += add_point_light(N, world_pos, u.local_led1.xyz,
                                      u.led_color.xyz, u.local_led1.w, 15.0);
    }
    if (u.local_led2.w > 0.001) {
        irradiance += add_point_light(N, world_pos, u.local_led2.xyz,
                                      u.led_color.xyz, u.local_led2.w, 15.0);
    }

    // Tracker PointLights — distance 4, decay 2.
    if (u.tracker_mask > 0.5) {
        irradiance += add_point_light(N, world_pos, u.tracker0.xyz,
                                      u.led_color.xyz, u.tracker0.w, 4.0);
        irradiance += add_point_light(N, world_pos, u.tracker1.xyz,
                                      u.led_color.xyz, u.tracker1.w, 4.0);
        irradiance += add_point_light(N, world_pos, u.tracker2.xyz,
                                      u.led_color.xyz, u.tracker2.w, 4.0);
        irradiance += add_point_light(N, world_pos, u.tracker3.xyz,
                                      u.led_color.xyz, u.tracker3.w, 4.0);
    }

    float3 lit = base * irradiance;

    lit += env_reflection(N, V, u) * mix(0.45, 1.0, clamp(emissive * 3.0, 0.0, 1.0));

    if (emissive > 1.5) {
        float3 neon_c = mix(u.neon_color1.xyz, u.neon_color2.xyz, step(0.0, world_pos.y));
        lit += neon_c * emissive * u.neon_intensity * 0.12;
    } else if (emissive > 0.01) {
        lit += base * emissive * u.neon_emissive * 0.35;
    }

    bool has_active = u.active_slot >= 0.0;
    if (has_active && L > 0.25) {
        float cycle = (sin(u.time * 1.5) + 1.0) * 0.5;
        float3 accent_mix = mix(u.active_accent.xyz, u.active_bg.xyz, cycle);
        lit = mix(lit, lit * accent_mix * 1.35, L * 0.30);
    }

    // NeutralToneMapping exposure — three-scene.js line 57.
    return apply_fog(max(lit, base * 0.06) * 1.3, world_pos, u);
}

vertex SolidOut solid_vertex(SolidIn in [[stage_in]], constant SceneUniforms& u [[buffer(1)]]) {
    SolidOut vert;
    float3 wp = rotate_y(in.position, u.angle);
    float3 wn = rotate_y(in.normal, u.angle);
    vert.position = project(wp, u);
    vert.color = in.color;
    vert.emissive = in.emissive;
    vert.world_pos = wp;
    vert.world_normal = wn;
    vert.flags = in.flags;
    return vert;
}

fragment float4 solid_fragment(SolidOut in [[stage_in]], constant SceneUniforms& u [[buffer(1)]]) {
    float3 rgb = shade_surface(in.color, in.world_pos, in.world_normal, in.emissive, u);
    return float4(rgb, 1.0);
}

vertex FloorOut floor_vertex(FloorIn in [[stage_in]], constant SceneUniforms& u [[buffer(1)]]) {
    FloorOut vert;
    vert.world_pos = in.position;
    vert.position = project(in.position, u);
    vert.uv = in.uv;
    return vert;
}

fragment float4 floor_fragment(FloorOut in [[stage_in]], constant SceneUniforms& u [[buffer(1)]]) {
    float2 cell = floor(in.uv);
    float checker = fmod(cell.x + cell.y, 2.0);
    float3 checker_rgb = mix(float3(0.05, 0.05, 0.05), float3(0.92, 0.92, 0.92), checker);
    checker_rgb *= float3(0.67, 0.67, 0.67);
    float dist = length(in.world_pos.xz);
    float drum_shadow = smoothstep(u.drum_radius + 6.0, u.drum_radius + 1.5, dist);
    checker_rgb *= mix(1.0, 0.55, drum_shadow);
    float3 N = float3(0.0, 1.0, 0.0);
    float3 V = normalize(u.cam_pos.xyz - in.world_pos);
    float3 lit = shade_surface(checker_rgb, in.world_pos, N, 0.0, u);
    float3 refl = env_reflection(N, V, u) * 2.0;
    float drum_prox = exp(-dist / (u.drum_radius + 6.0) * 0.5);
    refl += mix(u.neon_color1.xyz, u.neon_color2.xyz, 0.45) * drum_prox * u.neon_intensity * 0.1;
    float3 rgb = max(lit * 0.7 + refl, float3(0.22));
    return float4(rgb, 1.0);
}

vertex TrackerOut tracker_vertex(TrackerIn in [[stage_in]], constant SceneUniforms& u [[buffer(1)]]) {
    TrackerOut vert;
    vert.world_pos = in.position;
    vert.position = project(in.position, u);
    vert.intensity = in.intensity;
    return vert;
}

fragment float4 tracker_fragment(TrackerOut in [[stage_in]], constant SceneUniforms& u [[buffer(1)]]) {
    if (u.tracker_mask < 0.5) { discard_fragment(); }
    float3 rgb = float3(1.0, 0.93, 0.73) * in.intensity * 2.5;
    rgb = apply_fog(rgb, in.world_pos, u);
    float alpha = clamp(in.intensity * 1.2, 0.0, 1.0);
    return float4(rgb, alpha);
}

fragment float4 glass_fragment(SolidOut in [[stage_in]], constant SceneUniforms& u [[buffer(1)]]) {
    float3 V = normalize(u.cam_pos.xyz - in.world_pos);
    float3 N = normalize(in.world_normal);
    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.5);
    float3 base = mix(in.color, float3(0.85, 0.92, 1.0), 0.35);
    float3 rgb = shade_surface(base, in.world_pos, in.world_normal, 0.05, u);
    rgb += env_reflection(N, V, u) * 1.6;
    rgb += float3(0.5, 0.65, 0.85) * fresnel * 0.45;
    return float4(rgb, 0.18 + fresnel * 0.22);
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
struct FloorVertex {
    position: [f32; 3],
    uv: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct TrackerVertex {
    position: [f32; 3],
    intensity: f32,
}

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
    proj_f: f32,
    active_slot: f32,
    lighting: f32,
    time: f32,
    neon_intensity: f32,
    show_categories: f32,
    zoom_display: f32,
    neon_emissive: f32,
    floor_y: f32,
    depth_near: f32,
    depth_far: f32,
    drum_radius: f32,
    active_theta: f32,
    tracker_mask: f32,
    camera_az: f32,
    hemi_i: f32,
    dir_i: f32,
    amb_i: f32,
    cam_i: f32,
    fill_white_i: f32,
    fill_amber_i: f32,
    fill_pink_i: f32,
    fill_front_i: f32,
    _pad_cam: [f32; 3],
    cam_pos: [f32; 4],
    amb_color: [f32; 4],
    cam_light_color: [f32; 4],
    point_color1: [f32; 4],
    point_color2: [f32; 4],
    neon_color1: [f32; 4],
    neon_color2: [f32; 4],
    local_led1: [f32; 4],
    local_led2: [f32; 4],
    led_color: [f32; 4],
    active_accent: [f32; 4],
    active_bg: [f32; 4],
    active_alt: [f32; 4],
    tracker0: [f32; 4],
    tracker1: [f32; 4],
    tracker2: [f32; 4],
    tracker3: [f32; 4],
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
    /// Camera orbit azimuth — horizontal drag / spin (web `applyAzimuthDelta`).
    pub camera_az: f32,
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
    pub light_intensities: LightIntensities,
    pub light_colors: LightColors,
    pub led_card_slot: Option<usize>,
    pub local_led1_int: f32,
    pub local_led2_int: f32,
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
    floor_pipeline: metal::RenderPipelineState,
    tracker_pipeline: Option<metal::RenderPipelineState>,
    glass_pipeline: Option<metal::RenderPipelineState>,
    tex_pipeline: Option<metal::RenderPipelineState>,
    cat_pipeline: Option<metal::RenderPipelineState>,
    depth: metal::DepthStencilState,
    depth_no_write: metal::DepthStencilState,
    depth_floor: metal::DepthStencilState,
    sampler: Option<metal::SamplerState>,
    drum_batches: Vec<MeshBatch>,
    floor_vertex_buffer: Buffer,
    floor_index_buffer: Buffer,
    floor_index_count: u32,
    tracker_vertex_buffer: Buffer,
    tracker_index_buffer: Buffer,
    tracker_index_count: u32,
    tracker_vertex_capacity: u32,
    tracker_index_capacity: u32,
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
    slot_theta: Vec<f32>,
    slot_y: Vec<f32>,
    height_total: f32,
    drum_radius: f32,
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

        let floor_layout = {
            let vd = VertexDescriptor::new();
            let pos = vd.attributes().object_at(0).unwrap();
            pos.set_format(metal::MTLVertexFormat::Float3);
            pos.set_offset(0);
            pos.set_buffer_index(0);
            let uv = vd.attributes().object_at(1).unwrap();
            uv.set_format(metal::MTLVertexFormat::Float2);
            uv.set_offset(12);
            uv.set_buffer_index(0);
            let layout = vd.layouts().object_at(0).unwrap();
            layout.set_stride(20);
            layout.set_step_function(MTLVertexStepFunction::PerVertex);
            vd
        };
        let floor_pipeline = build_floor_pipeline(&device, &library, &floor_layout)?;

        let tracker_layout = {
            let vd = VertexDescriptor::new();
            let pos = vd.attributes().object_at(0).unwrap();
            pos.set_format(metal::MTLVertexFormat::Float3);
            pos.set_offset(0);
            pos.set_buffer_index(0);
            let intensity = vd.attributes().object_at(1).unwrap();
            intensity.set_format(metal::MTLVertexFormat::Float);
            intensity.set_offset(12);
            intensity.set_buffer_index(0);
            let layout = vd.layouts().object_at(0).unwrap();
            layout.set_stride(16);
            layout.set_step_function(MTLVertexStepFunction::PerVertex);
            vd
        };
        let tracker_pipeline = build_tracker_pipeline(&device, &library, &tracker_layout);

        let depth_desc = metal::DepthStencilDescriptor::new();
        depth_desc.set_depth_compare_function(metal::MTLCompareFunction::Less);
        depth_desc.set_depth_write_enabled(true);
        let depth = device.new_depth_stencil_state(&depth_desc);
        let depth_no_write_desc = metal::DepthStencilDescriptor::new();
        depth_no_write_desc.set_depth_compare_function(metal::MTLCompareFunction::Less);
        depth_no_write_desc.set_depth_write_enabled(false);
        let depth_no_write = device.new_depth_stencil_state(&depth_no_write_desc);
        let depth_floor_desc = metal::DepthStencilDescriptor::new();
        depth_floor_desc.set_depth_compare_function(metal::MTLCompareFunction::LessEqual);
        depth_floor_desc.set_depth_write_enabled(true);
        let depth_floor = device.new_depth_stencil_state(&depth_floor_desc);

        let scene = prepared?;
        let drum_radius = scene.layout.radius;
        let drum_half_h = scene.layout.height_total * 0.5;
        let cam_dist = base_cam_dist(drum_radius);
        let drum_batches = build_drum_batches(
            &device,
            drum_radius,
            drum_half_h,
            scene.layout.cols,
            scene.layout.rows,
        );
        let floor_y_val = floor_y(scene.layout.height_total);
        let (floor_v, floor_i) = build_floor_mesh(floor_y_val);
        let floor_vertex_buffer = device.new_buffer_with_data(
            floor_v.as_ptr() as *const _,
            (floor_v.len() * std::mem::size_of::<FloorVertex>()) as u64,
            MTLResourceOptions::StorageModeShared,
        );
        let floor_index_buffer = device.new_buffer_with_data(
            floor_i.as_ptr() as *const _,
            (floor_i.len() * std::mem::size_of::<u16>()) as u64,
            MTLResourceOptions::StorageModeShared,
        );
        let floor_index_count = floor_i.len() as u32;
        let (tracker_v, tracker_i) = build_tracker_mesh(&[[0.0; 4]; 4]);
        const MAX_TRACKER_VERTS: usize = 24;
        const MAX_TRACKER_INDICES: usize = 128;
        let tracker_cap_v = MAX_TRACKER_VERTS.max(tracker_v.len());
        let tracker_cap_i = MAX_TRACKER_INDICES.max(tracker_i.len());
        let tracker_vertex_buffer = device.new_buffer(
            (tracker_cap_v * std::mem::size_of::<TrackerVertex>()) as u64,
            MTLResourceOptions::StorageModeShared,
        );
        let tracker_index_buffer = device.new_buffer(
            (tracker_cap_i * std::mem::size_of::<u16>()) as u64,
            MTLResourceOptions::StorageModeShared,
        );
        let tracker_index_count = tracker_i.len() as u32;
        let tracker_vertex_capacity = tracker_cap_v as u32;
        let tracker_index_capacity = tracker_cap_i as u32;
        let mut slot_theta = vec![0.0f32; scene.layout.total_slots.max(1) as usize];
        let mut slot_y = vec![0.0f32; scene.layout.total_slots.max(1) as usize];
        for card in &scene.cards {
            if card.slot_index < slot_theta.len() {
                slot_theta[card.slot_index] = card.theta;
                slot_y[card.slot_index] = card.y;
            }
        }

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
            floor_pipeline,
            tracker_pipeline,
            glass_pipeline,
            tex_pipeline,
            cat_pipeline,
            depth,
            depth_no_write,
            depth_floor,
            sampler: Some(sampler),
            drum_batches,
            floor_vertex_buffer,
            floor_index_buffer,
            floor_index_count,
            tracker_vertex_buffer,
            tracker_index_buffer,
            tracker_index_count,
            tracker_vertex_capacity,
            tracker_index_capacity,
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
            slot_theta,
            slot_y,
            height_total: scene.layout.height_total,
            drum_radius,
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
                camera_az: s.camera_az,
            };
            let (t_color1, t_color2) = compute_neon_colors(
                s.time,
                s.lighting,
                s.active_slot.is_some(),
                s.active_accent,
                s.active_bg,
                s.active_alt,
            );
            advance_lights(&mut s, t_color1, t_color2);
            let accent = s.active_accent;
            advance_local_leds(&mut s, accent);
            let li = s.light_intensities;
            let lc = s.light_colors;
            let neon_emissive = 1.0 + s.lighting * 3.5;
            let floor_y_val = floor_y(s.height_total);
            let cam_pos = params.camera_position();
            let (trackers, active_theta, tracker_mask) =
                compute_trackers(&s, &self.slot_theta, self.drum_radius, self.height_total);
            let (local_led1_pos, local_led2_pos) = s.led_card_slot.map(|slot| {
                local_led_world_positions(
                    slot,
                    s.angle,
                    &self.slot_theta,
                    &self.slot_y,
                    self.drum_radius,
                )
            }).unwrap_or(([0.0; 3], [0.0; 3]));
            let (tracker_v, tracker_i) = build_tracker_mesh(&trackers);
            if tracker_v.len() <= self.tracker_vertex_capacity as usize
                && tracker_i.len() <= self.tracker_index_capacity as usize
            {
                if !tracker_v.is_empty() {
                    unsafe {
                        std::ptr::copy_nonoverlapping(
                            tracker_v.as_ptr(),
                            self.tracker_vertex_buffer.contents() as *mut TrackerVertex,
                            tracker_v.len(),
                        );
                        std::ptr::copy_nonoverlapping(
                            tracker_i.as_ptr(),
                            self.tracker_index_buffer.contents() as *mut u16,
                            tracker_i.len(),
                        );
                    }
                }
                self.tracker_index_count = tracker_i.len() as u32;
            }
            let mut queued = [0u32; 16];
            for (i, w) in s.queued_mask.iter().take(16).enumerate() {
                queued[i] = *w;
            }
            let su = SceneUniforms {
                angle: s.angle,
                aspect,
                proj_f: params.proj_f(),
                active_slot: s.active_slot.map(|i| i as f32).unwrap_or(-1.0),
                lighting: s.lighting,
                time: s.time,
                neon_intensity: li.point,
                show_categories: if s.show_categories { 1.0 } else { 0.0 },
                zoom_display: s.zoom_display,
                neon_emissive,
                floor_y: floor_y_val,
                depth_near: DEPTH_NEAR,
                depth_far: DEPTH_FAR,
                drum_radius: s.radius,
                active_theta,
                tracker_mask,
                camera_az: s.camera_az,
                hemi_i: li.hemi,
                dir_i: li.dir,
                amb_i: li.ambient,
                cam_i: li.cam,
                fill_white_i: li.fill_white,
                fill_amber_i: li.fill_amber,
                fill_pink_i: li.fill_pink,
                fill_front_i: li.fill_front,
                _pad_cam: [0.0; 3],
                cam_pos: [cam_pos[0], cam_pos[1], cam_pos[2], 0.0],
                amb_color: color4(lc.ambient),
                cam_light_color: color4(lc.cam),
                point_color1: color4(lc.point1),
                point_color2: color4(lc.point2),
                neon_color1: color4(t_color1),
                neon_color2: color4(t_color2),
                local_led1: [
                    local_led1_pos[0],
                    local_led1_pos[1],
                    local_led1_pos[2],
                    s.local_led1_int,
                ],
                local_led2: [
                    local_led2_pos[0],
                    local_led2_pos[1],
                    local_led2_pos[2],
                    s.local_led2_int,
                ],
                led_color: color4(lc.led),
                active_accent: color4(s.active_accent),
                active_bg: color4(s.active_bg),
                active_alt: color4(s.active_alt),
                tracker0: trackers[0],
                tracker1: trackers[1],
                tracker2: trackers[2],
                tracker3: trackers[3],
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
        enc.set_fragment_buffer(1, Some(&self.scene_uniform_buffer), 0);

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
            enc.set_depth_stencil_state(&self.depth_no_write);
            enc.set_render_pipeline_state(tex_pipe);
            enc.set_vertex_buffer(0, Some(vb), 0);
            enc.set_vertex_buffer(1, Some(&self.scene_uniform_buffer), 0);
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
                enc.set_vertex_buffer(1, Some(&self.scene_uniform_buffer), 0);
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

        enc.set_depth_stencil_state(&self.depth_floor);
        enc.set_render_pipeline_state(&self.floor_pipeline);
        enc.set_vertex_buffer(0, Some(&self.floor_vertex_buffer), 0);
        enc.draw_indexed_primitives(
            MTLPrimitiveType::Triangle,
            self.floor_index_count as u64,
            MTLIndexType::UInt16,
            &self.floor_index_buffer,
            0,
        );

        if let Some(tracker_pipe) = self.tracker_pipeline.as_ref() {
            if self.tracker_index_count > 0 {
                enc.set_depth_stencil_state(&self.depth_no_write);
                enc.set_render_pipeline_state(tracker_pipe);
                enc.set_vertex_buffer(0, Some(&self.tracker_vertex_buffer), 0);
                enc.draw_indexed_primitives(
                    MTLPrimitiveType::Triangle,
                    self.tracker_index_count as u64,
                    MTLIndexType::UInt16,
                    &self.tracker_index_buffer,
                    0,
                );
            }
        }

        if let Some(glass_pipe) = self.glass_pipeline.as_ref() {
            let hide_glass = self
                .state
                .lock()
                .unwrap()
                .zoom_display
                > 0.55;
            if !hide_glass {
                enc.set_depth_stencil_state(&self.depth_no_write);
                enc.set_render_pipeline_state(glass_pipe);
                enc.set_fragment_buffer(1, Some(&self.scene_uniform_buffer), 0);
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

fn build_floor_pipeline(
    device: &Device,
    library: &metal::Library,
    layout: &metal::VertexDescriptorRef,
) -> Option<metal::RenderPipelineState> {
    let vfn = library.get_function("floor_vertex", None).ok()?;
    let ffn = library.get_function("floor_fragment", None).ok()?;
    let d = RenderPipelineDescriptor::new();
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

fn build_tracker_pipeline(
    device: &Device,
    library: &metal::Library,
    layout: &metal::VertexDescriptorRef,
) -> Option<metal::RenderPipelineState> {
    let vfn = library.get_function("tracker_vertex", None).ok()?;
    let ffn = library.get_function("tracker_fragment", None).ok()?;
    let d = RenderPipelineDescriptor::new();
    d.set_vertex_function(Some(&vfn));
    d.set_fragment_function(Some(&ffn));
    d.set_vertex_descriptor(Some(layout));
    let ca = d.color_attachments().object_at(0).unwrap();
    ca.set_pixel_format(MTLPixelFormat::BGRA8Unorm);
    ca.set_blending_enabled(true);
    ca.set_source_rgb_blend_factor(MTLBlendFactor::SourceAlpha);
    ca.set_destination_rgb_blend_factor(MTLBlendFactor::One);
    ca.set_source_alpha_blend_factor(MTLBlendFactor::One);
    ca.set_destination_alpha_blend_factor(MTLBlendFactor::OneMinusSourceAlpha);
    d.set_depth_attachment_pixel_format(MTLPixelFormat::Depth32Float);
    device.new_render_pipeline_state(&d).ok()
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

fn build_floor_mesh(floor_y_val: f32) -> (Vec<FloorVertex>, Vec<u16>) {
    let h = 200.0;
    let tile = 25.0;
    let corners = [
        ([-h, floor_y_val, -h], [-h / tile, -h / tile]),
        ([h, floor_y_val, -h], [h / tile, -h / tile]),
        ([h, floor_y_val, h], [h / tile, h / tile]),
        ([-h, floor_y_val, h], [-h / tile, h / tile]),
    ];
    let vertices: Vec<FloorVertex> = corners
        .map(|(p, uv)| FloorVertex {
            position: p,
            uv,
        })
        .to_vec();
    // CCW from +Y so the upward-facing side is front.
    let indices = vec![0, 3, 2, 0, 2, 1];
    (vertices, indices)
}

fn append_sphere(
    vertices: &mut Vec<TrackerVertex>,
    indices: &mut Vec<u16>,
    center: [f32; 3],
    radius: f32,
    intensity: f32,
) {
    let base = vertices.len() as u16;
    let r = radius;
    let pts = [
        [center[0], center[1] + r, center[2]],
        [center[0], center[1] - r, center[2]],
        [center[0] + r, center[1], center[2]],
        [center[0] - r, center[1], center[2]],
        [center[0], center[1], center[2] + r],
        [center[0], center[1], center[2] - r],
    ];
    for p in pts {
        vertices.push(TrackerVertex {
            position: p,
            intensity,
        });
    }
    for tri in [
        [0, 2, 4],
        [0, 4, 3],
        [0, 3, 5],
        [0, 5, 2],
        [1, 4, 2],
        [1, 3, 4],
        [1, 5, 3],
        [1, 2, 5],
    ] {
        indices.extend(tri.map(|i| base + i));
    }
}

fn build_tracker_mesh(trackers: &[[f32; 4]; 4]) -> (Vec<TrackerVertex>, Vec<u16>) {
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    for tr in trackers {
        if tr[3] <= 0.001 {
            continue;
        }
        append_sphere(
            &mut vertices,
            &mut indices,
            [tr[0], tr[1], tr[2]],
            0.07,
            (tr[3] / 24.0).clamp(0.05, 1.5),
        );
    }
    (vertices, indices)
}

fn rotate_y_point(p: [f32; 3], angle: f32) -> [f32; 3] {
    let c = angle.cos();
    let s = angle.sin();
    [
        c * p[0] + s * p[2],
        p[1],
        -s * p[0] + c * p[2],
    ]
}

fn local_led_world_positions(
    slot: usize,
    drum_angle: f32,
    slot_theta: &[f32],
    slot_y: &[f32],
    radius: f32,
) -> ([f32; 3], [f32; 3]) {
    let theta = slot_theta.get(slot).copied().unwrap_or(0.0);
    let base_y = slot_y.get(slot).copied().unwrap_or(0.0);
    let radial = radius + 0.14;
    let y_top = base_y + CARD_H / 2.0 - 0.02;
    let y_bot = base_y - CARD_H / 2.0 + 0.02;
    let local1 = [theta.sin() * radial, y_top, theta.cos() * radial];
    let local2 = [theta.sin() * radial, y_bot, theta.cos() * radial];
    (
        rotate_y_point(local1, drum_angle),
        rotate_y_point(local2, drum_angle),
    )
}

fn compute_trackers(
    state: &SceneState,
    slot_theta: &[f32],
    radius: f32,
    height_total: f32,
) -> ([[f32; 4]; 4], f32, f32) {
    let tracker_y = height_total * 0.5 - 0.67;
    let tracker_r = radius + 0.2;
    let mut out = [[0.0f32; 4]; 4];
    let (active_theta, mask) = if let Some(slot) = state.active_slot {
        let theta = slot_theta.get(slot).copied().unwrap_or(0.0) + state.angle;
        (theta, 1.0)
    } else {
        (0.0, 0.0)
    };
    for i in 0..4 {
        let dir = if i % 2 == 0 { 1.0 } else { -1.0 };
        let offset = (i / 2) as f32 / 2.0;
        let progress = (state.time * 0.4 + offset) % 1.0;
        let ang = active_theta + dir * PI * (1.0 - progress);
        let pulse = (progress * PI).sin();
        let intensity = if mask > 0.5 {
            8.0 + pulse * 16.0
        } else {
            0.0
        };
        out[i] = [
            ang.sin() * tracker_r,
            tracker_y,
            ang.cos() * tracker_r,
            intensity,
        ];
    }
    (out, active_theta, mask)
}

fn push_bracket_box(
    vertices: &mut Vec<SolidVertex>,
    indices: &mut Vec<u16>,
    center: [f32; 3],
    theta: f32,
    hw: f32,
    hh: f32,
    hd: f32,
    color: [f32; 3],
    emissive: f32,
) {
    let c = theta.cos();
    let s = theta.sin();
    let locals = [
        [-hw, -hh, -hd],
        [hw, -hh, -hd],
        [hw, hh, -hd],
        [-hw, hh, -hd],
        [-hw, -hh, hd],
        [hw, -hh, hd],
        [hw, hh, hd],
        [-hw, hh, hd],
    ];
    let mut world = [[0.0f32; 3]; 8];
    for (i, local) in locals.iter().enumerate() {
        let rx = c * local[0] + s * local[2];
        let rz = -s * local[0] + c * local[2];
        world[i] = [rx + center[0], local[1] + center[1], rz + center[2]];
    }
    let base = vertices.len() as u16;
    let n = radial_normal(theta);
    for p in world {
        vertices.push(SolidVertex {
            position: p,
            color,
            emissive,
            normal: n,
            flags: 0.0,
        });
    }
    for tri in [
        [0, 1, 2],
        [0, 2, 3],
        [4, 6, 5],
        [4, 7, 6],
        [0, 4, 5],
        [0, 5, 1],
        [2, 6, 7],
        [2, 7, 3],
        [0, 3, 7],
        [0, 7, 4],
        [1, 5, 6],
        [1, 6, 2],
    ] {
        indices.extend(tri.map(|i| base + i));
    }
}

fn build_drum_batches(
    device: &Device,
    radius: f32,
    half_h: f32,
    cols: u32,
    rows: u32,
) -> Vec<MeshBatch> {
    let segments = 48usize;
    const ROW_SPACING: f32 = 1.4;

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
    build_cylinder_ring(&mut gold_v, &mut gold_i, radius + 0.2, half_h, 0.6, gold, 0.55, segments);
    build_cylinder_ring(&mut gold_v, &mut gold_i, radius + 0.2, -half_h, 0.6, gold, 0.55, segments);

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

    let mut teal_v = Vec::new();
    let mut teal_i = Vec::new();
    let mut aluminum_v = Vec::new();
    let mut aluminum_i = Vec::new();
    let mut chrome_v = Vec::new();
    let mut chrome_i = Vec::new();
    let col_angle = (2.0 * PI) / cols.max(1) as f32;
    let bracket_h = half_h - 1.0;
    for i in 0..cols {
        let theta = i as f32 * col_angle;
        let cx = theta.sin() * (radius + 0.12);
        let cz = theta.cos() * (radius + 0.12);
        if i % 2 == 0 {
            push_bracket_box(
                &mut teal_v,
                &mut teal_i,
                [cx, 0.0, cz],
                theta,
                0.25,
                bracket_h,
                0.2,
                [0.0, 0.4, 0.4],
                0.0,
            );
            for dx in [-0.15f32, 0.15] {
                let rx = dx * theta.cos() + 0.2 * theta.sin();
                let rz = -dx * theta.sin() + 0.2 * theta.cos();
                push_bracket_box(
                    &mut chrome_v,
                    &mut chrome_i,
                    [cx + rx, 0.0, cz + rz],
                    theta,
                    0.02,
                    bracket_h,
                    0.02,
                    [0.93, 0.93, 0.93],
                    0.15,
                );
            }
        } else {
            push_bracket_box(
                &mut aluminum_v,
                &mut aluminum_i,
                [cx, 0.0, cz],
                theta,
                0.15,
                bracket_h,
                0.075,
                [0.67, 0.67, 0.67],
                0.08,
            );
            push_bracket_box(
                &mut chrome_v,
                &mut chrome_i,
                [cx + 0.1 * theta.sin(), 0.0, cz + 0.1 * theta.cos()],
                theta,
                0.05,
                bracket_h,
                0.04,
                [0.93, 0.93, 0.93],
                0.15,
            );
        }
    }

    let mut ring_v = Vec::new();
    let mut ring_i = Vec::new();
    let start_y = (rows as f32 * ROW_SPACING) / 2.0 - ROW_SPACING / 2.0;
    for r in 0..=rows {
        let y = start_y - r as f32 * ROW_SPACING + ROW_SPACING / 2.0;
        build_cylinder_ring(
            &mut ring_v,
            &mut ring_i,
            radius + 0.08,
            y,
            0.1,
            [0.94, 0.94, 0.94],
            0.08,
            24,
        );
    }

    let mut bracket_v = Vec::new();
    let mut bracket_i = Vec::new();
    bracket_v.append(&mut teal_v);
    bracket_i.append(&mut teal_i);
    bracket_v.append(&mut aluminum_v);
    bracket_i.append(&mut aluminum_i);
    bracket_v.append(&mut chrome_v);
    bracket_i.append(&mut chrome_i);
    bracket_v.append(&mut ring_v);
    bracket_i.append(&mut ring_i);

    fn make_batch(
        device: &Device,
        v: &[SolidVertex],
        i: &[u16],
        skip: bool,
        glass: bool,
    ) -> MeshBatch {
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

fn color4(rgb: [f32; 3]) -> [f32; 4] {
    [rgb[0], rgb[1], rgb[2], 0.0]
}

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
