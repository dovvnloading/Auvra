# Building and shipping games

## Game settings

Open **Game Settings** in the header. The settings are stored in the project and shipped with every build:

- **Name**: shown on the title screen and window.
- **Startup level**: the first level the game opens (defaults to the first level).
- **Player blueprint**: the character the player controls.
- **Window, quality and input defaults**: fullscreen, shadows, post-processing, maximum resolution scale, field of view, mouse sensitivity, invert Y and master volume. Players can change the input and volume settings in Options.
- **Mesh detail levels** (on by default): every mesh with a few hundred triangles or more gets simpler versions of itself, made when its model loads, and draws the simplest one whose difference from the full mesh, in shape, texture placement and shading, stays under a pixel on the screen. A built game has them ready; a mesh nothing prepared gets them when it is first drawn. It covers props, foliage, characters and what they carry, in play and in built games. In the starter level it cut the triangles drawn per frame from about 2.4 million to about 217 thousand.
- **Occlusion culling** (on by default): placed props and foliage that walls and terrain hide from the camera are not drawn, though they still cast their shadows and still show in reflections and bounced light. It works on groups of objects, and only hides a group that is wholly on the screen and wholly hidden, so it does most in a level with a World Grid, whose cells make small groups. In a level without one, a group is usually too spread out to hide, and this costs next to nothing. A group comes back a frame or two after it can be seen. The moving camera allows for that, but something else moving out of the way, like a door opening, may show it that little bit late. If that is noticeable in your game, turn this off.
- **Navigation**: the agent levels' navmeshes are baked for: its radius, height, steepest slope and tallest step (see [Enemy navigation](characters.md#enemy-navigation)).
- **Load assets by level** (on by default): a built game opens straight to its title screen and loads each level's assets when that level starts, with a loading bar. Everything a level names counts: its objects' models, what its prefabs, spawners, scripts and timelines name, the levels its Level Streaming volumes bring in, and the player and enemy characters. A script that builds an asset's name while it runs cannot be seen ahead of time, so a game that does that should turn this off, and then loads all of its assets when the first level starts. The editor always loads the whole project.
- **Asset memory** (2048 MB by default): what earlier levels used stays in memory so going back is quick, until holding it would pass this much. What was used longest ago then goes first. A level always gets what it needs, even past this.
- **Texture compression** (on by default): models load with their textures compressed the way graphics cards read them directly: colour, roughness, metalness, occlusion and emissive maps to BC1 (BC3 where they have transparency), normal maps to BC5, each with its mip levels. They take a fifth to an eighth of the graphics memory and look the same. Each texture is compressed once, the first time it loads or a game is built, and kept in the editor's cache after that. Devices without these formats load textures as they are; a built game then reads its source files. In the starter level, texture memory went from about 273 MB to about 50 MB.

Each level should have a **Player Start**; without one the player spawns at the origin (in the editor, under the camera).

## Renderer

**Renderer** under **Window & quality** in Game Settings says what draws your levels: in the world editor's view, in Play and in a built game.

- **WebGL2**: runs on nearly every machine.
- **WebGPU**: the newer renderer. Where a machine cannot run it, the level draws with WebGL2 instead and the reason goes in the renderer's report.
- **Auto** (the default): WebGPU where the machine has it, WebGL2 elsewhere.

**Sharp sun shadows** under the same heading makes the sun's shadow as sharp far away as it is close by, and a scene that holds still draws no shadows at all from then on. It takes more graphics memory than ordinary shadows and only applies on WebGPU. While anything lit is see-through or the sun is moving, ordinary shadows carry on alongside it.

To try a renderer without changing the project, add `?renderer=webgpu`, `?renderer=webgl2` or `?renderer=auto` to the page's address. It wins over the setting for that page.

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

