//! Metal jukebox scene — drum preview + optional card instances for `<SceneView />`.

use std::sync::Arc;

use tishlang_core::{ObjectMap, Value};

#[cfg(target_os = "ios")]
mod hit_test;
#[cfg(target_os = "ios")]
mod renderer;
#[cfg(target_os = "ios")]
mod scene_data;
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

    let create = Value::native(|_args: &[Value]| {
        // Scene views are created by the UIKit host via the registered factory.
        Value::Null
    });

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

    let mut m = ObjectMap::default();
    m.insert(Arc::from("createSceneView"), create);
    m.insert(Arc::from("debugSceneParse"), debug_parse);
    m.insert(
        Arc::from("version"),
        Value::String("0.3.0-scene-port".into()),
    );
    Value::object(m)
}
