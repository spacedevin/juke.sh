//! Scene lighting — mirrors `three-scene.js` animate-loop block exactly.

use crate::renderer::SceneState;

const LIGHT_LERP: f32 = 0.05;
const COLOR_LERP: f32 = 0.05;
const POINT_COLOR_LERP: f32 = 0.03;
const LED_COLOR_LERP: f32 = 0.1;

const AMBIENT_WARM: [f32; 3] = [1.0, 176.0 / 255.0, 96.0 / 255.0]; // 0xffb060
const CAM_LIGHT_WARM: [f32; 3] = [1.0, 184.0 / 255.0, 120.0 / 255.0]; // 0xffb878
const LED_BASE: [f32; 3] = [1.0, 213.0 / 255.0, 128.0 / 255.0]; // 0xffd580

#[derive(Clone, Copy, Debug, Default)]
pub struct LightIntensities {
    pub hemi: f32,
    pub dir: f32,
    pub ambient: f32,
    pub cam: f32,
    pub fill_white: f32,
    pub fill_amber: f32,
    pub fill_pink: f32,
    pub fill_front: f32,
    pub point: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct LightColors {
    pub ambient: [f32; 3],
    pub cam: [f32; 3],
    pub point1: [f32; 3],
    pub point2: [f32; 3],
    pub led: [f32; 3],
}

impl Default for LightColors {
    fn default() -> Self {
        Self {
            ambient: [1.0, 1.0, 1.0],
            cam: [1.0, 1.0, 1.0],
            point1: [0.0, 1.0, 1.0],
            point2: [1.0, 0.0, 1.0],
            led: LED_BASE,
        }
    }
}

fn ftt(fit: f32, tight: f32, z: f32) -> f32 {
    fit + (tight - fit) * z
}

fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

fn lerp3_mut(a: &mut [f32; 3], b: [f32; 3], t: f32) {
    *a = lerp3(*a, b, t);
}

fn lerp_toward(current: f32, target: f32, t: f32) -> f32 {
    current + (target - current) * t
}

/// Web `animate()` lighting block — intensity targets + exponential smoothing.
pub fn advance_lights(state: &mut SceneState, t_color1: [f32; 3], t_color2: [f32; 3]) {
    let z = state.zoom;
    let l = state.lighting;

    let target_fill_white = l * 0.15;
    let target_fill_amber = l * 0.15;
    let target_fill_pink = l * 1.4;
    let target_fill_front = l * 0.30;
    let neon_target = 0.5 + l * 5.0;

    let li = &mut state.light_intensities;
    li.fill_white = lerp_toward(li.fill_white, target_fill_white, LIGHT_LERP);
    li.fill_amber = lerp_toward(li.fill_amber, target_fill_amber, LIGHT_LERP);
    li.fill_pink = lerp_toward(li.fill_pink, target_fill_pink, LIGHT_LERP);
    li.fill_front = lerp_toward(li.fill_front, target_fill_front, LIGHT_LERP);
    li.point = lerp_toward(li.point, neon_target, LIGHT_LERP);

    let d_hemi = ftt(0.95, 0.0, z);
    let d_dir = ftt(1.5, 0.0, z);
    let d_amb = ftt(0.0, 1.1, z);
    let d_cam = ftt(0.0, 0.4, z);

    let (r_hemi, r_dir) = if state.active_slot.is_some() {
        (ftt(0.05, 0.0, z), ftt(0.05, 0.0, z))
    } else {
        (ftt(0.15, 0.0, z), ftt(0.25, 0.0, z))
    };

    let target_hemi = d_hemi * (1.0 - l) + r_hemi * l;
    let target_dir = d_dir * (1.0 - l) + r_dir * l;
    let target_ambient = d_amb * (1.0 - l);
    let target_cam = d_cam * (1.0 - l);

    li.hemi = lerp_toward(li.hemi, target_hemi, LIGHT_LERP);
    li.dir = lerp_toward(li.dir, target_dir, LIGHT_LERP);
    li.ambient = lerp_toward(li.ambient, target_ambient, LIGHT_LERP);
    li.cam = lerp_toward(li.cam, target_cam, LIGHT_LERP);

    let lc = &mut state.light_colors;
    lerp3_mut(&mut lc.ambient, AMBIENT_WARM, COLOR_LERP);
    lerp3_mut(&mut lc.cam, CAM_LIGHT_WARM, COLOR_LERP);
    lerp3_mut(&mut lc.point1, t_color1, POINT_COLOR_LERP);
    lerp3_mut(&mut lc.point2, t_color2, POINT_COLOR_LERP);
}

/// Web localLed1/2 fade + reposition when active card changes.
pub fn advance_local_leds(state: &mut SceneState, accent: [f32; 3]) {
    let led_target = lerp3(LED_BASE, accent, 0.15);
    lerp3_mut(&mut state.light_colors.led, led_target, LED_COLOR_LERP);

    if state.active_slot.is_some() {
        let active = state.active_slot.unwrap();
        if state.led_card_slot != Some(active) {
            state.local_led1_int += (0.0 - state.local_led1_int) * 0.2;
            state.local_led2_int += (0.0 - state.local_led2_int) * 0.2;
            if state.local_led1_int < 0.05 {
                state.led_card_slot = Some(active);
                state.local_led1_int = 0.0;
                state.local_led2_int = 0.0;
            }
        } else {
            state.local_led1_int += (5.0 - state.local_led1_int) * 0.1;
            state.local_led2_int += (5.0 - state.local_led2_int) * 0.1;
        }
    } else {
        state.local_led1_int += -state.local_led1_int * 0.1;
        state.local_led2_int += -state.local_led2_int * 0.1;
        if state.local_led1_int < 0.05 {
            state.led_card_slot = None;
        }
    }
}
