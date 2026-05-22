//! CAMetalLayer + CADisplayLink host for the jukebox drum preview.

use std::cell::RefCell;
use std::f32::consts::PI;
use std::sync::{Arc, Mutex};

use metal::{foreign_types::ForeignTypeRef, MetalLayerRef};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_core_foundation::{CGRect, CGPoint, CGSize};
use objc2_foundation::{NSDefaultRunLoopMode, NSObject, NSObjectProtocol, NSRunLoop, NSRunLoopCommonModes, NSSet};
use objc2_metal::MTLCreateSystemDefaultDevice;
use objc2_metal::MTLPixelFormat;
use objc2_quartz_core::{CACurrentMediaTime, CADisplayLink, CAMetalLayer};
use objc2_ui_kit::{UIColor, UIEvent, UITouch, UIView, UIViewAutoresizing};

use tish_apple_common::scene_host::register_scene_view_factory;
use tishlang_core::ObjectMap;

use crate::audio::{play_selection_sound, set_audio_enabled};
use crate::hit_test::{go_to_card_angle, pick_card_at_point, PickCamera};
use crate::renderer::{DrumRenderer, DragAxis, SceneState};
use crate::scene_data::{parse_scene, queue_words_for_slots, scene_fingerprint, PreparedScene};

const TAP_DRAG_THRESHOLD: f32 = 8.0;
const ZOOM_AUTO_THRESHOLD: f32 = 0.5;
const LONG_PRESS_SECONDS: f64 = 0.35;
const DOUBLE_TAP_MS: f64 = 0.35;

