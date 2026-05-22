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
const QUEUE_WORDS: usize = 16;

/// Grid slot pose — must match [`layout.tish`](../../juke-scene/src/layout.tish).
pub(crate) fn grid_slot_theta(c: u32, r: u32, cols: u32, rows: u32) -> f32 {
    slot_position(c, r, cols, rows).3
}

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

fn parse_hex_color(v: &Value) -> Option<[f32; 3]> {
    let s = v.to_display_string();
    let hex = s.trim().trim_start_matches('#');
    if hex.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&hex[0..2], 16).ok()? as f32 / 255.0;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()? as f32 / 255.0;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()? as f32 / 255.0;
    Some([r, g, b])
}

fn bool_field(m: &ObjectMap, key: &str) -> bool {
    match m.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => *n != 0.0,
        _ => false,
    }
}

#[derive(Clone, Debug)]
pub struct SceneLayout {
    pub radius: f32,
    pub height_total: f32,
    pub cols: u32,
    pub rows: u32,
    pub total_slots: u32,
}

#[derive(Clone, Debug)]
pub struct CardInstance {
    /// Canonical grid slot index (`slotIndex` in Tish).
    pub slot_index: usize,
    pub c: u32,
    pub r: u32,
    pub title: String,
    pub uri: String,
    pub empty: bool,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub theta: f32,
    pub u0: f32,
    pub v0: f32,
    pub u1: f32,
    pub v1: f32,
    pub accent: [f32; 3],
    pub bg: [f32; 3],
    pub alt: [f32; 3],
}

#[derive(Clone, Debug)]
pub struct PreparedScene {
    pub layout: SceneLayout,
    pub atlas_width: u32,
    pub atlas_height: u32,
    pub atlas_rgba: Vec<u8>,
    pub category_atlas_width: u32,
    pub category_atlas_height: u32,
    pub category_atlas_rgba: Vec<u8>,
    pub category_count: u32,
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

fn parse_category_atlas(m: &ObjectMap) -> (u32, u32, Vec<u8>, u32) {
    let count = num_field(m, "categoryCount")
        .unwrap_or(10.0)
        .max(1.0) as u32;
    let Some(canvas) = m.get("categoryAtlas") else {
        return (0, 0, Vec::new(), count);
    };
    let Some((w, h, rgba)) = canvas_rgba_bytes(canvas) else {
        return (0, 0, Vec::new(), count);
    };
    (w, h, rgba, count)
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
    let total_slots = num_field(m, "totalCells")
        .map(|n| n.max(1.0) as u32)
        .unwrap_or(cols * rows);

    let Value::Array(cells_arr) = m.get("cells")? else {
        return None;
    };
    let cells = cells_arr.borrow();

    let atlas_w = cols * CELL_W;
    let atlas_h = rows * CELL_H;
    let mut atlas = vec![0u8; (atlas_w * atlas_h * 4) as usize];
    let mut cards = Vec::new();

    for cell in cells.iter() {
        let Value::Object(cell_obj) = cell else {
            continue;
        };
        let cm = &cell_obj.borrow().strings;
        let c = num_field(cm, "c").unwrap_or(0.0).max(0.0) as u32;
        let r = num_field(cm, "r").unwrap_or(0.0).max(0.0) as u32;
        if c >= cols || r >= rows {
            continue;
        }

        let slot_index = num_field(cm, "slotIndex")
            .map(|n| n.max(0.0) as usize)
            .unwrap_or((r * cols + c) as usize);
        let empty = bool_field(cm, "empty");
        let (def_x, def_y, def_z, def_theta) = slot_position(c, r, cols, rows);
        let x = num_field(cm, "x").map(|n| n as f32).unwrap_or(def_x);
        let y = num_field(cm, "y").map(|n| n as f32).unwrap_or(def_y);
        let z = num_field(cm, "z").map(|n| n as f32).unwrap_or(def_z);
        let theta = num_field(cm, "theta").map(|n| n as f32).unwrap_or(def_theta);
        let title = cm
            .get("titleA")
            .or_else(|| cm.get("title"))
            .map(|v| v.to_display_string())
            .unwrap_or_default();
        let uri = cm
            .get("uri")
            .map(|v| v.to_display_string())
            .unwrap_or_default();
        let accent = cm
            .get("accent")
            .and_then(parse_hex_color)
            .unwrap_or([0.0, 0.95, 1.0]);
        let bg = cm
            .get("bg")
            .and_then(parse_hex_color)
            .unwrap_or([0.1, 0.1, 0.15]);
        let alt = cm
            .get("alt")
            .and_then(parse_hex_color)
            .unwrap_or([1.0, 0.5, 0.2]);

        let mut render_empty = empty;
        let (u0, v0, u1, v1) = if !empty {
            match cm.get("canvas").and_then(|canvas| canvas_rgba_bytes(canvas)) {
                Some((src_w, src_h, rgba)) => {
                    let copy_w = src_w.min(CELL_W);
                    let copy_h = src_h.min(CELL_H);
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
                    (
                        ax as f32 / atlas_w as f32,
                        ay as f32 / atlas_h as f32,
                        (ax + copy_w) as f32 / atlas_w as f32,
                        (ay + copy_h) as f32 / atlas_h as f32,
                    )
                }
                None => {
                    eprintln!("[juke-scene] cell {slot_index} canvas unreadable");
                    render_empty = true;
                    (0.0, 0.0, 0.0, 0.0)
                }
            }
        } else {
            (0.0, 0.0, 0.0, 0.0)
        };

        cards.push(CardInstance {
            slot_index,
            c,
            r,
            title,
            uri,
            empty: render_empty,
            x,
            y,
            z,
            theta,
            u0,
            v0,
            u1,
            v1,
            accent,
            bg,
            alt,
        });
    }

    if cards.is_empty() {
        return None;
    }

    let (cat_w, cat_h, cat_rgba, cat_count) = parse_category_atlas(m);

    Some(PreparedScene {
        layout: SceneLayout {
            radius,
            height_total,
            cols,
            rows,
            total_slots,
        },
        atlas_width: atlas_w,
        atlas_height: atlas_h,
        atlas_rgba: atlas,
        category_atlas_width: cat_w,
        category_atlas_height: cat_h,
        category_atlas_rgba: cat_rgba,
        category_count: cat_count,
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
        card.slot_index.hash(&mut h);
        card.c.hash(&mut h);
        card.r.hash(&mut h);
        card.empty.hash(&mut h);
    }
    h.finish()
}

pub fn queue_words_for_slots(total: u32) -> usize {
    ((total as usize + 31) / 32).min(QUEUE_WORDS)
}

pub fn debug_scene_parse(scene: &Value) -> String {
    if matches!(scene, Value::Null) {
        return "no scene".into();
    }
    match parse_scene(scene) {
        Some(p) => {
            let track_cards = p.cards.iter().filter(|c| !c.empty).count();
            let empty_slots = p.cards.iter().filter(|c| c.empty).count();
            let opaque_pixels = p
                .atlas_rgba
                .chunks(4)
                .filter(|px| px.len() == 4 && px[3] > 8)
                .count();
            format!(
                "ok {} slots ({} tracks, {} empty), {}x{} grid, {}x{} atlas, {} px",
                p.cards.len(),
                track_cards,
                empty_slots,
                p.layout.cols,
                p.layout.rows,
                p.atlas_width,
                p.atlas_height,
                opaque_pixels,
            )
        }
        None => "parse failed".into(),
    }
}
