//! Spotify iOS SDK bridge — stub API matching `spotify.tish` exports.
//!
//! Real implementation will wire Spotify iOS SDK + Keychain token storage.

use std::sync::Arc;

use tishlang_core::{ObjectMap, Value};

fn noop(_: &[Value]) -> Value {
    Value::Null
}

fn bool_false(_: &[Value]) -> Value {
    Value::Bool(false)
}

fn empty_str(_: &[Value]) -> Value {
    Value::String("".into())
}

fn stub_native(name: &str) -> Value {
    let label = name.to_string();
    Value::native(move |_args: &[Value]| {
        eprintln!("tish-spotify-ios: {label} is not implemented yet");
        Value::Null
    })
}

/// Module object: `import { login, play } from "tish:spotify-ios"`.
pub fn spotify_ios_object() -> Value {
    let mut m = ObjectMap::default();
    m.insert(Arc::from("getStoredClientId"), Value::native(empty_str));
    m.insert(Arc::from("getBootClientId"), Value::native(empty_str));
    m.insert(Arc::from("setStoredClientId"), Value::native(noop));
    m.insert(Arc::from("isLoggedIn"), Value::native(bool_false));
    for export in [
        "login",
        "consumeState",
        "logout",
        "exchangeCode",
        "spotifyApi",
        "loadAllTracks",
        "getUserPlaylists",
        "getSelectedPlaylists",
        "saveSelectedPlaylists",
        "getCachedTracks",
        "setCachedTracks",
        "clearTracksCache",
        "getCachedPlaylistIds",
        "setShuffle",
        "addToQueue",
        "getDevices",
        "transferPlayback",
        "play",
        "nowPlaying",
    ] {
        m.insert(Arc::from(export), stub_native(export));
    }
    Value::object(m)
}