thread_local! {
    static CACHED_SCENE_VIEW: RefCell<Option<Retained<JukeSceneHostView>>> = RefCell::new(None);
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

fn pick_camera(state: &Arc<Mutex<SceneState>>) -> PickCamera {
    let s = state.lock().unwrap();
    PickCamera {
        angle: s.angle,
        zoom: s.zoom,
        zoom_tight: s.zoom_tight,
        zoom_flat: s.zoom_flat,
    }
}

fn begin_touch(state: &Arc<Mutex<SceneState>>) {
    let mut s = state.lock().unwrap();
    s.touch_active = true;
    s.press_started_at = Some(CACurrentMediaTime());
    s.angle_target = None;
    s.zoom_target = None;
    s.drag_velocity = 0.0;
    s.drag_axis = DragAxis::None;
}

fn end_touch(state: &Arc<Mutex<SceneState>>) {
    let mut s = state.lock().unwrap();
    s.touch_active = false;
    s.press_started_at = None;
}

fn pick_surface(view: &JukeSceneHostView, tap_x: f32, tap_y: f32) -> (f32, f32, f32, f32) {
    let scale = view.contentScaleFactor().max(1.0) as f32;
    let bounds = view.bounds();
    let w = bounds.size.width as f32 * scale;
    let h = bounds.size.height as f32 * scale;
    (tap_x * scale, tap_y * scale, w.max(1.0), h.max(1.0))
}

fn bool_prop(props: Option<&ObjectMap>, key: &str, default: bool) -> bool {
    props
        .and_then(|p| p.get(key))
        .map(|v| match v {
            tishlang_core::Value::Bool(b) => *b,
            tishlang_core::Value::Number(n) => *n != 0.0,
            _ => default,
        })
        .unwrap_or(default)
}

fn f32_prop(props: Option<&ObjectMap>, key: &str, default: f32) -> f32 {
    props
        .and_then(|p| p.get(key))
        .and_then(|v| v.as_number())
        .map(|n| n as f32)
        .unwrap_or(default)
}

fn toggle_queue_bit(mask: &mut Vec<u32>, slot: usize) {
    let word = slot / 32;
    let bit = slot % 32;
    while mask.len() <= word {
        mask.push(0);
    }
    mask[word] ^= 1u32 << bit;
}

fn queue_count(mask: &[u32]) -> u32 {
    mask.iter().map(|w| w.count_ones()).sum()
}

fn clear_queue_bit(mask: &mut Vec<u32>, slot: usize) {
    let word = slot / 32;
    let bit = slot % 32;
    if word < mask.len() {
        mask[word] &= !(1u32 << bit);
    }
}

pub struct PanIvars {
    pub state: Arc<Mutex<SceneState>>,
    pub prepared: RefCell<Option<PreparedScene>>,
    pub long_press_fired: RefCell<bool>,
    pub drag_occurred: RefCell<bool>,
    pub touch_start: RefCell<(f32, f32)>,
    pub drag_axis: RefCell<DragAxis>,
    pub last_tap_at: RefCell<f64>,
    pub pinch_start_dist: RefCell<Option<f32>>,
    pub view: RefCell<Option<Retained<JukeSceneHostView>>>,
}

struct SceneHost {
    state: Arc<Mutex<SceneState>>,
    prepared: Option<PreparedScene>,
    scene_fingerprint: u64,
    renderer: RefCell<Option<DrumRenderer>>,
    renderer_failed: RefCell<bool>,
    metal_layer: Retained<CAMetalLayer>,
}

pub struct HostIvars {
    pub metal_layer: Retained<CAMetalLayer>,
    host: RefCell<Option<SceneHost>>,
    display_link: RefCell<Option<Retained<CADisplayLink>>>,
    pan_target: Retained<JukeScenePanTarget>,
}

define_class!(
    #[unsafe(super(UIView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = HostIvars]
    #[name = "JukeSceneHostView"]
    pub struct JukeSceneHostView;

    unsafe impl NSObjectProtocol for JukeSceneHostView {}

    impl JukeSceneHostView {
        #[unsafe(method(layoutSubviews))]
        fn layout_subviews(&self) {
            unsafe {
                let _: () = msg_send![super(self), layoutSubviews];
            }
            layout_metal_layer(self);
        }

        #[unsafe(method(displayLinkTick:))]
        fn display_link_tick(&self, _link: Option<&AnyObject>) {
            let Some(mut host) = self.ivars().host.borrow_mut().take() else {
                return;
            };
            host.draw_frame();
            *self.ivars().host.borrow_mut() = Some(host);
            self.ivars().pan_target.check_long_press();
        }

        #[unsafe(method(touchesBegan:withEvent:))]
        fn touches_began(&self, touches: &NSSet<UITouch>, event: Option<&UIEvent>) {
            if let Some(ev) = event {
                if let Some(all) = ev.allTouches() {
                    if all.count() >= 2 {
                        self.ivars().pan_target.on_pinch_began(&all);
                        return;
                    }
                }
            }
            if touches.count() > 1 {
                return;
            }
            let Some((x, y)) = touch_point(touches, self) else {
                return;
            };
            self.ivars().pan_target.on_touch_began(x, y);
        }

        #[unsafe(method(touchesMoved:withEvent:))]
        fn touches_moved(&self, touches: &NSSet<UITouch>, event: Option<&UIEvent>) {
            if let Some(ev) = event {
                if let Some(all) = ev.allTouches() {
                    if all.count() >= 2 {
                        self.ivars().pan_target.on_pinch_moved(&all);
                        return;
                    }
                }
            }
            if touches.count() > 1 {
                return;
            }
            let Some((x, y)) = touch_point(touches, self) else {
                return;
            };
            self.ivars().pan_target.on_touch_moved(x, y);
        }

        #[unsafe(method(touchesEnded:withEvent:))]
        fn touches_ended(&self, touches: &NSSet<UITouch>, event: Option<&UIEvent>) {
            if let Some(ev) = event {
                if let Some(all) = ev.allTouches() {
                    if all.count() >= 2 {
                        self.ivars().pan_target.on_pinch_ended();
                        return;
                    }
                }
            }
            if touches.count() > 1 {
                self.ivars().pan_target.on_touch_ended();
                return;
            }
            let Some((x, y)) = touch_point(touches, self) else {
                self.ivars().pan_target.on_touch_ended();
                return;
            };
            self.ivars().pan_target.on_touch_ended_at(x, y);
        }

        #[unsafe(method(touchesCancelled:withEvent:))]
        fn touches_cancelled(&self, touches: &NSSet<UITouch>, _event: Option<&UIEvent>) {
            let _ = touches;
            self.ivars().pan_target.on_pinch_ended();
            self.ivars().pan_target.on_touch_ended();
        }
    }
);

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = PanIvars]
    #[name = "JukeScenePanTarget"]
    pub struct JukeScenePanTarget;

    unsafe impl NSObjectProtocol for JukeScenePanTarget {}
);

