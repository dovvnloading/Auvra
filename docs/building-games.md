# Building and shipping games

## Game settings

Open **Game Settings** in the header. The settings are stored in the project and shipped with every build:

- **Name**: shown on the title screen and window.
- **Startup level**: the first level the game opens (defaults to the first level).
- **Player blueprint**: the character the player controls.
- **Window, quality and input defaults**: fullscreen, shadows, post-processing, maximum resolution scale, field of view, mouse sensitivity, invert Y and master volume. Players can change the input and volume settings in Options.

Each level should have a **Player Start**; without one the player spawns at the origin (in the editor, under the camera).

## Building

Open **Game Settings**, choose a target under **Build game** and click **Build**, then pick a parent folder. **Build Web** and **Windows** in the header build those two targets straight away. Builds use the saved settings, so save or revert your edits first.

| Target | Auvra writes | Players need |
|---|---|---|
| Web | `<Game Name>-Web`, a static folder | The folder hosted over HTTP or HTTPS (itch.io, GitHub Pages, any static host) |
| Windows | `<Game Name>-Windows` with `<Game Name>.exe` | Microsoft Edge WebView2 Runtime (included in Windows 11) |
| Linux | `<Game Name>-Linux` with a `<game-name>` executable | WebKitGTK 4.1 (x86-64) |
| macOS | `<Game Name>-macOS` with `<Game Name>.app` | macOS 11 or later (Intel or Apple silicon) |

The desktop targets copy a prebuilt Auvra game player for that system, so you can build all of them on one machine. A target whose player is not available is greyed out with the reason:

- An installed Auvra ships the players in its `game-player` folder (`auvra-player.exe`, `linux-x64/auvra-player`, `macos/auvra-player`).
- In a development checkout, `cargo build --release` in `player-desktop` builds the player for the system you are on. For the others, download the CI artifacts to `player-desktop/dist/linux-x64/auvra-player` and `player-desktop/dist/macos/auvra-player`. The macOS player from CI is one universal binary; a local `cargo build` on a Mac runs only on that Mac's kind of processor.

Every build carries a `THIRD_PARTY_NOTICES.txt` covering the players it includes, and an `auvra-build.json` marker that lists each file with its size and hash.

## Build for the web

The `<Game Name>-Web` folder contains:

| Path | Contents |
|---|---|
| `index.html`, `assets/` | The game player |
| `game/game.json` | Game manifest: name, levels, settings, asset list |
| `game/content/` | The project's documents, without editor-only data |
| `game/assets/` | Only the assets the game uses |
| `THIRD_PARTY_NOTICES.txt` | Licenses of the open-source packages in the player |
| `auvra-build.json` | Build marker with every file's size and hash |

The folder must be **served over HTTP or HTTPS** (for example itch.io, GitHub Pages or any static host). Opening `index.html` directly from disk does not work in browsers. For a quick local test:

```powershell
python -m http.server 8000 --directory "<Game Name>-Web"
```

Then open `http://localhost:8000/`.

## Build for Windows

Auvra writes `<Game Name>-Windows` with `<Game Name>.exe` next to the same web files. The exe needs the Microsoft Edge WebView2 Runtime, which is included in Windows 11. Ship the whole folder; the exe serves the game from it.

## Build for Linux

Auvra writes `<Game Name>-Linux`:

| Path | Contents |
|---|---|
| `<game-name>` | The game: the player under a lower-case name made from the game name (for example `space-race-2`) |
| `game/` | The same web files as the web build; the executable serves the game from here |
| `README.txt` | How to start the game and install its runtime |
| `THIRD_PARTY_NOTICES.txt`, `auvra-build.json` | Notices and the build marker |

Players run `./<game-name>` from the folder, or double-click it. The game needs the **WebKitGTK 4.1** runtime, which most desktop distributions already include:

| Distribution | Install |
|---|---|
| Debian, Ubuntu | `sudo apt install libwebkit2gtk-4.1-0` |
| Fedora | `sudo dnf install webkit2gtk4.1` |
| Arch | `sudo pacman -S webkit2gtk-4.1` |

