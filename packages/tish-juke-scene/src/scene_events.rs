//! Deferred SceneView → Tish callbacks.
//!
//! UIKit touch handlers must not call Tish directly: `onSelect` / `onQueue` run
//! `setState`, which rebuilds the tree and mutates the same `RefCell` ivars
//! (`panic_already_borrowed`). macOS solves this for buttons by cloning handlers
//! before invoke; we also **defer** until the display link so touch handling finishes
//! before any Tish commit runs.

use std::cell::RefCell;

use tishlang_core::Value;
use tishlang_ui::runtime::{run_with_current_root, RootId, LEGACY_ROOT_ID};

#[derive(Clone, Copy, Debug)]
pub enum SceneEvent {
    Select(usize),
    Queue(usize),
    OpenSettings,
}

thread_local! {
    static PENDING: RefCell<Vec<SceneEvent>> = RefCell::new(Vec::new());
}

pub fn schedule_scene_event(event: SceneEvent) {
    PENDING.with(|q| q.borrow_mut().push(event));
}

fn drain_scene_events() -> Vec<SceneEvent> {
    PENDING.with(|q| std::mem::take(&mut *q.borrow_mut()))
}

fn invoke_slot(cb: &Option<Value>, slot: usize) {
    if let Some(Value::Function(f)) = cb {
        let _ = f(&[Value::Number(slot as f64)]);
    }
}

fn invoke_void(cb: &Option<Value>) {
    if let Some(Value::Function(f)) = cb {
        let _ = f(&[]);
    }
}

/// Run queued scene events. Call from `displayLinkTick`, not from touch handlers.
pub fn flush_scene_events(
    root_id: RootId,
    on_select: &Option<Value>,
    on_queue: &Option<Value>,
    on_open_settings: &Option<Value>,
) {
    let events = drain_scene_events();
    if events.is_empty() {
        return;
    }
    let on_select = on_select.clone();
    let on_queue = on_queue.clone();
    let on_open_settings = on_open_settings.clone();
    let root = if root_id == 0 { LEGACY_ROOT_ID } else { root_id };
    run_with_current_root(root, || {
        for event in events {
            match event {
                SceneEvent::Select(slot) => invoke_slot(&on_select, slot),
                SceneEvent::Queue(slot) => invoke_slot(&on_queue, slot),
                SceneEvent::OpenSettings => invoke_void(&on_open_settings),
            }
        }
    });
}