fn touch_point(touches: &NSSet<UITouch>, view: &JukeSceneHostView) -> Option<(f32, f32)> {
    let touch = touches.anyObject()?;
    let loc = touch.locationInView(Some(view));
    Some((loc.x as f32, loc.y as f32))
}

fn touch_distance(touches: &NSSet<UITouch>, view: &JukeSceneHostView) -> Option<f32> {
    if touches.count() < 2 {
        return None;
    }
    let objs = touches.allObjects();
    if objs.count() < 2 {
        return None;
    }
    let t0 = objs.objectAtIndex(0);
    let t1 = objs.objectAtIndex(1);
    let l0 = t0.locationInView(Some(view));
    let l1 = t1.locationInView(Some(view));
    let dx = l0.x - l1.x;
    let dy = l0.y - l1.y;
    Some(((dx * dx + dy * dy) as f32).sqrt())
}

impl JukeScenePanTarget {
    fn on_pinch_began(&self, touches: &NSSet<UITouch>) {
        if let Some(view) = self.ivars().view.borrow().clone() {
            if let Some(d) = touch_distance(touches, &view) {
                *self.ivars().pinch_start_dist.borrow_mut() = Some(d);
                end_touch(&self.ivars().state);
            }
        }
    }

    fn on_pinch_moved(&self, touches: &NSSet<UITouch>) {
        let Some(view) = self.ivars().view.borrow().clone() else {
            return;
        };
        let Some(cur) = touch_distance(touches, &view) else {
            return;
        };
        let mut start_slot = self.ivars().pinch_start_dist.borrow_mut();
        let Some(start) = *start_slot else {
            *start_slot = Some(cur);
            return;
        };
        if start < 1.0 {
            *start_slot = Some(cur);
            return;
        }
        let scale = cur / start;
        if (scale - 1.0).abs() > 0.002 {
            let state = self.ivars().state.clone();
            let mut s = state.lock().unwrap();
            s.zoom = (s.zoom + (scale - 1.0) * 0.35).clamp(0.0, 1.0);
            s.zoom_target = None;
            *start_slot = Some(cur);
        }
    }

    fn on_pinch_ended(&self) {
        *self.ivars().pinch_start_dist.borrow_mut() = None;
    }

    fn on_touch_began(&self, x: f32, y: f32) {
        *self.ivars().long_press_fired.borrow_mut() = false;
        *self.ivars().drag_occurred.borrow_mut() = false;
        *self.ivars().drag_axis.borrow_mut() = DragAxis::None;
        *self.ivars().touch_start.borrow_mut() = (x, y);
        begin_touch(&self.ivars().state);
    }

    fn on_touch_moved(&self, x: f32, y: f32) {
        if *self.ivars().drag_occurred.borrow() {
            self.apply_drag_delta(x, y);
            return;
        }
        let (sx, sy) = *self.ivars().touch_start.borrow();
        let mx = x - sx;
        let my = y - sy;
        if (mx * mx + my * my).sqrt() <= TAP_DRAG_THRESHOLD {
            return;
        }
        {
            let mut s = self.ivars().state.lock().unwrap();
            s.press_started_at = None;
        }
        *self.ivars().drag_occurred.borrow_mut() = true;
        self.apply_drag_delta(x, y);
    }

    fn apply_drag_delta(&self, x: f32, y: f32) {
        let (sx, sy) = *self.ivars().touch_start.borrow();
        let dx = x - sx;
        let dy = y - sy;
        let state = self.ivars().state.clone();
        let mut s = state.lock().unwrap();
        s.angle_target = None;
        s.zoom_target = None;
        s.angle += dx * 0.018;
        s.drag_velocity = dx * 0.09;
        s.zoom = (s.zoom - dy * 0.003).clamp(0.0, 1.0);
        *self.ivars().touch_start.borrow_mut() = (x, y);
    }

