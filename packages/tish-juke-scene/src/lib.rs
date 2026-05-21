//! Metal jukebox scene — placeholder until MTKView renderer lands.

use std::sync::Arc;

use tishlang_core::{ObjectMap, Value};

/// Host props for `<SceneView />` in tish-ios (future: Metal-backed view).
pub fn juke_scene_object() -> Value {
    let create = Value::native(|_args: &[Value]| {
        eprintln!("tish-juke-scene: createSceneView stub");
        Value::Null
    });
    let mut m = ObjectMap::default();
    m.insert(Arc::from("createSceneView"), create);
    m.insert(
        Arc::from("version"),
        Value::String("0.1.0-stub".into()),
    );
    Value::object(m)
}
