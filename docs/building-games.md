# Building and shipping games

## Game settings

Open **Game Settings** in the header. The settings are stored in the project and shipped with every build:

- **Name**: shown on the title screen and window.
- **Startup level**: the first level the game opens (defaults to the first level).
- **Player blueprint**: the character the player controls.
- **Window, quality and input defaults**: fullscreen, shadows, post-processing, maximum resolution scale, field of view, mouse sensitivity, invert Y and master volume. Players can change the input and volume settings in Options.

Each level should have a **Player Start**; without one the player spawns at the origin.

## Build for the web

Click **Build Web** in the header and pick a parent folder. Auvra writes `<Game Name>-Web` containing:

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

Click **Windows** next to **Build Web**. Auvra writes `<Game Name>-Windows` with `<Game Name>.exe` next to the same web files. The exe needs the Microsoft Edge WebView2 Runtime, which is included in Windows 11. Ship the whole folder; the exe serves the game from it.

## Rebuilding

Building again into the same parent replaces the previous build. Auvra only replaces folders that carry its `auvra-build.json` marker, and never deletes other folders. If the build folder is in use (for example a running copy of the game), the build stops and tells you to close it.

## In the built game

- **Title screen**: Play, Continue (latest save) and Options, or your own title menu (see [Menus](hud-and-menus.md#menus)).
- **Esc** (the **Pause** action) pauses: Resume, Save, Load, Options, Quit to Title, or your own pause menu.
- **Saves** are checkpoints: level, player health and stamina, and level variables. They are stored per game on the player's machine (the Windows build keeps them in `%LOCALAPPDATA%\AuvraGames\<game>`).
- **F3** toggles a performance overlay: frame rate, average and worst frame time, draw calls, triangles, geometries, textures and (where the browser reports it) memory. It also works when you play in the editor.

The Game HUD, the menus and the Options screen appear only in built games. Playing in the editor shows a built-in HUD, and **Esc** returns to the editor.

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
