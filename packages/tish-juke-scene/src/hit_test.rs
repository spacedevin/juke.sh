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

fn cross_2d(ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    ax * by - ay * bx
}

fn point_in_tri(px: f32, py: f32, a: (f32, f32), b: (f32, f32), c: (f32, f32)) -> bool {
    let same = |p: (f32, f32), u: (f32, f32), v: (f32, f32), w: (f32, f32)| {
        cross_2d(v.0 - u.0, v.1 - u.1, w.0 - u.0, w.1 - u.1)
            * cross_2d(v.0 - u.0, v.1 - u.1, p.0 - u.0, p.1 - u.1)
            >= 0.0
    };
    same((px, py), a, b, c) && same((px, py), b, c, a) && same((px, py), c, a, b)
}

fn point_in_quad(px: f32, py: f32, q: &[(f32, f32); 4]) -> bool {
    point_in_tri(px, py, q[0], q[1], q[2]) || point_in_tri(px, py, q[0], q[2], q[3])
}

fn project_card_quad(
    card: &CardInstance,
    corners: &[[f32; 3]; 4],
    angle: f32,
    cam_dist: f32,
    aspect: f32,
    view_w: f32,
    view_h: f32,
) -> Option<([(f32, f32); 4], f32)> {
    let mut screen = [(0.0, 0.0); 4];
    let mut depth = f32::INFINITY;
    for (i, local) in corners.iter().enumerate() {
        let world = transform_corner(*local, card);
        let (sx, sy, d) = project_point(world, angle, cam_dist, aspect, view_w, view_h)?;
        screen[i] = (sx, sy);
        depth = depth.min(d);
    }
    Some((screen, depth))
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

    let mut best: Option<(usize, f32, f32)> = None;
    for card in &scene.cards {
        let Some((quad, depth)) =
            project_card_quad(card, &corners, angle, cam_dist, aspect, view_w, view_h)
        else {
            continue;
        };
        if !point_in_quad(tap_x, tap_y, &quad) {
            continue;
        }
        let cx = (quad[0].0 + quad[1].0 + quad[2].0 + quad[3].0) * 0.25;
        let cy = (quad[0].1 + quad[1].1 + quad[2].1 + quad[3].1) * 0.25;
        let dist_sq = (cx - tap_x) * (cx - tap_x) + (cy - tap_y) * (cy - tap_y);
        let dominated = best
            .map(|(_, bd, bd_dist)| depth > bd + 1e-4 || (depth - bd).abs() <= 1e-4 && dist_sq >= bd_dist)
            .unwrap_or(false);
        if !dominated {
            best = Some((card.index, depth, dist_sq));
        }
    }
    best.map(|(i, _, _)| i)
}

pub fn go_to_card_angle(theta: f32) -> f32 {
    PI - theta
}
