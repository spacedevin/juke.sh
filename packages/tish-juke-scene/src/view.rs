//! CAMetalLayer + CADisplayLink host for the jukebox drum preview.

use std::cell::RefCell;
use std::f32::consts::PI;
use std::sync::{Arc, Mutex};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use metal::{foreign_types::ForeignTypeRef, MetalLayerRef};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_core_foundation::{CGRect, CGPoint, CGSize};
use objc2_foundation::{NSDefaultRunLoopMode, NSObject, NSObjectProtocol, NSRunLoop, NSRunLoopCommonModes};
use objc2_metal::MTLCreateSystemDefaultDevice;
use objc2_metal::MTLPixelFormat;
use objc2_quartz_core::{CADisplayLink, CAMetalLayer};
use objc2_ui_kit::{
    UIColor, UIGestureRecognizerState, UILongPressGestureRecognizer, UIPanGestureRecognizer,
    UITapGestureRecognizer, UIView, UIViewAutoresizing,
};

use tish_apple_common::scene_host::register_scene_view_factory;
use tishlang_core::{ObjectMap, Value};

use crate::hit_test::{go_to_card_angle, pick_card_at_point};
use crate::renderer::{DrumRenderer, SceneState};
use crate::scene_data::{parse_scene, PreparedScene};

const TAP_DRAG_THRESHOLD: f32 = 24.0;
const ZOOM_AUTO_THRESHOLD: f32 = 0.5;
const LONG_PRESS_SECONDS: f64 = 0.35;

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

fn dispatch_value_callback(callback: Value, args: Vec<Value>) {
    let Value::Function(f) = callback else {
        return;
    };
    let block = RcBlock::new(move || {
        let _ = f(&args);
    });
    unsafe {
        DispatchQueue::main().exec_async_with_block(RcBlock::as_ptr(&block).cast());
    }
}

fn parse_queued_bits(props: Option<&ObjectMap>) -> u64 {
    let Some(p) = props else {
        return 0;
    };
    let Some(v) = p
        .get("queued")
        .or_else(|| p.get("queuedIndices"))
        .or_else(|| p.get("queuedindices"))
    else {
        return 0;
    };
    match v {
        Value::Number(n) => *n as u64,
        Value::Array(arr) => {
            let a = arr.borrow();
            let mut bits = 0u64;
            for item in a.iter() {
                if let Some(idx) = item.as_number() {
                    let i = idx as u32;
                    if i < 64 {
                        bits |= 1u64 << i;
                    }
                }
            }
            bits
        }
        _ => 0,
    }
}

fn pick_angle_zoom(state: &Arc<Mutex<SceneState>>) -> (f32, f32) {
    let s = state.lock().unwrap();
    (s.angle, s.zoom)
}

fn begin_touch(state: &Arc<Mutex<SceneState>>) {
    let mut s = state.lock().unwrap();
    s.touch_active = true;
    s.angle_target = None;
    s.zoom_target = None;
    s.drag_velocity = 0.0;
}

fn end_touch(state: &Arc<Mutex<SceneState>>) {
    let mut s = state.lock().unwrap();
    s.touch_active = false;
}

fn select_card_at(
    state: &Arc<Mutex<SceneState>>,
    prepared: &PreparedScene,
    on_select: &Option<Value>,
    tap_x: f32,
    tap_y: f32,
    view_w: f32,
    view_h: f32,
) {
    let (angle, zoom) = pick_angle_zoom(state);
    let Some(idx) = pick_card_at_point(prepared, angle, zoom, tap_x, tap_y, view_w, view_h) else {
        return;
    };
    let Some(card) = prepared.cards.iter().find(|c| c.index == idx) else {
        return;
    };
    {
        let mut s = state.lock().unwrap();
        s.active_index = Some(idx);
        s.angle_target = Some(go_to_card_angle(card.theta));
        s.drag_velocity = 0.0;
        if s.zoom < ZOOM_AUTO_THRESHOLD {
            s.zoom_target = Some(1.0);
        }
    }
    if let Some(cb) = on_select.clone() {
        dispatch_value_callback(cb, vec![Value::Number(idx as f64)]);
    }
}

