//! Read-only parse of Tish scene objects for Metal (never mutates the scene value).

use std::hash::{Hash, Hasher};

use tish_apple_common::canvas::canvas_rgba_bytes;
use tishlang_core::{ObjectMap, Value};

const CELL_W: u32 = 256;
const CELL_H: u32 = 100;
const CARD_W: f32 = 3.2;
const CARD_GAP: f32 = 0.3;
const ROW_SPACING: f32 = 1.4;
const CARD_RADIAL_OFFSET: f32 = 0.12;

/// Grid slot pose — must match [`layout.tish`](../../juke-scene/src/layout.tish).
fn slot_position(c: u32, r: u32, cols: u32, rows: u32) -> (f32, f32, f32, f32) {
    use std::f32::consts::PI;
    let cols_f = cols.max(1) as f32;
    let col_angle = (2.0 * PI) / cols_f;
    let radius = (cols_f * (CARD_W + CARD_GAP)) / (2.0 * PI);
    let start_y = (rows as f32 * ROW_SPACING) / 2.0 - ROW_SPACING / 2.0;
    let theta = -PI + c as f32 * col_angle + col_angle / 2.0;
    let radial = radius + CARD_RADIAL_OFFSET;
    let x = theta.sin() * radial;
    let z = theta.cos() * radial;
    let y = start_y - r as f32 * ROW_SPACING;
    (x, y, z, theta)
}

#[derive(Clone, Debug)]
pub struct SceneLayout {
    pub radius: f32,
    pub height_total: f32,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Clone, Debug)]
pub struct CardInstance {
    pub index: usize,
    pub c: u32,
    pub r: u32,
    pub title: String,
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

    for (index, cell) in cells.iter().enumerate() {
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

        let (x, y, z, theta) = slot_position(c, r, cols, rows);
        let cell_index = num_field(cm, "index")
            .map(|n| n.max(0.0) as usize)
            .unwrap_or(index);
        let title = cm
            .get("titleA")
            .or_else(|| cm.get("title"))
            .map(|v| v.to_display_string())
            .unwrap_or_default();

        cards.push(CardInstance {
            index: cell_index,
            c,
            r,
            title,
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

/// Fingerprint of card layout identity — changes when shuffle/grid assignment changes.
pub fn scene_fingerprint(p: &PreparedScene) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    p.layout.cols.hash(&mut h);
    p.layout.rows.hash(&mut h);
    p.cards.len().hash(&mut h);
    for card in &p.cards {
        card.index.hash(&mut h);
        card.c.hash(&mut h);
        card.r.hash(&mut h);
    }
    h.finish()
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
