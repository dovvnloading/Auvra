//! Standalone Windows player for games exported by Auvra.
//!
//! The exe sits next to an exported web build (index.html, assets/, game/) and serves
//! that folder to a WebView2 window through a custom protocol, so the game runs from a
//! secure origin without a local HTTP server. Browser storage (save games) lives in a
//! per-game profile under %LOCALAPPDATA%\AuvraGames\<gameId>.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::borrow::Cow;
use std::path::{Component, Path, PathBuf};

use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::{Fullscreen, WindowBuilder};
#[cfg(windows)]
use wry::WebViewBuilderExtWindows;
use wry::http::{Request, Response, StatusCode, header::CONTENT_TYPE};
use wry::{WebContext, WebViewBuilder};

const PROTOCOL: &str = "game";

struct GameInfo {
    id: String,
    name: String,
    fullscreen: bool,
}

fn content_root() -> Result<PathBuf, String> {
    let exe =
        std::env::current_exe().map_err(|error| format!("cannot locate the player: {error}"))?;
    let root = exe
        .parent()
        .ok_or("the player has no parent folder")?
        .to_path_buf();
    if !root.join("index.html").is_file() || !root.join("game").join("game.json").is_file() {
        return Err(format!(
            "No exported game was found next to the player ({}). Build the game for Windows from the Auvra editor.",
            root.display()
        ));
    }
    Ok(root)
}

fn read_game_info(root: &Path) -> Result<GameInfo, String> {
    let text = std::fs::read_to_string(root.join("game").join("game.json"))
        .map_err(|error| format!("cannot read game/game.json: {error}"))?;
    let manifest: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("game/game.json is not valid JSON: {error}"))?;
    if manifest.get("format").and_then(|value| value.as_str()) != Some("auvra.game") {
        return Err("game/game.json is not an Auvra game pack".into());
    }
    let id = manifest
        .get("gameId")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or("game/game.json has no gameId")?;
    // The profile folder name comes from the game id, so keep it to safe characters.
    let safe_id: String = id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    let name = manifest
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("Auvra Game")
        .to_string();
    let fullscreen = manifest
        .pointer("/settings/window/fullscreen")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    Ok(GameInfo {
        id: safe_id,
        name,
        fullscreen,
    })
}

fn profile_dir(game_id: &str) -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    let dir = base.join("AuvraGames").join(game_id);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("glb") => "model/gltf-binary",
        Some("gltf") => "model/gltf+json",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Maps a request path onto a file inside the content root, refusing anything that escapes it.
fn resolve(root: &Path, request_path: &str) -> Option<PathBuf> {
    let trimmed = request_path.trim_start_matches('/');
    let relative = if trimmed.is_empty() {
        "index.html"
    } else {
        trimmed
    };
    let decoded = percent_decode(relative)?;
    let candidate = Path::new(&decoded);
    if candidate
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    let full = root.join(candidate);
    full.is_file().then_some(full)
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn respond(root: &Path, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let found = resolve(root, request.uri().path())
        .and_then(|path| std::fs::read(&path).ok().map(|bytes| (path, bytes)));
    match found {
        Some((path, bytes)) => Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, mime_for(&path))
            .header("Cache-Control", "no-cache")
            .body(Cow::Owned(bytes))
            .unwrap_or_else(|_| not_found()),
        None => not_found(),
    }
}

fn not_found() -> Response<Cow<'static, [u8]>> {
    let mut response = Response::new(Cow::Borrowed(&b"Not found"[..]));
    *response.status_mut() = StatusCode::NOT_FOUND;
    response
}

fn error_page(message: &str) -> String {
    let escaped = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        "<!doctype html><meta charset=utf-8><body style=\"background:#111;color:#eee;font:14px sans-serif;padding:32px\"><h2>The game could not start</h2><p>{escaped}</p></body>"
    )
}

fn main() {
    let event_loop = EventLoop::new();
    let loaded = content_root().and_then(|root| read_game_info(&root).map(|info| (root, info)));

    let title = loaded
        .as_ref()
        .map(|(_, info)| info.name.clone())
        .unwrap_or_else(|_| "Auvra Game".into());
    let mut window_builder = WindowBuilder::new()
        .with_title(title)
        .with_inner_size(LogicalSize::new(1280.0, 720.0));
    if matches!(&loaded, Ok((_, info)) if info.fullscreen) {
        window_builder = window_builder.with_fullscreen(Some(Fullscreen::Borderless(None)));
    }
    let window = match window_builder.build(&event_loop) {
        Ok(window) => window,
        Err(error) => {
            eprintln!("cannot open the game window: {error}");
            std::process::exit(1);
        }
    };

    let mut web_context = WebContext::new(
        loaded
            .as_ref()
            .ok()
            .and_then(|(_, info)| profile_dir(&info.id)),
    );
    let builder = WebViewBuilder::new_with_web_context(&mut web_context);
    // A secure origin is needed for crypto.randomUUID and module workers.
    #[cfg(windows)]
    let builder = builder.with_https_scheme(true);
    let builder = match &loaded {
        Ok((root, _)) => {
            let root = root.clone();
            builder
                .with_custom_protocol(PROTOCOL.into(), move |_id, request| {
                    respond(&root, &request)
                })
                .with_url(format!("https://{PROTOCOL}.localhost/index.html"))
        }
        Err(message) => builder.with_html(error_page(message)),
    };
    let _webview = match builder.build(&window) {
        Ok(webview) => webview,
        Err(error) => {
            eprintln!(
                "cannot start WebView2 (is the Evergreen WebView2 Runtime installed?): {error}"
            );
            std::process::exit(1);
        }
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            *control_flow = ControlFlow::Exit;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_refuses_paths_outside_the_root() {
        let root = std::env::temp_dir().join(format!("auvra-player-test-{}", std::process::id()));
        std::fs::create_dir_all(root.join("game")).unwrap();
        std::fs::write(root.join("index.html"), "x").unwrap();
        std::fs::write(root.join("game").join("game.json"), "{}").unwrap();
        assert_eq!(resolve(&root, "/"), Some(root.join("index.html")));
        assert_eq!(
            resolve(&root, "/game/game.json"),
            Some(root.join("game").join("game.json"))
        );
        assert_eq!(resolve(&root, "/../secret.txt"), None);
        assert_eq!(resolve(&root, "/game/%2e%2e/%2e%2e/x"), None);
        assert_eq!(resolve(&root, "/missing.js"), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn mime_types_match_exported_assets() {
        assert_eq!(
            mime_for(Path::new("a.js")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(mime_for(Path::new("b.GLB")), "model/gltf-binary");
        assert_eq!(mime_for(Path::new("c.ahf")), "application/octet-stream");
    }

    #[test]
    fn game_info_requires_an_auvra_manifest() {
        let root = std::env::temp_dir().join(format!("auvra-player-info-{}", std::process::id()));
        std::fs::create_dir_all(root.join("game")).unwrap();
        std::fs::write(root.join("game").join("game.json"), r#"{"format":"other"}"#).unwrap();
        assert!(read_game_info(&root).is_err());
        std::fs::write(
            root.join("game").join("game.json"),
            r#"{"format":"auvra.game","gameId":"my game/1","name":"Demo","settings":{"window":{"fullscreen":true}}}"#,
        )
        .unwrap();
        let info = read_game_info(&root).unwrap();
        assert_eq!(info.id, "my_game_1");
        assert_eq!(info.name, "Demo");
        assert!(info.fullscreen);
        std::fs::remove_dir_all(&root).ok();
    }
}