fn queue_card_at(
    state: &Arc<Mutex<SceneState>>,
    prepared: &PreparedScene,
    on_queue: &Option<Value>,
    tap_x: f32,
    tap_y: f32,
    view_w: f32,
    view_h: f32,
) {
    let (angle, zoom) = pick_angle_zoom(state);
    let active = state.lock().unwrap().active_index;
    let Some(idx) = pick_card_at_point(prepared, angle, zoom, tap_x, tap_y, view_w, view_h) else {
        return;
    };
    if active == Some(idx) {
        return;
    }
    if let Some(cb) = on_queue.clone() {
        dispatch_value_callback(cb, vec![Value::Number(idx as f64)]);
    }
}

struct SceneHost {
    state: Arc<Mutex<SceneState>>,
    prepared: Option<PreparedScene>,
    renderer: RefCell<Option<DrumRenderer>>,
    renderer_failed: RefCell<bool>,
    metal_layer: Retained<CAMetalLayer>,
}

pub struct HostIvars {
    pub metal_layer: Retained<CAMetalLayer>,
    host: RefCell<Option<SceneHost>>,
    display_link: RefCell<Option<Retained<CADisplayLink>>>,
    pan: Retained<UIPanGestureRecognizer>,
    pan_target: Retained<JukeScenePanTarget>,
}

fn sync_metal_layer(view: &JukeSceneHostView) {
    let bounds = view.bounds();
    let scale = view.contentScaleFactor().max(1.0);
    let layer = &view.ivars().metal_layer;
    layer.setFrame(CGRect::new(
        CGPoint::new(0.0, 0.0),
        bounds.size,
    ));
    layer.setContentsScale(scale);
    layer.setDrawableSize(CGSize {
        width: bounds.size.width * scale,
        height: bounds.size.height * scale,
    });
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
            sync_metal_layer(self);
        }

        #[unsafe(method(didMoveToWindow))]
        fn did_move_to_window(&self) {
            unsafe {
                let _: () = msg_send![super(self), didMoveToWindow];
            }
            sync_metal_layer(self);
        }

        #[unsafe(method(displayLinkTick:))]
        fn display_link_tick(&self, _link: Option<&AnyObject>) {
            let Some(mut host) = self.ivars().host.borrow_mut().take() else {
                return;
            };
            host.draw_frame();
            *self.ivars().host.borrow_mut() = Some(host);
        }
    }
);

