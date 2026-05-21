//! Screen-space card picking (matches Metal vertex projection).

use std::f32::consts::PI;

use crate::renderer::{camera_distance, slot_card_width, CARD_H, CARD_SURFACE_PUSH};
use crate::scene_data::{CardInstance, PreparedScene};

const PROJ_F: f32 = 1.0 / 0.41421356237;

fn rotate_y(p: [f32; 3], angle: f32) -> [f32; 3] {
    let c = angle.cos();
    let s = angle.sin();
    [
        c * p[0] + s * p[2],
        p[1],
        -s * p[0] + c * p[2],
    ]
}

fn transform_corner(local: [f32; 3], card: &CardInstance) -> [f32; 3] {
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

fn project_point(
    world: [f32; 3],
    angle: f32,
    cam_dist: f32,
    aspect: f32,
    view_w: f32,
    view_h: f32,
) -> Option<(f32, f32, f32)> {
    let rot = rotate_y(world, angle);
    let eye_z = rot[2] - cam_dist;
    if eye_z >= -0.05 {
        return None;
    }
    let eye_x = rot[0];
    let eye_y = rot[1] + 0.15;
    let ndc_x = eye_x * PROJ_F / aspect / (-eye_z);
    let ndc_y = eye_y * PROJ_F / (-eye_z);
    if ndc_x.abs() > 1.5 || ndc_y.abs() > 1.5 {
        return None;
    }
    let sx = (ndc_x + 1.0) * 0.5 * view_w;
    let sy = (1.0 - ndc_y) * 0.5 * view_h;
    Some((sx, sy, -eye_z))
}

/// Pick the front-most card under a UIKit tap point (top-left origin, points).
pub fn pick_card_at_point(
    scene: &PreparedScene,
    angle: f32,
    zoom: f32,
    tap_x: f32,
    tap_y: f32,
    view_w: f32,
    view_h: f32,
) -> Option<usize> {
    if view_w < 1.0 || view_h < 1.0 {
        return None;
    }
    let card_w = slot_card_width(scene.layout.cols, scene.layout.radius);
    let base_cam = camera_distance(scene.layout.radius);
    let cam_dist = base_cam * (1.0 - zoom * 0.55).max(0.4);
    let aspect = view_w / view_h.max(1.0);
    let hw = card_w * 0.5;
    let hh = CARD_H * 0.5;
    let corners = [
        [-hw, -hh, 0.0],
        [hw, -hh, 0.0],
        [hw, hh, 0.0],
        [-hw, hh, 0.0],
    ];

    let mut best: Option<(usize, f32)> = None;
    for card in &scene.cards {
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        let mut depth = f32::INFINITY;
        let mut any = false;
        for local in corners {
            let world = transform_corner(local, card);
            let Some((sx, sy, d)) = project_point(world, angle, cam_dist, aspect, view_w, view_h)
            else {
                continue;
            };
            any = true;
            min_x = min_x.min(sx);
            max_x = max_x.max(sx);
            min_y = min_y.min(sy);
            max_y = max_y.max(sy);
            depth = depth.min(d);
        }
        if !any {
            continue;
        }
        if tap_x >= min_x && tap_x <= max_x && tap_y >= min_y && tap_y <= max_y {
            let dominated = best.map(|(_, bd)| depth >= bd).unwrap_or(false);
            if !dominated {
                best = Some((card.index, depth));
            }
        }
    }
    best.map(|(i, _)| i)
}

pub fn go_to_card_angle(theta: f32) -> f32 {
    PI - theta
}