    fn on_touch_ended_at(&self, x: f32, y: f32) {
        let long_fired = *self.ivars().long_press_fired.borrow();
        let drag = *self.ivars().drag_occurred.borrow();
        if !long_fired && !drag {
            if let Some(view) = self.ivars().view.borrow().clone() {
                let (sx, sy) = *self.ivars().touch_start.borrow();
                let (px, py, vw, vh) = pick_surface(&view, sx, sy);
                if self.try_select_at(px, py, vw, vh) {
                    *self.ivars().last_tap_at.borrow_mut() = 0.0;
                } else {
                    let now = CACurrentMediaTime();
                    let last = *self.ivars().last_tap_at.borrow();
                    if now - last < DOUBLE_TAP_MS {
                        *self.ivars().last_tap_at.borrow_mut() = 0.0;
                        let state = self.ivars().state.clone();
                        let mut s = state.lock().unwrap();
                        s.zoom = if s.zoom > 0.5 { 0.0 } else { 1.0 };
                        s.zoom_target = None;
                    } else {
                        *self.ivars().last_tap_at.borrow_mut() = now;
                    }
                }
            }
        }
        let _ = (x, y);
        end_touch(&self.ivars().state);
    }

    fn on_touch_ended(&self) {
        end_touch(&self.ivars().state);
    }

    fn check_long_press(&self) {
        if *self.ivars().long_press_fired.borrow() || *self.ivars().drag_occurred.borrow() {
            return;
        }
        let state = self.ivars().state.clone();
        {
            let s = state.lock().unwrap();
            if !s.touch_active {
                return;
            }
            let Some(started) = s.press_started_at else {
                return;
            };
            if CACurrentMediaTime() - started < LONG_PRESS_SECONDS {
                return;
            }
        }
        let view_opt = self.ivars().view.borrow().clone();
        let Some(view) = view_opt else {
            return;
        };
        let (sx, sy) = *self.ivars().touch_start.borrow();
        let (px, py, vw, vh) = pick_surface(&view, sx, sy);
        *self.ivars().long_press_fired.borrow_mut() = true;
        state.lock().unwrap().press_started_at = None;
        let _ = self.try_queue_at(px, py, vw, vh);
    }

    fn try_select_at(&self, px: f32, py: f32, vw: f32, vh: f32) -> bool {
        let state = self.ivars().state.clone();
        let Some(prepared) = self.ivars().prepared.borrow().clone() else {
            return false;
        };
        let cam = pick_camera(&state);
        let Some(slot) = pick_card_at_point(&prepared, cam, px, py, vw, vh) else {
            return false;
        };
        let Some(card) = prepared.cards.iter().find(|c| c.slot_index == slot) else {
            return false;
        };
        {
            let mut s = state.lock().unwrap();
            s.active_slot = Some(slot);
            s.active_accent = card.accent;
            s.active_bg = card.bg;
            s.active_alt = card.alt;
            s.drag_velocity = 0.0;
            clear_queue_bit(&mut s.queued_mask, slot);
            if s.zoom < ZOOM_AUTO_THRESHOLD {
                s.angle_target = Some(go_to_card_angle(card.theta));
                s.zoom_target = Some(1.0);
            }
        }
        if state.lock().unwrap().audio_enabled {
            play_selection_sound();
        }
        true
    }

    fn try_queue_at(&self, px: f32, py: f32, vw: f32, vh: f32) -> bool {
        let state = self.ivars().state.clone();
        let Some(prepared) = self.ivars().prepared.borrow().clone() else {
            return false;
        };
        let cam = pick_camera(&state);
        let active = state.lock().unwrap().active_slot;
        let Some(slot) = pick_card_at_point(&prepared, cam, px, py, vw, vh) else {
            return false;
        };
        if active == Some(slot) {
            return false;
        }
        {
            let mut s = state.lock().unwrap();
            toggle_queue_bit(&mut s.queued_mask, slot);
        }
        if state.lock().unwrap().audio_enabled {
            play_selection_sound();
        }
        true
    }
}

impl SceneHost {
    fn sync_drawable_size(&self) {
        let scale = self.metal_layer.contentsScale().max(1.0);
        let frame = self.metal_layer.frame();
        self.metal_layer.setDrawableSize(CGSize {
            width: frame.size.width * scale,
            height: frame.size.height * scale,
        });
    }

    fn metal_layer_ref(&self) -> &MetalLayerRef {
        let ptr = Retained::as_ptr(&self.metal_layer) as *mut objc2::runtime::AnyObject;
        unsafe { MetalLayerRef::from_ptr(ptr as *mut _) }
    }

