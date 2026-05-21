//! Read-only parse of Tish scene objects for Metal (never mutates the scene value).

use tish_apple_common::canvas::canvas_rgba_bytes;
use tishlang_core::{ObjectMap, Value};

const CELL_W: u32 = 256;
const CELL_H: u32 = 100;

#[derive(Clone, Debug)]
pub struct SceneLayout {
    pub radius: f32,
    pub height_total: f32,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Clone, Debug)]
pub struct CardInstance {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub theta: f32,
    pub u0: f32,
    pub v0: f32,
    pub u1: f32,
    pub v1: f32,
}

#[derive(Clone, Debug)]
pub struct PreparedScene {
    pub layout: SceneLayout,
    pub atlas_width: u32,
    pub atlas_height: u32,
    pub atlas_rgba: Vec<u8>,
    pub cards: Vec<CardInstance>,
}

fn num_field(m: &ObjectMap, key: &str) -> Option<f64> {
    m.get(key).and_then(|v| v.as_number())
}

fn blit_rgba(
    atlas: &mut [u8],
    atlas_w: u32,
    dst_x: u32,
    dst_y: u32,
    copy_w: u32,
    copy_h: u32,
    src_stride: u32,
    rgba: &[u8],
) {
    for row in 0..copy_h {
        for col in 0..copy_w {
            let si = ((row * src_stride + col) * 4) as usize;
            if si + 3 >= rgba.len() {
                continue;
            }
            let dx = dst_x + col;
            let dy = dst_y + row;
            if dx >= atlas_w {
                continue;
            }
            let di = ((dy * atlas_w + dx) * 4) as usize;
            if di + 3 >= atlas.len() {
                continue;
            }
            atlas[di..di + 4].copy_from_slice(&rgba[si..si + 4]);
        }
    }
}

/// Parse a Tish scene object into GPU-ready data without modifying `scene`.
pub fn parse_scene(scene: &Value) -> Option<PreparedScene> {
    let Value::Object(obj) = scene else {
        return None;
    };
    let m = &obj.borrow().strings;

    let cols = num_field(m, "cols").unwrap_or(1.0).max(1.0) as u32;
    let rows = num_field(m, "rows").unwrap_or(1.0).max(1.0) as u32;
    let radius = num_field(m, "radius").unwrap_or(1.35) as f32;
    let height_total = num_field(m, "heightTotal")
        .or_else(|| num_field(m, "height_total"))
        .unwrap_or(2.1) as f32;

    let Value::Array(cells_arr) = m.get("cells")? else {
        return None;
    };
    let cells = cells_arr.borrow();
    if cells.is_empty() {
        return None;
    }

    let atlas_w = cols * CELL_W;
    let atlas_h = rows * CELL_H;
    let mut atlas = vec![0u8; (atlas_w * atlas_h * 4) as usize];
    let mut cards = Vec::new();

    for cell in cells.iter() {
        let Value::Object(cell_obj) = cell else {
            continue;
        };
        let cm = &cell_obj.borrow().strings;
        let canvas = match cm.get("canvas") {
            Some(c) => c,
            None => continue,
        };
        let (src_w, src_h, rgba) = canvas_rgba_bytes(canvas)?;
        let copy_w = src_w.min(CELL_W);
        let copy_h = src_h.min(CELL_H);

        let c = num_field(cm, "c").unwrap_or(0.0).max(0.0) as u32;
        let r = num_field(cm, "r").unwrap_or(0.0).max(0.0) as u32;
        if c >= cols || r >= rows {
            continue;
        }

        let ax = c * CELL_W;
        let ay = r * CELL_H;
        blit_rgba(
            &mut atlas,
            atlas_w,
            ax,
            ay,
            copy_w,
            copy_h,
            src_w,
            &rgba,
        );

        let u0 = ax as f32 / atlas_w as f32;
        let v0 = ay as f32 / atlas_h as f32;
        let u1 = (ax + copy_w) as f32 / atlas_w as f32;
        let v1 = (ay + copy_h) as f32 / atlas_h as f32;

        let x = num_field(cm, "x").unwrap_or(0.0) as f32;
        let y = num_field(cm, "y").unwrap_or(0.0) as f32;
        let z = num_field(cm, "z").unwrap_or(radius as f64) as f32;
        let theta = num_field(cm, "theta").unwrap_or(0.0) as f32;

        cards.push(CardInstance {
            x,
            y,
            z,
            theta,
            u0,
            v0,
            u1,
            v1,
        });
    }

    if cards.is_empty() {
        return None;
    }

    Some(PreparedScene {
        layout: SceneLayout {
            radius,
            height_total,
            cols,
            rows,
        },
        atlas_width: atlas_w,
        atlas_height: atlas_h,
        atlas_rgba: atlas,
        cards,
    })
}

pub fn debug_scene_parse(scene: &Value) -> String {
    if matches!(scene, Value::Null) {
        return "no scene".into();
    }
    match parse_scene(scene) {
        Some(p) => format!(
            "ok {} cards, {}x{} atlas ({} bytes)",
            p.cards.len(),
            p.atlas_width,
            p.atlas_height,
            p.atlas_rgba.len()
        ),
        None => "parse failed".into(),
    }
}