pub struct PanIvars {
    pub state: Arc<Mutex<SceneState>>,
    pub prepared: RefCell<Option<PreparedScene>>,
    pub on_select: RefCell<Option<Value>>,
    pub on_queue: RefCell<Option<Value>>,
    pub long_press_fired: RefCell<bool>,
    pub drag_occurred: RefCell<bool>,
    pub touch_start: RefCell<(f32, f32)>,
    pub view: RefCell<Option<Retained<JukeSceneHostView>>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = PanIvars]
    #[name = "JukeScenePanTarget"]
    pub struct JukeScenePanTarget;

    unsafe impl NSObjectProtocol for JukeScenePanTarget {}

    impl JukeScenePanTarget {
        #[unsafe(method(handlePan:))]
        fn handle_pan(&self, recognizer: Option<&AnyObject>) {
            let Some(rec) = recognizer else {
                return;
            };
            let Some(pan) = rec.downcast_ref::<UIPanGestureRecognizer>() else {
                return;
            };
            let state = self.ivars().state.clone();
            match pan.state() {
                UIGestureRecognizerState::Began => {
                    *self.ivars().long_press_fired.borrow_mut() = false;
                    *self.ivars().drag_occurred.borrow_mut() = false;
                    if let Some(view) = self.ivars().view.borrow().clone() {
                        let loc = pan.locationInView(Some(&*view));
                        *self.ivars().touch_start.borrow_mut() =
                            (loc.x as f32, loc.y as f32);
                    }
                    begin_touch(&state);
                }
                UIGestureRecognizerState::Changed => {
                    let view_opt = self.ivars().view.borrow().clone();
                    let Some(view) = view_opt else {
                        return;
                    };
                    let loc = pan.locationInView(Some(&*view));
                    let (sx, sy) = *self.ivars().touch_start.borrow();
                    let mx = loc.x as f32 - sx;
                    let my = loc.y as f32 - sy;
                    if (mx * mx + my * my).sqrt() <= TAP_DRAG_THRESHOLD {
                        return;
                    }
                    *self.ivars().drag_occurred.borrow_mut() = true;
                    let t = pan.translationInView(None);
                    let dx = t.x as f32;
                    let dy = t.y as f32;
                    let mut s = state.lock().unwrap();
                    s.angle_target = None;
                    s.zoom_target = None;
                    s.angle += dx * 0.018;
                    s.drag_velocity = dx * 0.09;
                    s.zoom = (s.zoom - dy * 0.003).clamp(0.0, 1.0);
                    unsafe {
                        let _: () = msg_send![
                            pan,
                            setTranslation: CGPoint::new(0.0, 0.0),
                            inView: None::<&UIView>
                        ];
                    }
                }
                UIGestureRecognizerState::Ended | UIGestureRecognizerState::Cancelled => {
                    end_touch(&state);
                }
                _ => {}
            }
        }

        #[unsafe(method(handleTap:))]
        fn handle_tap(&self, recognizer: Option<&AnyObject>) {
            let Some(rec) = recognizer else {
                return;
            };
            let Some(tap) = rec.downcast_ref::<UITapGestureRecognizer>() else {
                return;
            };
            if *self.ivars().long_press_fired.borrow() {
                *self.ivars().long_press_fired.borrow_mut() = false;
                return;
            }
            if *self.ivars().drag_occurred.borrow() {
                return;
            }
            let state = self.ivars().state.clone();
            let view_opt = self.ivars().view.borrow().clone();
            let Some(view) = view_opt else {
                return;
            };
            let Some(prepared) = self.ivars().prepared.borrow().clone() else {
                return;
            };
            let on_select = self.ivars().on_select.borrow().clone();
            let loc = tap.locationInView(Some(&*view));
            let bounds = view.bounds();
            select_card_at(
                &state,
                &prepared,
                &on_select,
                loc.x as f32,
                loc.y as f32,
                bounds.size.width as f32,
                bounds.size.height as f32,
            );
            end_touch(&state);
        }

        #[unsafe(method(handleLongPress:))]
        fn handle_long_press(&self, recognizer: Option<&AnyObject>) {
            let Some(rec) = recognizer else {
                return;
            };
            let Some(long) = rec.downcast_ref::<UILongPressGestureRecognizer>() else {
                return;
            };
            if long.state() != UIGestureRecognizerState::Began {
                return;
            }
            let state = self.ivars().state.clone();
            let view_opt = self.ivars().view.borrow().clone();
            let Some(view) = view_opt else {
                return;
            };
            let Some(prepared) = self.ivars().prepared.borrow().clone() else {
                return;
            };
            let on_queue = self.ivars().on_queue.borrow().clone();
            let (tx, ty) = *self.ivars().touch_start.borrow();
            let bounds = view.bounds();
            *self.ivars().long_press_fired.borrow_mut() = true;
            queue_card_at(
                &state,
                &prepared,
                &on_queue,
                tx,
                ty,
                bounds.size.width as f32,
                bounds.size.height as f32,
            );
        }
    }
);

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