    fn reset_renderer(&self) {
        *self.renderer.borrow_mut() = None;
        *self.renderer_failed.borrow_mut() = false;
    }

    fn draw_frame(&mut self) {
        self.sync_drawable_size();
        {
            let mut s = self.state.lock().unwrap();
            const DT: f32 = 1.0 / 60.0;
            if let Some(target) = s.angle_target {
                let diff = shortest_angle_diff(s.angle, target);
                if diff.abs() < 0.003 {
                    s.angle = target;
                    s.angle_target = None;
                } else {
                    s.angle += diff * 0.12;
                }
                s.drag_velocity = 0.0;
            } else {
                s.angle += s.drag_velocity;
                if !s.touch_active && s.spin != 0.0 && s.cols > 0 {
                    s.angle += s.spin * (2.0 * PI / s.cols as f32) * DT;
                }
                s.drag_velocity *= 0.94;
            }
            if let Some(zt) = s.zoom_target {
                let dz = zt - s.zoom;
                if dz.abs() < 0.005 {
                    s.zoom = zt;
                    s.zoom_target = None;
                } else {
                    s.zoom += dz * 0.1;
                }
            }
        }
        let layer = self.metal_layer_ref();
        let size = layer.drawable_size();
        if size.width < 1.0 || size.height < 1.0 {
            return;
        }
        let Some(drawable) = layer.next_drawable() else {
            return;
        };
        if self.renderer.borrow().is_none() && !*self.renderer_failed.borrow() {
            let created = DrumRenderer::new(self.state.clone(), self.prepared.as_ref());
            if created.is_none() {
                *self.renderer_failed.borrow_mut() = true;
            }
            *self.renderer.borrow_mut() = created;
        }
        {
            let mut slot = self.renderer.borrow_mut();
            let Some(renderer) = slot.as_mut() else {
                return;
            };
            renderer.draw(drawable, size.width as f32, size.height as f32);
        }
    }
}

fn layout_metal_layer(view: &JukeSceneHostView) {
    let bounds = view.bounds();
    let scale = view.contentScaleFactor().max(1.0);
    let layer = &view.ivars().metal_layer;
    layer.setFrame(CGRect::new(
        CGPoint::new(0.0, 0.0),
        CGSize {
            width: bounds.size.width,
            height: bounds.size.height,
        },
    ));
    layer.setContentsScale(scale);
    layer.setDrawableSize(CGSize {
        width: bounds.size.width * scale,
        height: bounds.size.height * scale,
    });
}

fn make_initial_state(
    prepared: Option<&PreparedScene>,
    spin: f32,
    props: Option<&ObjectMap>,
) -> SceneState {
    let cols = prepared.map(|p| p.layout.cols).unwrap_or(1);
    let total_slots = prepared
        .map(|p| p.layout.total_slots.max(p.cards.len() as u32))
        .unwrap_or(1);
    let words = queue_words_for_slots(total_slots);
    let init_angle = prepared
        .and_then(|p| p.cards.iter().find(|c| !c.empty))
        .map(|c| PI - c.theta)
        .unwrap_or(0.0);
    SceneState {
        angle: init_angle,
        drag_velocity: 0.0,
        spin,
        cols,
        zoom: 0.0,
        lighting: f32_prop(props, "lighting", 0.5),
        zoom_tight: f32_prop(props, "zoomTight", 0.95),
        zoom_flat: f32_prop(props, "zoomFlat", 0.0),
        show_categories: bool_prop(props, "showCategories", true),
        audio_enabled: bool_prop(props, "audioEnabled", true),
        active_slot: None,
        angle_target: None,
        zoom_target: None,
        queued_mask: vec![0; words],
        total_slots,
        touch_active: false,
        press_started_at: None,
        drag_axis: DragAxis::None,
        time: 0.0,
        active_accent: [0.0, 0.95, 1.0],
        active_bg: [0.1, 0.1, 0.15],
        active_alt: [1.0, 0.5, 0.2],
        height_total: prepared.map(|p| p.layout.height_total).unwrap_or(2.1),
        radius: prepared.map(|p| p.layout.radius).unwrap_or(1.35),
    }
}

