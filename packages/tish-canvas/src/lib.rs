//! Native `document` / canvas shim for Tish packages like `@spacedevin/juke-cards`.
//! Card generation logic stays in Tish — this crate only provides the DOM surface.

#[cfg(any(target_os = "ios", target_os = "macos"))]
mod canvas;
#[cfg(any(target_os = "ios", target_os = "macos"))]
mod fonts_api;
#[cfg(any(target_os = "ios", target_os = "macos"))]
mod text;

use std::sync::Arc;

use tishlang_core::{ObjectMap, Value};

#[cfg(any(target_os = "ios", target_os = "macos"))]
pub fn install_canvas_provider() {
    static INSTALLED: std::sync::Once = std::sync::Once::new();
    INSTALLED.call_once(|| {
        tish_apple_common::canvas::register_canvas_rgba(canvas::canvas_rgba_bytes);
    });
}

/// Browser-style `document` global for native builds (injected by tish_compile).
#[cfg(any(target_os = "ios", target_os = "macos"))]
pub fn document_value() -> Value {
    install_canvas_provider();
    canvas::document_value()
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
pub fn canvas_object() -> Value {
    install_canvas_provider();
    let get_document = Value::native(|_args: &[Value]| canvas::document_value());
    let mut m = ObjectMap::default();
    m.insert(Arc::from("getDocument"), get_document);
    Value::object(m)
}

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
pub fn canvas_object() -> Value {
    let get_document = Value::native(|_args: &[Value]| {
        eprintln!("tish-canvas: getDocument is only available on Apple platforms");
        Value::Null
    });
    let mut m = ObjectMap::default();
    m.insert(Arc::from("getDocument"), get_document);
    Value::object(m)
}
