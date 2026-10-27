//! Standalone desktop player for games exported by Auvra.
//!
//! The player ships with an exported web build (index.html, assets/, game/) and serves
//! that folder to the system web view through a custom protocol, so the game runs from
//! a secure origin without a local HTTP server:
//!
//! - Windows: WebView2. The build sits beside the exe, and browser storage (save games)
//!   lives in a per-game profile under %LOCALAPPDATA%\AuvraGames\<gameId>.
//! - Linux: WebKitGTK 4.1. The build sits in the `game` folder beside the executable,
//!   and storage lives under $XDG_DATA_HOME/AuvraGames/<gameId> (~/.local/share when
//!   unset).
//! - macOS: WKWebView. The build sits in the app bundle at Contents/Resources/game, and
//!   storage lives in a WebKit data store derived from the game id (macOS 14 and later;
//!   earlier versions use the app's default store).
#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

use std::borrow::Cow;
#[cfg(any(not(any(target_os = "windows", target_os = "macos")), test))]
use std::ffi::OsString;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::{Fullscreen, Window, WindowBuilder};
#[cfg(target_os = "macos")]
use wry::WebViewBuilderExtDarwin;
#[cfg(target_os = "windows")]
use wry::WebViewBuilderExtWindows;
use wry::http::header::{ACCEPT_RANGES, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use wry::http::{Request, Response, StatusCode};
use wry::{WebContext, WebView, WebViewBuilder};

const PROTOCOL: &str = "game";

/// The editor's name for the build target this player serves, used in error messages.
#[cfg(target_os = "windows")]
const PLATFORM: &str = "Windows";
#[cfg(target_os = "macos")]
const PLATFORM: &str = "macOS";
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const PLATFORM: &str = "Linux";

/// Printed with the error when the system web view cannot start.
#[cfg(target_os = "windows")]
const WEBVIEW_FAILURE: &str =
    "cannot start WebView2 (is the Evergreen WebView2 Runtime installed?)";
#[cfg(target_os = "macos")]
const WEBVIEW_FAILURE: &str = "cannot start WKWebView";
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const WEBVIEW_FAILURE: &str = "cannot start WebKitGTK (is libwebkit2gtk-4.1 installed?)";

struct GameInfo {
    id: String,
    name: String,
    fullscreen: bool,
}

fn content_root() -> Result<PathBuf, String> {
    let exe =
        std::env::current_exe().map_err(|error| format!("cannot locate the player: {error}"))?;
    let folder = exe.parent().ok_or("the player has no parent folder")?;
    let root = content_dir(folder);
    if !root.join("index.html").is_file() || !root.join("game").join("game.json").is_file() {
        let place = if root == folder {
            "next to the player"
        } else if root.parent() == Some(folder) {
            "in the game folder next to the player"
        } else {
            "in the app bundle"
        };
        return Err(format!(
            "No exported game was found {place} ({}). Build the game for {PLATFORM} from the Auvra editor.",
            root.display()
        ));
    }
    Ok(root)
}

/// The folder holding the exported web build for a player in `folder`: the folder
/// itself on Windows, else the `game` folder beside the player, or on macOS the app
/// bundle's Contents/Resources/game when the player runs from Contents/MacOS.
fn content_dir(folder: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    if let Some(game) = bundle_game_dir(folder) {
        return game;
    }
    if cfg!(target_os = "windows") {
        folder.to_path_buf()
    } else {
        folder.join("game")
    }
}

/// Contents/Resources/game of the app bundle whose Contents/MacOS is `folder`.
#[cfg(any(target_os = "macos", test))]
fn bundle_game_dir(folder: &Path) -> Option<PathBuf> {
    let contents = folder.parent()?;
    (folder.file_name()? == "MacOS" && contents.file_name()? == "Contents")
        .then(|| contents.join("Resources").join("game"))
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

/// The per-game browser profile folder, created when missing. WKWebView takes no data
/// folder, so macOS keeps storage apart with `data_store_identifier` instead.
#[cfg(not(target_os = "macos"))]
fn profile_dir(game_id: &str) -> Option<PathBuf> {
    let dir = data_home()?.join("AuvraGames").join(game_id);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

#[cfg(target_os = "windows")]
fn data_home() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn data_home() -> Option<PathBuf> {
    xdg_data_home(std::env::var_os("XDG_DATA_HOME"), std::env::var_os("HOME"))
}

/// $XDG_DATA_HOME when it is an absolute path, else ~/.local/share (XDG Base Directory).
#[cfg(any(not(any(target_os = "windows", target_os = "macos")), test))]
fn xdg_data_home(xdg_data_home: Option<OsString>, home: Option<OsString>) -> Option<PathBuf> {
    xdg_data_home
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            home.filter(|home| !home.is_empty())
                .map(|home| PathBuf::from(home).join(".local").join("share"))
        })
}

/// A stable WebKit data store identifier for a game, so every game keeps its own
/// storage across rebuilds: two FNV-1a 64-bit hashes of the game id, marked as a
/// version 8 UUID.
#[cfg(any(target_os = "macos", test))]
fn data_store_identifier(game_id: &str) -> [u8; 16] {
    let hash = |basis: u64| {
        game_id.bytes().fold(basis, |state, byte| {
            (state ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
        })
    };
    let mut identifier = [0u8; 16];
    identifier[..8].copy_from_slice(&hash(0xcbf2_9ce4_8422_2325).to_be_bytes());
    identifier[8..].copy_from_slice(&hash(0x6c62_272e_07bb_0142).to_be_bytes());
    identifier[6] = (identifier[6] & 0x0f) | 0x80;
    identifier[8] = (identifier[8] & 0x3f) | 0x80;
    identifier
}

/// The page the web view opens. WebView2 serves custom protocols as
/// `https://<scheme>.localhost`; WebKitGTK and WKWebView as `<scheme>://localhost`.
fn start_url() -> String {
    if cfg!(target_os = "windows") {
        format!("https://{PROTOCOL}.localhost/index.html")
    } else {
        format!("{PROTOCOL}://localhost/index.html")
    }
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

/// The part of a file a request's `Range` header selects.
#[derive(Debug, PartialEq)]
enum Span {
    Whole,
    /// Inclusive first and last byte offsets.
    Part(u64, u64),
    Unsatisfiable,
}

/// Reads a `Range` header for a file of `len` bytes (RFC 9110). One `bytes=` range is
/// honoured; a malformed header or a list of ranges is ignored and serves the whole
/// file. Media elements stream through ranges, which WebKit needs answered with 206.
fn requested_span(range: Option<&str>, len: u64) -> Span {
    let Some((first, last)) = range
        .and_then(|value| value.trim().strip_prefix("bytes="))
        .filter(|spec| !spec.contains(','))
        .and_then(|spec| spec.split_once('-'))
    else {
        return Span::Whole;
    };
    let (first, last) = (first.trim(), last.trim());
    if first.is_empty() {
        // A suffix range: the final `last` bytes.
        return match last.parse::<u64>() {
            Ok(suffix) if suffix > 0 && len > 0 => Span::Part(len.saturating_sub(suffix), len - 1),
            Ok(_) => Span::Unsatisfiable,
            Err(_) => Span::Whole,
        };
    }
    let Ok(start) = first.parse::<u64>() else {
        return Span::Whole;
    };
    let end = if last.is_empty() {
        u64::MAX
    } else {
        match last.parse::<u64>() {
            Ok(end) if end >= start => end,
            _ => return Span::Whole,
        }
    };
    if start >= len {
        Span::Unsatisfiable
    } else {
        Span::Part(start, end.min(len - 1))
    }
}

/// Serves `path`, or the part of it `range` selects; `None` when it cannot be read.
fn read_span(path: &Path, range: Option<&str>) -> Option<Response<Cow<'static, [u8]>>> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let builder = Response::builder()
        .header(CONTENT_TYPE, mime_for(path))
        .header(ACCEPT_RANGES, "bytes")
        .header("Cache-Control", "no-cache");
    let response = match requested_span(range, len) {
        Span::Whole => {
            let mut bytes = Vec::with_capacity(usize::try_from(len).ok()?);
            file.read_to_end(&mut bytes).ok()?;
            builder.status(StatusCode::OK).body(Cow::Owned(bytes))
        }
        Span::Part(start, end) => {
            let mut bytes = vec![0; usize::try_from(end - start + 1).ok()?];
            file.seek(SeekFrom::Start(start)).ok()?;
            file.read_exact(&mut bytes).ok()?;
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .body(Cow::Owned(bytes))
        }
        Span::Unsatisfiable => builder
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(CONTENT_RANGE, format!("bytes */{len}"))
            .body(Cow::Borrowed(&[][..])),
    };
    response.ok()
}

fn respond(root: &Path, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let range = request
        .headers()
        .get(RANGE)
        .and_then(|value| value.to_str().ok());
    resolve(root, request.uri().path())
        .and_then(|path| read_span(&path, range))
        .unwrap_or_else(not_found)
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

/// Builds the web view into the window. WebView2 and WKWebView attach to the native
/// window directly.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn attach<'a>(builder: WebViewBuilder<'a>, window: &'a Window) -> wry::Result<WebView> {
    builder.build(window)
}

/// Builds the web view into the window. WebKitGTK is a GTK widget, packed into the
/// window's default box so it fills the window on X11 and Wayland alike.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn attach<'a>(builder: WebViewBuilder<'a>, window: &'a Window) -> wry::Result<WebView> {
    use tao::platform::unix::WindowExtUnix;
    use wry::WebViewBuilderExtUnix;
    match window.default_vbox() {
        Some(vbox) => builder.build_gtk(vbox),
        None => builder.build_gtk(window.gtk_window()),
    }
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

    #[cfg(not(target_os = "macos"))]
    let data_directory = loaded
        .as_ref()
        .ok()
        .and_then(|(_, info)| profile_dir(&info.id));
    #[cfg(target_os = "macos")]
    let data_directory = None;
    let mut web_context = WebContext::new(data_directory);
    let builder = WebViewBuilder::new_with_web_context(&mut web_context);
    // A secure origin is needed for crypto.randomUUID and module workers.
    #[cfg(target_os = "windows")]
    let builder = builder.with_https_scheme(true);
    #[cfg(target_os = "macos")]
    let builder = match &loaded {
        Ok((_, info)) => builder.with_data_store_identifier(data_store_identifier(&info.id)),
        Err(_) => builder,
    };
    let builder = match &loaded {
        Ok((root, _)) => {
            let root = root.clone();
            builder
                .with_custom_protocol(PROTOCOL.into(), move |_id, request| {
                    respond(&root, &request)
                })
                .with_url(start_url())
        }
        Err(message) => builder.with_html(error_page(message)),
    };
    let _webview = match attach(builder, &window) {
        Ok(webview) => webview,
        Err(error) => {
            eprintln!("{WEBVIEW_FAILURE}: {error}");
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
    fn range_headers_select_one_satisfiable_span() {
        assert_eq!(requested_span(None, 10), Span::Whole);
        assert_eq!(requested_span(Some("bytes=0-3"), 10), Span::Part(0, 3));
        assert_eq!(requested_span(Some(" bytes=4- "), 10), Span::Part(4, 9));
        assert_eq!(requested_span(Some("bytes=8-99"), 10), Span::Part(8, 9));
        assert_eq!(requested_span(Some("bytes=-3"), 10), Span::Part(7, 9));
        assert_eq!(requested_span(Some("bytes=-30"), 10), Span::Part(0, 9));
        assert_eq!(requested_span(Some("bytes=10-"), 10), Span::Unsatisfiable);
        assert_eq!(requested_span(Some("bytes=-0"), 10), Span::Unsatisfiable);
        assert_eq!(requested_span(Some("bytes=0-"), 0), Span::Unsatisfiable);
        assert_eq!(requested_span(Some("bytes=5-2"), 10), Span::Whole);
        assert_eq!(requested_span(Some("bytes=0-1,4-5"), 10), Span::Whole);
        assert_eq!(requested_span(Some("items=0-1"), 10), Span::Whole);
        assert_eq!(requested_span(Some("bytes=a-1"), 10), Span::Whole);
    }

    #[test]
    fn files_are_served_whole_or_by_range() {
        let root = std::env::temp_dir().join(format!("auvra-player-range-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let track = root.join("track.mp3");
        std::fs::write(&track, b"0123456789").unwrap();
        let whole = read_span(&track, None).unwrap();
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.headers()[ACCEPT_RANGES], "bytes");
        assert_eq!(whole.headers()[CONTENT_TYPE], "audio/mpeg");
        assert_eq!(whole.body().as_ref(), b"0123456789");
        let part = read_span(&track, Some("bytes=2-4")).unwrap();
        assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(part.headers()[CONTENT_RANGE], "bytes 2-4/10");
        assert_eq!(part.body().as_ref(), b"234");
        let beyond = read_span(&track, Some("bytes=10-")).unwrap();
        assert_eq!(beyond.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(beyond.headers()[CONTENT_RANGE], "bytes */10");
        assert!(read_span(&root.join("missing.mp3"), None).is_none());
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

    #[test]
    fn each_platform_finds_the_web_build_where_the_editor_exports_it() {
        let contents = Path::new("Games").join("Demo.app").join("Contents");
        let game = contents.join("Resources").join("game");
        assert_eq!(bundle_game_dir(&contents.join("MacOS")), Some(game.clone()));
        assert_eq!(bundle_game_dir(&Path::new("Games").join("MacOS")), None);
        assert_eq!(bundle_game_dir(&contents.join("Resources")), None);
        assert_eq!(bundle_game_dir(Path::new("MacOS")), None);
        let folder = Path::new("Games").join("Demo");
        let beside = if cfg!(target_os = "windows") {
            folder.clone()
        } else {
            folder.join("game")
        };
        assert_eq!(content_dir(&folder), beside);
        let in_bundle = if cfg!(target_os = "macos") {
            game
        } else if cfg!(target_os = "windows") {
            contents.join("MacOS")
        } else {
            contents.join("MacOS").join("game")
        };
        assert_eq!(content_dir(&contents.join("MacOS")), in_bundle);
    }

    #[test]
    fn linux_storage_follows_the_xdg_data_home() {
        let absolute = std::env::temp_dir().join("xdg-data");
        let home = std::env::temp_dir().join("home");
        assert_eq!(
            xdg_data_home(Some(absolute.clone().into()), Some(home.clone().into())),
            Some(absolute)
        );
        let shared = home.join(".local").join("share");
        assert_eq!(
            xdg_data_home(Some("relative".into()), Some(home.clone().into())),
            Some(shared.clone())
        );
        assert_eq!(xdg_data_home(None, Some(home.into())), Some(shared));
        assert_eq!(xdg_data_home(None, Some(OsString::new())), None);
        assert_eq!(xdg_data_home(None, None), None);
    }

    #[test]
    fn macos_data_stores_are_stable_per_game() {
        let first = data_store_identifier("my_game_1");
        assert_eq!(first, data_store_identifier("my_game_1"));
        assert_ne!(first, data_store_identifier("my_game_2"));
        assert_ne!(data_store_identifier(""), data_store_identifier("a"));
        assert_eq!(first[6] >> 4, 8);
        assert_eq!(first[8] >> 6, 0b10);
    }

    #[test]
    fn the_start_url_uses_the_platform_custom_protocol_form() {
        let expected = if cfg!(target_os = "windows") {
            "https://game.localhost/index.html"
        } else {
            "game://localhost/index.html"
        };
        assert_eq!(start_url(), expected);
    }
}