fn apply_scene_props(view: &JukeSceneHostView, props: Option<&ObjectMap>, width: f64, height: f64) {
    let prepared = props
        .and_then(|p| p.get("scene"))
        .and_then(|scene| parse_scene(scene));
    let spin = f32_prop(props, "spin", 0.0);

    let frame = CGRect::new(
        CGPoint::new(0.0, 0.0),
        CGSize {
            width: width.max(1.0),
            height: height.max(1.0),
        },
    );
    view.setFrame(frame);
    layout_metal_layer(view);

    *view.ivars().pan_target.ivars().prepared.borrow_mut() = prepared.clone();

    {
        let mut host_slot = view.ivars().host.borrow_mut();
        let Some(host) = host_slot.as_mut() else {
            return;
        };

        let old_fp = host.scene_fingerprint;
        let new_fp = prepared.as_ref().map(scene_fingerprint).unwrap_or(0);
        let scene_changed = new_fp != old_fp;

        host.prepared = prepared.clone();
        host.scene_fingerprint = new_fp;
        if scene_changed {
            host.reset_renderer();
            let mut s = make_initial_state(host.prepared.as_ref(), spin, props);
            let prev = host.state.lock().unwrap();
            s.lighting = prev.lighting;
            drop(prev);
            *host.state.lock().unwrap() = s;
        } else if prepared.is_some() && host.prepared.is_none() {
            // Scene arrived after mount (incremental prepare) — rebuild renderer/state.
            host.reset_renderer();
            *host.state.lock().unwrap() = make_initial_state(host.prepared.as_ref(), spin, props);
        }
        {
            let mut s = host.state.lock().unwrap();
            if (spin - s.spin).abs() > f32::EPSILON {
                s.angle_target = None;
                s.drag_velocity = 0.0;
            }
            s.spin = spin;
            if let Some(p) = props {
                s.zoom_tight = f32_prop(props, "zoomTight", s.zoom_tight);
                s.zoom_flat = f32_prop(props, "zoomFlat", s.zoom_flat);
                s.show_categories = bool_prop(props, "showCategories", s.show_categories);
                s.audio_enabled = bool_prop(props, "audioEnabled", s.audio_enabled);
            }
            if let Some(p) = host.prepared.as_ref() {
                s.height_total = p.layout.height_total;
                s.radius = p.layout.radius;
                s.total_slots = p.layout.total_slots.max(p.cards.len() as u32);
                let words = queue_words_for_slots(s.total_slots);
                s.queued_mask.resize(words, 0);
            }
            set_audio_enabled(s.audio_enabled);
        }
    }
}

fn start_display_link(_mtm: MainThreadMarker, view: &JukeSceneHostView) {
    if view.ivars().display_link.borrow().is_some() {
        return;
    }
    let link = unsafe {
        CADisplayLink::displayLinkWithTarget_selector(view, sel!(displayLinkTick:))
    };
    unsafe {
        link.addToRunLoop_forMode(&NSRunLoop::mainRunLoop(), &NSDefaultRunLoopMode);
        link.addToRunLoop_forMode(&NSRunLoop::mainRunLoop(), &NSRunLoopCommonModes);
    }
    *view.ivars().display_link.borrow_mut() = Some(link);
}

