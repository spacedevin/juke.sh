//! CAMetalLayer + CADisplayLink host for the jukebox drum preview.

use std::cell::RefCell;
use std::f32::consts::PI;
use std::sync::{Arc, Mutex};

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
    UIColor, UIGestureRecognizerState, UIPanGestureRecognizer, UIView, UIViewAutoresizing,
};

use tish_apple_common::scene_host::register_scene_view_factory;
use tishlang_core::ObjectMap;

use crate::renderer::{DrumRenderer, SceneState};
use crate::scene_data::{parse_scene, PreparedScene};

struct SceneHost {
    state: Arc<Mutex<SceneState>>,
    prepared: Option<PreparedScene>,
    renderer: RefCell<Option<DrumRenderer>>,
    renderer_failed: RefCell<bool>,
    metal_layer: Retained<CAMetalLayer>,
}

pub struct HostIvars {
    pub metal_layer: Retained<CAMetalLayer>,
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
    }
);

pub struct TickIvars {
    host: RefCell<Option<SceneHost>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = TickIvars]
    #[name = "JukeSceneDisplayLinkTarget"]
    pub struct DisplayLinkTarget;

    unsafe impl NSObjectProtocol for DisplayLinkTarget {}

    impl DisplayLinkTarget {
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
    state: Arc<Mutex<SceneState>>,
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
            if pan.state() == UIGestureRecognizerState::Changed {
                let t = pan.translationInView(None);
                let dx = t.x as f32;
                let dy = t.y as f32;
                let mut s = self.ivars().state.lock().unwrap();
                s.angle += dx * 0.018;
                s.drag_velocity = dx * 0.09;
                s.zoom = (s.zoom - dy * 0.003).clamp(0.0, 1.0);
                unsafe {
                    let _: () = msg_send![
                        pan,
                        setTranslation: objc2_core_foundation::CGPoint::new(0.0, 0.0),
                        inView: None::<&UIView>
                    ];
                }
            }
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

    fn draw_frame(&mut self) {
        self.sync_drawable_size();
        {
            let mut s = self.state.lock().unwrap();
            const DT: f32 = 1.0 / 60.0;
            s.angle += s.drag_velocity;
            if s.spin != 0.0 && s.cols > 0 {
                s.angle += s.spin * (2.0 * PI / s.cols as f32) * DT;
            }
            s.drag_velocity *= 0.94;
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

pub fn install_scene_factory() {
    static INSTALLED: std::sync::Once = std::sync::Once::new();
    INSTALLED.call_once(|| {
        register_scene_view_factory(create_scene_host_view);
    });
}

fn create_scene_host_view(
    mtm: MainThreadMarker,
    width: f64,
    height: f64,
    props: Option<&ObjectMap>,
) -> Option<Retained<UIView>> {
    let prepared = props
        .and_then(|p| p.get("scene"))
        .and_then(|scene| parse_scene(scene));

    let spin = props
        .and_then(|p| p.get("spin"))
        .and_then(|v| v.as_number())
        .unwrap_or(0.0) as f32;
    let cols = prepared
        .as_ref()
        .map(|p| p.layout.cols)
        .unwrap_or(1);
    let init_angle = prepared
        .as_ref()
        .and_then(|p| p.cards.first())
        .map(|c| PI - c.theta)
        .unwrap_or(0.0);
    let state = Arc::new(Mutex::new(SceneState {
        angle: init_angle,
        drag_velocity: 0.0,
        spin,
        cols,
        zoom: 0.0,
    }));

    let metal_layer = CAMetalLayer::new();
    if let Some(device) = MTLCreateSystemDefaultDevice() {
        metal_layer.setDevice(Some(&device));
    }
    metal_layer.setPixelFormat(MTLPixelFormat::BGRA8Unorm);
    metal_layer.setFramebufferOnly(true);

    let view: Retained<JukeSceneHostView> = unsafe {
        let allocated = JukeSceneHostView::alloc(mtm);
        let partial = allocated.set_ivars(HostIvars {
            metal_layer: metal_layer.clone(),
        });
        msg_send![super(partial), init]
    };
    view.setBackgroundColor(Some(&UIColor::blackColor()));
    view.setClipsToBounds(true);
    view.setUserInteractionEnabled(true);
    view.setAutoresizingMask(UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight);
    view.layer().addSublayer(metal_layer.as_ref());

    let frame = CGRect::new(
        CGPoint::new(0.0, 0.0),
        CGSize {
            width: width.max(1.0),
            height: height.max(1.0),
        },
    );
    view.setFrame(frame);
    sync_metal_layer(&view);

    let host = SceneHost {
        state: state.clone(),
        prepared,
        renderer: RefCell::new(None),
        renderer_failed: RefCell::new(false),
        metal_layer,
    };

    let tick_target: Retained<DisplayLinkTarget> = unsafe {
        let allocated = DisplayLinkTarget::alloc(mtm);
        let partial = allocated.set_ivars(TickIvars {
            host: RefCell::new(Some(host)),
        });
        msg_send![super(partial), init]
    };
    let link = unsafe {
        CADisplayLink::displayLinkWithTarget_selector(&*tick_target, sel!(displayLinkTick:))
    };
    unsafe {
        link.addToRunLoop_forMode(&NSRunLoop::mainRunLoop(), &NSDefaultRunLoopMode);
        link.addToRunLoop_forMode(&NSRunLoop::mainRunLoop(), &NSRunLoopCommonModes);
    }

    let pan_target: Retained<JukeScenePanTarget> = unsafe {
        let allocated = JukeScenePanTarget::alloc(mtm);
        let partial = allocated.set_ivars(PanIvars { state });
        msg_send![super(partial), init]
    };
    let pan = UIPanGestureRecognizer::new(mtm);
    pan.setDelaysTouchesBegan(false);
    pan.setCancelsTouchesInView(false);
    unsafe {
        let _: () = msg_send![
            &*pan,
            addTarget: &*pan_target,
            action: sel!(handlePan:)
        ];
    };
    view.addGestureRecognizer(&pan);

    Some(view.into_super())
}
