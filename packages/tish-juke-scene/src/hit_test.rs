//! Screen-space card picking (matches Metal vertex projection).

use std::f32::consts::PI;

use crate::camera::CameraParams;
use crate::renderer::{slot_card_width, CARD_H, CARD_SURFACE_PUSH};
use crate::scene_data::{grid_slot_theta, CardInstance, PreparedScene};

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
    let wy = ry + card.y;
    let mut wz = rz + card.z;
    let radial = (card.x * card.x + card.z * card.z).sqrt().max(1e-4);
    wx += (card.x / radial) * CARD_SURFACE_PUSH;
    wz += (card.z / radial) * CARD_SURFACE_PUSH;
    [wx, wy, wz]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn normalize(v: [f32; 3]) -> [f32; 3] {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-6);
    [v[0] / len, v[1] / len, v[2] / len]
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/// Match Metal `project()` — lookAt from web OrbitControls camera position.
fn project_point(
    world: [f32; 3],
    angle: f32,
    cam_pos: [f32; 3],
    proj_f: f32,
    aspect: f32,
    view_w: f32,
    view_h: f32,
) -> Option<(f32, f32, f32)> {
    let p = rotate_y(world, angle);
    let target = [0.0, 0.0, 0.0];
    let forward = normalize(sub(target, cam_pos));
    let world_up = [0.0, 1.0, 0.0];
    let right = normalize(cross(forward, world_up));
    let up = cross(right, forward);
    let rel = sub(p, cam_pos);
    let eye_x = dot(rel, right);
    let eye_y = dot(rel, up);
    let eye_z = dot(rel, forward);
    if eye_z <= crate::camera::DEPTH_NEAR {
        return None;
    }
    let ndc_x = eye_x * proj_f / aspect / eye_z;
    let ndc_y = eye_y * proj_f / eye_z;
    if ndc_x.abs() > 1.5 || ndc_y.abs() > 1.5 {
        return None;
    }
    let sx = (ndc_x + 1.0) * 0.5 * view_w;
    let sy = (1.0 - ndc_y) * 0.5 * view_h;
    Some((sx, sy, eye_z))
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
    cam_pos: [f32; 3],
    proj_f: f32,
    aspect: f32,
    view_w: f32,
    view_h: f32,
) -> Option<([(f32, f32); 4], f32)> {
    let mut screen = [(0.0, 0.0); 4];
    let mut depth = f32::INFINITY;
    for (i, local) in corners.iter().enumerate() {
        let world = transform_corner(*local, card);
        let (sx, sy, d) =
            project_point(world, angle, cam_pos, proj_f, aspect, view_w, view_h)?;
        screen[i] = (sx, sy);
        depth = depth.min(d);
    }
    Some((screen, depth))
}

fn card_faces_camera(card: &CardInstance, angle: f32) -> bool {
    let nx = card.theta.sin();
    let nz = card.theta.cos();
    let normal = rotate_y([nx, 0.0, nz], angle);
    normal[2] > 0.08
}

fn shortest_angle_diff(from: f32, to: f32) -> f32 {
    let mut diff = to - from;
    while diff > PI {
        diff -= 2.0 * PI;
    }
    while diff < -PI {
        diff += 2.0 * PI;
    }
    diff
}

pub struct PickCamera {
    /// Drum group rotation (`jukeboxGroup.rotation.y`) — snap-to-card only.
    pub drum_angle: f32,
    pub camera_az: f32,
    pub zoom: f32,
    pub zoom_tight: f32,
    pub zoom_flat: f32,
}

#[derive(Clone, Debug)]
pub struct PickedCard {
    pub slot_index: usize,
    pub c: u32,
    pub r: u32,
    pub title: String,
    pub uri: String,
    pub accent: [f32; 3],
    pub bg: [f32; 3],
    pub alt: [f32; 3],
}

/// Drum snap target — web: `groupRotTarget = curAz - card.theta`.
pub fn snap_target_angle(drum_angle: f32, camera_az: f32, card_theta: f32) -> f32 {
    let target = camera_az - card_theta;
    drum_angle + shortest_angle_diff(drum_angle, target)
}

/// Pick the front-most track card under a UIKit tap point (top-left origin, pixels).
pub fn pick_card_at_point(
    scene: &PreparedScene,
    cam: PickCamera,
    tap_x: f32,
    tap_y: f32,
    view_w: f32,
    view_h: f32,
) -> Option<PickedCard> {
    if view_w < 1.0 || view_h < 1.0 {
        return None;
    }
    let aspect = view_w / view_h.max(1.0);
    let params = CameraParams {
        zoom: cam.zoom,
        zoom_tight: cam.zoom_tight,
        zoom_flat: cam.zoom_flat,
        aspect,
        height_total: scene.layout.height_total,
        radius: scene.layout.radius,
        camera_az: cam.camera_az,
    };
    let cam_pos = params.camera_position();
    let proj_f = params.proj_f();
    let card_w = slot_card_width(scene.layout.cols, scene.layout.radius);
    let hw = card_w * 0.5;
    let hh = CARD_H * 0.5;
    let corners = [
        [-hw, -hh, 0.0],
        [hw, -hh, 0.0],
        [hw, hh, 0.0],
        [-hw, hh, 0.0],
    ];

    let mut best: Option<(PickedCard, f32, f32)> = None;
    for card in &scene.cards {
        if card.empty || !card_faces_camera(card, cam.drum_angle) {
            continue;
        }
        let Some((quad, depth)) = project_card_quad(
            card,
            &corners,
            cam.drum_angle,
            cam_pos,
            proj_f,
            aspect,
            view_w,
            view_h,
        ) else {
            continue;
        };
        if !point_in_quad(tap_x, tap_y, &quad) {
            continue;
        }
        let cx = (quad[0].0 + quad[1].0 + quad[2].0 + quad[3].0) * 0.25;
        let cy = (quad[0].1 + quad[1].1 + quad[2].1 + quad[3].1) * 0.25;
        let dist_sq = (cx - tap_x) * (cx - tap_x) + (cy - tap_y) * (cy - tap_y);
        if best.as_ref().is_none_or(|(_, d, ds)| depth < *d || (depth - *d).abs() < 0.01 && dist_sq < *ds) {
            best = Some((
                PickedCard {
                    slot_index: card.slot_index,
                    c: card.c,
                    r: card.r,
                    title: card.title.clone(),
                    uri: card.uri.clone(),
                    accent: card.accent,
                    bg: card.bg,
                    alt: card.alt,
                },
                depth,
                dist_sq,
            ));
        }
    }
    best.map(|(p, _, _)| p)
}

pub fn snap_angle_for_picked(drum_angle: f32, camera_az: f32, scene: &PreparedScene, picked: &PickedCard) -> f32 {
    let theta = scene
        .cards
        .iter()
        .find(|c| c.slot_index == picked.slot_index)
        .map(|c| c.theta)
        .unwrap_or_else(|| grid_slot_theta(picked.c, picked.r, scene.layout.cols, scene.layout.rows));
    snap_target_angle(drum_angle, camera_az, theta)
}
