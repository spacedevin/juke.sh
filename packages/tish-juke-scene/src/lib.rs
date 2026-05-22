//! Metal jukebox scene — drum preview + optional card instances for `<SceneView />`.

use std::sync::Arc;

use tishlang_core::{ObjectMap, Value};

#[cfg(target_os = "ios")]
mod audio;
#[cfg(target_os = "ios")]
mod camera;
#[cfg(target_os = "ios")]
mod hit_test;
#[cfg(target_os = "ios")]
mod renderer;
#[cfg(target_os = "ios")]
mod scene_data;
#[cfg(target_os = "ios")]
mod scene_events;
#[cfg(target_os = "ios")]
mod view;

#[cfg(target_os = "ios")]
fn ensure_factory() {
    view::install_scene_factory();
}

#[cfg(not(target_os = "ios"))]
fn ensure_factory() {}

/// Native module: `import { createSceneView, version } from "tish:juke-scene"`.
pub fn juke_scene_object() -> Value {
    ensure_factory();

    let create = Value::native(|_args: &[Value]| Value::Null);

    let debug_parse = Value::native(|args: &[Value]| {
        #[cfg(target_os = "ios")]
        {
            let scene = args.first().cloned().unwrap_or(Value::Null);
            return Value::String(scene_data::debug_scene_parse(&scene).into());
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = args;
            Value::String("ios only".into())
        }
    });

    let get_active_index = Value::native(|_args: &[Value]| {
        #[cfg(target_os = "ios")]
        {
            return Value::Number(view::active_slot_index() as f64);
        }
        #[cfg(not(target_os = "ios"))]
        {
            Value::Number(-1.0)
        }
    });

    let get_active_uri = Value::native(|_args: &[Value]| {
        #[cfg(target_os = "ios")]
        {
            return Value::String(view::active_uri_value().into());
        }
        #[cfg(not(target_os = "ios"))]
        {
            Value::String(String::new().into())
        }
    });

    let get_active_title = Value::native(|_args: &[Value]| {
        #[cfg(target_os = "ios")]
        {
            return Value::String(view::active_title_value().into());
        }
        #[cfg(not(target_os = "ios"))]
        {
            Value::String(String::new().into())
        }
    });

    let get_queued_count = Value::native(|_args: &[Value]| {
        #[cfg(target_os = "ios")]
        {
            return Value::Number(view::queued_slot_count() as f64);
        }
        #[cfg(not(target_os = "ios"))]
        {
            Value::Number(0.0)
        }
    });

    let get_lighting = Value::native(|_args: &[Value]| {
        #[cfg(target_os = "ios")]
        {
            return Value::Number(view::lighting_value() as f64);
        }
        #[cfg(not(target_os = "ios"))]
        {
            Value::Number(0.5)
        }
    });

    let set_lighting = Value::native(|args: &[Value]| {
        #[cfg(target_os = "ios")]
        {
            let v = args.first().and_then(|v| v.as_number()).unwrap_or(0.5) as f32;
            view::set_lighting_value(v);
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = args;
        }
        Value::Null
    });

    let reset_scene_camera = Value::native(|_args: &[Value]| {
        #[cfg(target_os = "ios")]
        {
            view::reset_scene_camera();
        }
        Value::Null
    });

    let mut m = ObjectMap::default();
    m.insert(Arc::from("createSceneView"), create);
    m.insert(Arc::from("debugSceneParse"), debug_parse);
    m.insert(Arc::from("getActiveIndex"), get_active_index);
    m.insert(Arc::from("getActiveUri"), get_active_uri);
    m.insert(Arc::from("getActiveTitle"), get_active_title);
    m.insert(Arc::from("getQueuedCount"), get_queued_count);
    m.insert(Arc::from("getLighting"), get_lighting);
    m.insert(Arc::from("setLighting"), set_lighting);
    m.insert(Arc::from("resetSceneCamera"), reset_scene_camera);
    m.insert(
        Arc::from("version"),
        Value::String("0.5.0-scene-port".into()),
    );
    Value::object(m)
}
