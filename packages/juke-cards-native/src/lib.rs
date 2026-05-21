//! Native card art generation — stub until CoreGraphics port of `generate.tish`.

use std::sync::Arc;

use tishlang_core::{ObjectMap, Value};

pub fn juke_cards_native_object() -> Value {
    let generate = Value::native(|_args: &[Value]| {
        eprintln!("juke-cards-native: generateCardArt stub");
        Value::Null
    });
    let mut m = ObjectMap::default();
    m.insert(Arc::from("generateCardArt"), generate);
    Value::object(m)
}