fn apply_scene_props(view: &JukeSceneHostView, props: Option<&ObjectMap>, width: f64, height: f64) {
    let prepared = props
        .and_then(|p| p.get("scene"))
        .and_then(|scene| parse_scene(scene));
    let spin = props
        .and_then(|p| p.get("spin"))
        .and_then(|v| v.as_number())
        .unwrap_or(0.0) as f32;
    let on_select = props.and_then(|p| {
        p.get("onCardSelect")
            .or_else(|| p.get("oncardselect"))
            .cloned()
    });
    let on_queue = props.and_then(|p| {
        p.get("onCardQueue")
            .or_else(|| p.get("oncardqueue"))
            .cloned()
    });
    let queued_bits = parse_queued_bits(props);

    let frame = CGRect::new(
        CGPoint::new(0.0, 0.0),
        CGSize {
            width: width.max(1.0),
            height: height.max(1.0),
        },
    );
    view.setFrame(frame);
    sync_metal_layer(view);

    *view.ivars().pan_target.ivars().prepared.borrow_mut() = prepared.clone();
    *view.ivars().pan_target.ivars().on_select.borrow_mut() = on_select.clone();
    *view.ivars().pan_target.ivars().on_queue.borrow_mut() = on_queue.clone();

    let mut host_slot = view.ivars().host.borrow_mut();
    let Some(host) = host_slot.as_mut() else {
        return;
    };

    let old_cards = host.prepared.as_ref().map(|p| p.cards.len()).unwrap_or(0);
    let new_cards = prepared.as_ref().map(|p| p.cards.len()).unwrap_or(0);
    let scene_changed = old_cards != new_cards;

    host.prepared = prepared;
    if scene_changed {
        host.reset_renderer();
        let cols = host.prepared.as_ref().map(|p| p.layout.cols).unwrap_or(1);
        let init_angle = host
            .prepared
            .as_ref()
            .and_then(|p| p.cards.first())
            .map(|c| PI - c.theta)
            .unwrap_or(0.0);
        let mut s = host.state.lock().unwrap();
        s.angle = init_angle;
        s.drag_velocity = 0.0;
        s.cols = cols;
        s.zoom = 0.0;
        s.active_index = None;
        s.angle_target = None;
        s.zoom_target = None;
        s.queued_bits = 0;
    }
    {
        let mut s = host.state.lock().unwrap();
        s.spin = spin;
        s.queued_bits = queued_bits;
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

    let spin = props
        .and_then(|p| p.get("spin"))
        .and_then(|v| v.as_number())
        .unwrap_or(0.0) as f32;
    let cols = prepared.as_ref().map(|p| p.layout.cols).unwrap_or(1);
    let init_angle = prepared
        .as_ref()
        .and_then(|p| p.cards.first())
        .map(|c| PI - c.theta)
        .unwrap_or(0.0);
    let on_select = props.and_then(|p| {
        p.get("onCardSelect")
            .or_else(|| p.get("oncardselect"))
            .cloned()
    });
    let on_queue = props.and_then(|p| {
        p.get("onCardQueue")
            .or_else(|| p.get("oncardqueue"))
            .cloned()
    });
    let queued_bits = parse_queued_bits(props);
    let prepared_for_pan = prepared.clone();

    let state = Arc::new(Mutex::new(SceneState {
        angle: init_angle,
        drag_velocity: 0.0,
        spin,
        cols,
        zoom: 0.0,
        active_index: None,
        angle_target: None,
        zoom_target: None,
        queued_bits,
        touch_active: false,
    }));

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
            on_select: RefCell::new(on_select.clone()),
            on_queue: RefCell::new(on_queue.clone()),
            long_press_fired: RefCell::new(false),
            drag_occurred: RefCell::new(false),
            touch_start: RefCell::new((0.0, 0.0)),
            view: RefCell::new(None),
        });
        msg_send![super(partial), init]
    };

    let pan = UIPanGestureRecognizer::new(mtm);
    pan.setDelaysTouchesBegan(false);
    pan.setCancelsTouchesInView(false);
    unsafe {
        let _: () = msg_send![&*pan, addTarget: &*pan_target, action: sel!(handlePan:)];
    }

    let long_press = UILongPressGestureRecognizer::new(mtm);
    long_press.setMinimumPressDuration(LONG_PRESS_SECONDS);
    long_press.setAllowableMovement(10.0);
    unsafe {
        let _: () = msg_send![&*long_press, addTarget: &*pan_target, action: sel!(handleLongPress:)];
    }

    let tap = UITapGestureRecognizer::new(mtm);
    tap.setCancelsTouchesInView(false);
    unsafe {
        let _: () = msg_send![&*tap, addTarget: &*pan_target, action: sel!(handleTap:)];
    }

    let view: Retained<JukeSceneHostView> = unsafe {
        let allocated = JukeSceneHostView::alloc(mtm);
        let partial = allocated.set_ivars(HostIvars {
            metal_layer: metal_layer.clone(),
            host: RefCell::new(None),
            display_link: RefCell::new(None),
            pan: pan.clone(),
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
    view.addGestureRecognizer(&pan);
    view.addGestureRecognizer(&long_press);
    view.addGestureRecognizer(&tap);

    let host = SceneHost {
        state: state.clone(),
        prepared,
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
    sync_metal_layer(&view);
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
