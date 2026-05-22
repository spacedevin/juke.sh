//! Shared camera projection — mirrors web three-scene.js zoom/FOV math.

use std::f32::consts::PI;

const TIGHT_FOV_NORMAL: f32 = 12.0;
const TIGHT_FOV_FLAT: f32 = 2.0;
const FIT_FOV: f32 = 45.0;

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
        // Legacy preview distance (worked in pre-port builds), scaled for drum size.
        let base = 6.5 * (self.radius / 3.5).max(0.35) * (self.height_total / 7.0).max(0.45);
        base * (1.0 - z * 0.55).max(0.4)
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
