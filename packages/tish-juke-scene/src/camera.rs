//! Shared camera projection — mirrors web three-scene.js zoom/FOV math.

use std::f32::consts::PI;

const TIGHT_FOV_NORMAL: f32 = 12.0;
const TIGHT_FOV_FLAT: f32 = 2.0;
const FIT_FOV: f32 = 45.0;

/// Camera follow rate — matches web `camera.fov += (target - fov) * 0.12`.
pub const ZOOM_DISPLAY_LERP: f32 = 0.12;
/// Rubber-band past 0/1 while pinching.
const ZOOM_RUBBER: f32 = 0.28;
/// Spring-back speed when pinch ends outside bounds.
const ZOOM_SPRING: f32 = 0.32;
const ZOOM_DAMPING: f32 = 0.62;

#[derive(Clone, Copy, Debug)]
pub struct CameraParams {
    pub zoom: f32,
    pub zoom_tight: f32,
    pub zoom_flat: f32,
    pub aspect: f32,
    pub height_total: f32,
    pub radius: f32,
}

impl CameraParams {
    pub fn proj_f(&self) -> f32 {
        let z = self.zoom.clamp(0.0, 1.0);
        let tight_fov =
            TIGHT_FOV_NORMAL + (TIGHT_FOV_FLAT - TIGHT_FOV_NORMAL) * self.zoom_flat.clamp(0.0, 1.0);
        let target_fov = FIT_FOV + (tight_fov - FIT_FOV) * z;
        let half_rad = (target_fov * PI / 180.0) * 0.5;
        1.0 / half_rad.tan()
    }

    pub fn cam_dist(&self) -> f32 {
        let z = self.zoom.clamp(0.0, 1.0);
        let tight_fov =
            TIGHT_FOV_NORMAL + (TIGHT_FOV_FLAT - TIGHT_FOV_NORMAL) * self.zoom_flat.clamp(0.0, 1.0);
        let target_fov = FIT_FOV + (tight_fov - FIT_FOV) * z;
        let tan_half = ((target_fov * PI / 180.0) * 0.5).tan().max(1e-4);
        let h_dist = (self.height_total + 1.0) / (2.0 * tan_half);
        let w_dist = (self.radius * 2.0 + 4.0) / (2.0 * tan_half * self.aspect.max(0.1));
        let fit_dist = h_dist.max(w_dist);
        let tight_dist = h_dist * self.zoom_tight.clamp(0.5, 1.5);
        let target_dist = fit_dist + (tight_dist - fit_dist) * z;
        self.radius + target_dist
    }
}

pub fn base_cam_dist(radius: f32) -> f32 {
    CameraParams {
        zoom: 0.0,
        zoom_tight: 0.95,
        zoom_flat: 0.0,
        aspect: 1.0,
        height_total: 2.1,
        radius,
    }
    .cam_dist()
}

/// Visual zoom target with rubber-band past the ends (pinch overshoot).
pub fn zoom_visual_target(zoom: f32) -> f32 {
    if zoom < 0.0 {
        zoom * ZOOM_RUBBER
    } else if zoom > 1.0 {
        1.0 + (zoom - 1.0) * ZOOM_RUBBER
    } else {
        zoom
    }
}

/// Advance smoothed camera zoom + spring bounce after pinch release.
pub fn advance_zoom(state: &mut crate::renderer::SceneState) {
    if !state.pinch_active && (state.zoom < 0.0 || state.zoom > 1.0) {
        let clamped = state.zoom.clamp(0.0, 1.0);
        state.zoom_velocity += (clamped - state.zoom) * ZOOM_SPRING;
        state.zoom_velocity *= ZOOM_DAMPING;
        state.zoom += state.zoom_velocity;
        if state.zoom >= 0.0
            && state.zoom <= 1.0
            && state.zoom_velocity.abs() < 0.0008
            && (state.zoom - clamped).abs() < 0.002
        {
            state.zoom = clamped;
            state.zoom_velocity = 0.0;
        }
    } else if !state.pinch_active {
        state.zoom_velocity *= 0.5;
    }

    let target = zoom_visual_target(state.zoom);
    state.zoom_display += (target - state.zoom_display) * ZOOM_DISPLAY_LERP;
}