**Desktop asset response limit:** The Windows, Linux and macOS players buffer each custom-protocol response in memory. To prevent a single asset request from allocating hundreds of MiB, a request without a `Range` header for a file larger than **16 MiB** returns HTTP 413 instead of loading the file. Byte-range requests are served with `206 Partial Content` in chunks of at most 16 MiB; media clients can request further chunks for playback or seeking. Large models and other assets loaded through ordinary whole-file fetches must be split or reduced to 16 MiB or less for desktop builds. The web target does not use this custom protocol and is not subject to this response limit.

### Prepared models

A build does the slow work on each model once, so the game does not repeat it on every launch. Before it asks where to put the game, Auvra prepares each model, attachment and animation file the project uses, one at a time in the background, and the game then loads those prepared files. Each is a GLB beside its source file, holding:

- The geometry as the model's import reads it, with its import settings and the images found beside it, and its detail levels.
- The textures compressed the way graphics cards read them, where **Texture compression** is on.
- The clips. An animation file keeps only its skeleton and clips, so it is much smaller.

The first build of a project takes longer because of this. Later builds, of this project or another using the same files, reuse what was prepared, which is kept with your Auvra settings and never added to a project or its package. Prepared files are made again when a model's source file changes, when an import setting that changes how the file is read changes (blend shapes, normals, tangents, the meshes and takes kept, key reduction), when the images beside it change, when **Texture compression** or **Mesh detail levels** changes, or after an Auvra update changes what they hold. Renaming a model, changing its materials, or cutting its takes into clips prepares nothing again, because those are applied as the game loads.

The source files stay in the build. A game reads a model's source file instead when the model has no prepared file, when the prepared file cannot be read, or on a device that cannot read its compressed textures. Preparing a model never stops a build: a model that could not be prepared, a GLB whose geometry is Draco or meshopt compressed, or a file that two models read with different import settings or images goes in as its source file alone, and Auvra tells you which ones when the build ends.

## Build for the web

The `<Game Name>-Web` folder contains:

| Path | Contents |
|---|---|
| `index.html`, `assets/` | The game player |
| `game/game.json` | Game manifest: name, levels, settings, asset list |
| `game/content/` | The project's documents, without editor-only data |
| `game/assets/` | Only the assets the game uses, and the [prepared models](#prepared-models) |
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
- **Saves** are checkpoints: level, player health and stamina, the weapons the player carries and their rounds, pickups already taken for good, and level variables.They are stored per game on the player's machine: the Windows build keeps them in `%LOCALAPPDATA%\AuvraGames\<game>`, the Linux build in `~/.local/share/AuvraGames/<game>` (or under `$XDG_DATA_HOME`), and the macOS build in the system's web storage for the game.
- **F3** toggles a performance overlay: frame rate, average and worst frame time, draw calls, triangles, geometries, textures and (where the browser reports it) memory. It also works when you play in the editor.

Playing in the editor shows the Game HUD as the built game does (a built-in HUD when the Game HUD is empty: in a built game it shows the player's health, stamina, weapon and crosshair, and players leave through the pause menu). The title and pause menus and the Options screen appear only in built games; in the editor **Esc** pauses with the play toolbar (see [Getting started](getting-started.md)).

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
| Reload | R | Button 1 (B) |
| Next weapon | Q | Button 3 (Y) |
| Throttle | (Move forward) | Button 7 (right trigger) |
| Brake / reverse | (Move back) | Button 6 (left trigger) |
| Handbrake | Space | Button 0 (A), button 5 (right bumper) |
| Change view | V | Button 8 (Back) |
| Look back | B | Button 11 (right stick press) |

The **Pause** action (Esc or gamepad Start, rebindable in Options) pauses the game. The **Input Action** node in the level blueprint can read every action above, plus **Pause** (Esc, gamepad button 9). **Interact** talks to characters with a Dialogue component and gets into and out of [vehicles](world-editor.md#vehicles); scripts can read it too. In a vehicle, Move forward and back (or the triggers, which are analog) are the throttle and the brake (reverse from a stop), Move left and right steer, Handbrake locks the rear wheels, Change view cycles the cameras and Look back looks behind.