fn create_scene_host_view(
    mtm: MainThreadMarker,
    width: f64,
    height: f64,
    props: Option<&ObjectMap>,
) -> Option<Retained<UIView>> {
    if let Some(cached) = CACHED_SCENE_VIEW.with(|slot| slot.borrow().clone()) {
        apply_scene_props(&cached, props, width, height);
        return Some(cached.into_super());
    }

    let prepared = props
        .and_then(|p| p.get("scene"))
        .and_then(|scene| parse_scene(scene));
    let spin = f32_prop(props, "spin", 0.0);
    let prepared_for_pan = prepared.clone();
    let prepared_fp = prepared.as_ref().map(scene_fingerprint).unwrap_or(0);

    let state = Arc::new(Mutex::new(make_initial_state(
        prepared.as_ref(),
        spin,
        props,
    )));
    set_audio_enabled(state.lock().unwrap().audio_enabled);

    let metal_layer = CAMetalLayer::new();
    if let Some(device) = MTLCreateSystemDefaultDevice() {
        metal_layer.setDevice(Some(&device));
    }
    metal_layer.setPixelFormat(MTLPixelFormat::BGRA8Unorm);
    metal_layer.setFramebufferOnly(true);

    let pan_target: Retained<JukeScenePanTarget> = unsafe {
        let allocated = JukeScenePanTarget::alloc(mtm);
        let partial = allocated.set_ivars(PanIvars {
            state: state.clone(),
            prepared: RefCell::new(prepared_for_pan),
            long_press_fired: RefCell::new(false),
            drag_occurred: RefCell::new(false),
            touch_start: RefCell::new((0.0, 0.0)),
            drag_axis: RefCell::new(DragAxis::None),
            last_tap_at: RefCell::new(0.0),
            pinch_start_dist: RefCell::new(None),
            view: RefCell::new(None),
        });
        msg_send![super(partial), init]
    };

    let view: Retained<JukeSceneHostView> = unsafe {
        let allocated = JukeSceneHostView::alloc(mtm);
        let partial = allocated.set_ivars(HostIvars {
            metal_layer: metal_layer.clone(),
            host: RefCell::new(None),
            display_link: RefCell::new(None),
            pan_target: pan_target.clone(),
        });
        msg_send![super(partial), init]
    };

    *pan_target.ivars().view.borrow_mut() = Some(view.clone());

    view.setBackgroundColor(Some(&UIColor::blackColor()));
    view.setClipsToBounds(true);
    view.setUserInteractionEnabled(true);
    view.setMultipleTouchEnabled(true);
    view.setAutoresizingMask(UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight);
    view.layer().addSublayer(metal_layer.as_ref());

    let host = SceneHost {
        state: state.clone(),
        prepared,
        scene_fingerprint: prepared_fp,
        renderer: RefCell::new(None),
        renderer_failed: RefCell::new(false),
        metal_layer,
    };
    *view.ivars().host.borrow_mut() = Some(host);

    let frame = CGRect::new(
        CGPoint::new(0.0, 0.0),
        CGSize {
            width: width.max(1.0),
            height: height.max(1.0),
        },
    );
    view.setFrame(frame);
    layout_metal_layer(&view);
    start_display_link(mtm, &view);

    CACHED_SCENE_VIEW.with(|slot| {
        *slot.borrow_mut() = Some(view.clone());
    });

    Some(view.into_super())
}

pub fn install_scene_factory() {
    static INSTALLED: std::sync::Once = std::sync::Once::new();
    INSTALLED.call_once(|| {
        register_scene_view_factory(create_scene_host_view);
    });
}

pub fn active_slot_index() -> i64 {
    with_scene_state(|s| s.active_slot.map(|i| i as i64).unwrap_or(-1)).unwrap_or(-1)
}

pub fn queued_slot_count() -> i64 {
    with_scene_state(|s| queue_count(&s.queued_mask) as i64).unwrap_or(0)
}

pub fn lighting_value() -> f32 {
    with_scene_state(|s| s.lighting).unwrap_or(0.5)
}

pub fn set_lighting_value(v: f32) {
    if let Some(view) = CACHED_SCENE_VIEW.with(|slot| slot.borrow().clone()) {
        if let Some(host) = view.ivars().host.borrow().as_ref() {
            if let Ok(mut s) = host.state.lock() {
                s.lighting = v.clamp(0.0, 1.0);
            }
        }
    }
}

pub fn reset_scene_camera() {
    if let Some(view) = CACHED_SCENE_VIEW.with(|slot| slot.borrow().clone()) {
        if let Some(host) = view.ivars().host.borrow().as_ref() {
            if let Ok(mut s) = host.state.lock() {
                s.zoom = 0.0;
                s.zoom_target = None;
                s.active_slot = None;
                s.angle_target = None;
            }
        }
    }
}

fn with_scene_state<T>(f: impl FnOnce(&SceneState) -> T) -> Option<T> {
    CACHED_SCENE_VIEW.with(|slot| {
        slot.borrow().as_ref().and_then(|view| {
            view.ivars()
                .host
                .borrow()
                .as_ref()
                .and_then(|host| host.state.lock().ok().map(|s| f(&s)))
        })
    })
}
