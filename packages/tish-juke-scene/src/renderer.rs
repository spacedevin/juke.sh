//! Metal drum preview renderer (jukebox scene MVP).

use std::f32::consts::PI;
use std::sync::{Arc, Mutex};

use metal::{
    Buffer, CommandQueue, CompileOptions, Device, MTLClearColor, MTLIndexType, MTLLoadAction,
    MTLPixelFormat, MTLPrimitiveType, MTLResourceOptions, MTLStoreAction, MTLTextureUsage,
    MTLVertexStepFunction, MetalDrawableRef, RenderPassDescriptor, RenderPipelineDescriptor,
    TextureDescriptor, VertexDescriptor,
};

const SHADER: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct Uniforms {
    float angle;
    float aspect;
};

struct VertexIn {
    float3 position [[attribute(0)]];
    float3 color [[attribute(1)]];
};

struct VertexOut {
    float4 position [[position]];
    float3 color;
};

vertex VertexOut vertex_main(VertexIn in [[stage_in]],
                             constant Uniforms& u [[buffer(1)]]) {
    float c = cos(u.angle);
    float s = sin(u.angle);
    float3 p = float3(
        c * in.position.x + s * in.position.z,
        in.position.y + 0.15,
        -s * in.position.x + c * in.position.z - 6.5
    );

    float f = 1.0 / tan(0.41421356237); // tan(22.5 deg)
    float2 ndc = float2(p.x * f / u.aspect, p.y * f) / (-p.z);
    float depth = clamp((-p.z - 0.1) / 99.9, 0.0, 1.0);

    VertexOut vert;
    vert.position = float4(ndc, depth, 1.0);
    vert.color = in.color;
    return vert;
}

fragment float4 fragment_main(VertexOut in [[stage_in]]) {
    return float4(in.color, 1.0);
}
"#;

#[repr(C)]
#[derive(Clone, Copy)]
struct Vertex {
    position: [f32; 3],
    color: [f32; 3],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Uniforms {
    angle: f32,
    aspect: f32,
}

pub struct SceneState {
    pub angle: f32,
    pub drag_velocity: f32,
}

pub struct DrumRenderer {
    device: Device,
    queue: CommandQueue,
    pipeline: metal::RenderPipelineState,
    depth: metal::DepthStencilState,
    vertex_buffer: Buffer,
    index_buffer: Buffer,
    index_count: u32,
    uniform_buffer: Buffer,
    depth_texture: Option<metal::Texture>,
    depth_size: (u32, u32),
    state: Arc<Mutex<SceneState>>,
}

impl DrumRenderer {
    pub fn new(state: Arc<Mutex<SceneState>>) -> Option<Self> {
        let device = Device::system_default()?;
        let queue = device.new_command_queue();

        let library = device
            .new_library_with_source(SHADER, &CompileOptions::new())
            .ok()?;
        let vfn = library.get_function("vertex_main", None).ok()?;
        let ffn = library.get_function("fragment_main", None).ok()?;

        let vertex_desc = {
            let mut vd = VertexDescriptor::new();
            let attr0 = vd.attributes().object_at(0).unwrap();
            attr0.set_format(metal::MTLVertexFormat::Float3);
            attr0.set_offset(0);
            attr0.set_buffer_index(0);
            let attr1 = vd.attributes().object_at(1).unwrap();
            attr1.set_format(metal::MTLVertexFormat::Float3);
            attr1.set_offset(12);
            attr1.set_buffer_index(0);
            let layout = vd.layouts().object_at(0).unwrap();
            layout.set_stride(24);
            layout.set_step_function(MTLVertexStepFunction::PerVertex);
            vd
        };

        let pipeline_desc = {
            let mut d = RenderPipelineDescriptor::new();
            d.set_vertex_function(Some(&vfn));
            d.set_fragment_function(Some(&ffn));
            d.set_vertex_descriptor(Some(&vertex_desc));
            d.color_attachments()
                .object_at(0)
                .unwrap()
                .set_pixel_format(MTLPixelFormat::BGRA8Unorm);
            d.set_depth_attachment_pixel_format(MTLPixelFormat::Depth32Float);
            d
        };
        let pipeline = device.new_render_pipeline_state(&pipeline_desc).ok()?;

        let depth_desc = metal::DepthStencilDescriptor::new();
        depth_desc.set_depth_compare_function(metal::MTLCompareFunction::Less);
        depth_desc.set_depth_write_enabled(true);
        let depth = device.new_depth_stencil_state(&depth_desc);

        let (vertices, indices) = build_drum_mesh();
        let vertex_buffer = device.new_buffer_with_data(
            vertices.as_ptr() as *const _,
            (vertices.len() * std::mem::size_of::<Vertex>()) as u64,
            MTLResourceOptions::StorageModeShared,
        );
        let index_buffer = device.new_buffer_with_data(
            indices.as_ptr() as *const _,
            (indices.len() * std::mem::size_of::<u16>()) as u64,
            MTLResourceOptions::StorageModeShared,
        );
        let uniform_buffer = device.new_buffer(
            std::mem::size_of::<Uniforms>() as u64,
            MTLResourceOptions::StorageModeShared,
        );

        Some(Self {
            device,
            queue,
            pipeline,
            depth,
            vertex_buffer,
            index_buffer,
            index_count: indices.len() as u32,
            uniform_buffer,
            depth_texture: None,
            depth_size: (0, 0),
            state,
        })
    }

    pub fn draw(&mut self, drawable: &MetalDrawableRef, width: f32, height: f32) {
        let texture = drawable.texture();
        self.ensure_depth(width as u32, height as u32);

        {
            let mut s = self.state.lock().unwrap();
            s.angle += s.drag_velocity;
            s.drag_velocity *= 0.94;
            let u = Uniforms {
                angle: s.angle,
                aspect: width / height.max(1.0),
            };
            let ptr = self.uniform_buffer.contents() as *mut Uniforms;
            unsafe {
                *ptr = u;
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
        enc.set_render_pipeline_state(&self.pipeline);
        enc.set_depth_stencil_state(&self.depth);
        enc.set_cull_mode(metal::MTLCullMode::None);
        enc.set_vertex_buffer(0, Some(&self.vertex_buffer), 0);
        enc.set_vertex_buffer(1, Some(&self.uniform_buffer), 0);
        enc.draw_indexed_primitives(
            MTLPrimitiveType::Triangle,
            self.index_count as u64,
            MTLIndexType::UInt16,
            &self.index_buffer,
            0,
        );
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

fn build_drum_mesh() -> (Vec<Vertex>, Vec<u16>) {
    let segments = 32usize;
    let rows = 8usize;
    let radius = 1.35f32;
    let half_h = 1.05f32;
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
                Vertex {
                    position: [a0.cos() * radius, y0, a0.sin() * radius],
                    color,
                },
                Vertex {
                    position: [a1.cos() * radius, y0, a1.sin() * radius],
                    color,
                },
                Vertex {
                    position: [a1.cos() * radius, y1, a1.sin() * radius],
                    color,
                },
                Vertex {
                    position: [a0.cos() * radius, y1, a0.sin() * radius],
                    color,
                },
            ]);
            indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        }
    }

    (vertices, indices)
}
