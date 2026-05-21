//! Metal jukebox scene — MTKView drum preview for `<SceneView />`.

use std::sync::Arc;

use tishlang_core::{ObjectMap, Value};

#[cfg(target_os = "ios")]
mod renderer;
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
    let mut m = ObjectMap::default();
    m.insert(Arc::from("createSceneView"), create);
    m.insert(
        Arc::from("version"),
        Value::String("0.1.0-metal-preview".into()),
    );
    Value::object(m)
}