The executable must keep its executable bit. Auvra sets it where the file system supports it and records it (mode 755) in `auvra-build.json`. Windows folders have no executable bit, so a zip made on Windows loses it; players then run `chmod +x <game-name>` once, as the README says. Zipping on Linux or macOS (`zip -r`) keeps it.

## Build for macOS

Auvra writes `<Game Name>-macOS` containing `<Game Name>.app` and a `README.txt`. Inside the app:

| Path | Contents |
|---|---|
| `Contents/Info.plist` | App name, bundle id `com.auvra.<game id>`, version (from a `version` such as `1.2.0` in the game settings, when there is one), macOS 11 minimum, Retina support |
| `Contents/MacOS/<Game Name>` | The player; the one from CI or an installed Auvra is universal (Intel and Apple silicon) |
| `Contents/Resources/game/` | The same web files as the web build |
| `Contents/Resources/THIRD_PARTY_NOTICES.txt` | Notices |

The app is **not signed or notarized**, so Gatekeeper blocks a plain double-click the first time. Players **right-click the app (or Control-click) and choose Open**, then click **Open** again; macOS remembers the choice. On macOS 15 and later, they try to open it once, then click **Open Anyway** in **System Settings > Privacy & Security**. If macOS says the app "is damaged", the download quarantine is the cause: `xattr -dr com.apple.quarantine "<Game Name>.app"` in Terminal clears it. The executable bit matters here too, so zip the app on a Mac (**Compress** in Finder) when you can.

## Rebuilding

Building again into the same parent replaces the previous build. Auvra only replaces folders that carry its `auvra-build.json` marker, and never deletes other folders. If the build folder is in use (for example a running copy of the game), the build stops and tells you to close it.

## In the built game

- **Title screen**: Play, Continue (latest save) and Options, or your own title menu (see [Menus](hud-and-menus.md#menus)).
- **Esc** (the **Pause** action) pauses: Resume, Save, Load, Options, Quit to Title, or your own pause menu.
- **Saves** are checkpoints: level, player health and stamina, and level variables. They are stored per game on the player's machine: the Windows build keeps them in `%LOCALAPPDATA%\AuvraGames\<game>`, the Linux build in `~/.local/share/AuvraGames/<game>` (or under `$XDG_DATA_HOME`), and the macOS build in the system's web storage for the game.
- **F3** toggles a performance overlay: frame rate, average and worst frame time, draw calls, triangles, geometries, textures and (where the browser reports it) memory. It also works when you play in the editor.

Playing in the editor shows the Game HUD as the built game does (a built-in HUD when the Game HUD is empty). The title and pause menus and the Options screen appear only in built games; in the editor **Esc** pauses with the play toolbar (see [Getting started](getting-started.md)).

## Options

Players open **Options** from the title or pause menu. Changes apply straight away and are saved per game on the player's machine.

| Section | Settings |
|---|---|
| Look | **Mouse sensitivity**, **Invert vertical look** |
| Language | **Text language**; shown only when the project has more than one locale (see [Localization](hud-and-menus.md#localization)) |
| Audio | **Master**, **Music**, **Effects** and **Interface** volume |
| Controls | **Rebind** for each action, and **Reset controls** |

Mouse sensitivity, invert Y and master volume start from **Game Settings**; music starts at 80% and the other buses at 100%. To rebind, click **Rebind** and press the new key or mouse button (Esc cancels). It replaces that action's keyboard and mouse keys; gamepad buttons are kept.

## Controls

| Action | Keyboard and mouse | Gamepad |
|---|---|---|
| Move | W A S D or the arrow keys | Left stick |
| Jump | Space | Button 0 (A) |
| Sprint | Left Shift | Button 10 (left stick press) |
| Fire | Left mouse | Button 7 (right trigger) |
| Aim | Right mouse | Button 6 (left trigger) |
| Interact | F | Button 2 (X) |

The **Pause** action (Esc or gamepad Start, rebindable in Options) pauses the game. The **Input Action** node in the level blueprint can read every action above, plus **Pause** (Esc, gamepad button 9). **Interact** has no built-in use, so it is free for your own scripting.
