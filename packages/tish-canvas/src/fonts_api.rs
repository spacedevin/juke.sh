//! `document.fonts` — mirrors the browser FontFaceSet enough for juke-cards preload.

use std::sync::Arc;

use tishlang_core::{ObjectMap, Value};

use crate::text;

pub fn fonts_object() -> Value {
    let load = Value::native(|args: &[Value]| {
        let spec = args
            .first()
            .map(|v| v.to_display_string())
            .unwrap_or_default();
        text::load_font_spec(&spec);
        Value::Null
    });
    let mut m = ObjectMap::default();
    m.insert(Arc::from("load"), load);
    Value::object(m)
}
