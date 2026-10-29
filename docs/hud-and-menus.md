# HUD, menus and localization

The **HUD/UI** tab edits the screens drawn over the game: the in-game HUD and the title and pause menus. Playing in the editor shows the Game HUD as the built game does, or a built-in HUD while the Game HUD is empty; the title and pause menus appear only in built games.

## Screens

The tabs in the canvas toolbar switch between three screens:

| Tab | Shown |
|---|---|
| Game HUD | Over the level during play |
| Title menu | On the title screen |
| Pause menu | When the player presses Esc |

Add widgets from the **Library** panel (Text Block, Button, Container / Panel, Health Widget, Basic Crosshair, Sniper Scope, Custom Code). **Layers** lists the current screen's elements. Select an element to edit its attributes.

A new title or pause menu starts from a default layout (a title and the usual buttons) that you can restyle, move or replace.

## Menus

Any element on a menu screen can run an action when the player clicks it. The **Button** widget is the usual choice; its attributes are the label, **Label Key** (for [localization](#localization)), variant (primary, secondary, outline or ghost) and font size.

Choose the element's **Action**:

| Action | Does |
|---|---|
| Play | Starts the startup level |
| Continue | Loads the newest save |
| Load | Loads the saved game |
| Options | Opens the Options screen |
| Open level... | Starts the level chosen in **Level** |
| Resume | Pause menu: closes the menu and returns to the game |
| Save | Pause menu: saves the game |
| Quit | Title menu: closes the game where the platform allows it (most browsers ignore this). Pause menu: returns to the title screen |

An action that cannot run at the moment is shown dimmed, for example Continue when there are no saves, Resume on the title menu, or a level that is not in the build. Players can also reach the buttons with Tab and press Enter or Space.

Your menu replaces the built-in one only when it can't trap the player:

- The **title menu** needs a visible element with Play, Continue, Load or Open level. Until it has one, the editor shows a warning and built games keep the built-in title menu.
- The **pause menu** needs a visible element with Resume.

## Live values

HUD elements can show live game values. A binding maps one of the element's attributes to a value:

| Path | Value |
|---|---|
| `player.health`, `player.maxHealth`, `player.stamina` | Player stats |
| `player.isAiming` | Whether the player is aiming |
| `player.weapon`, `player.ammo`, `player.magazine`, `player.reserve`, `player.reloading` | The held [weapon](characters.md#weapons): its name, the rounds in its magazine, the magazine size, the rounds carried (-1 for unlimited) and whether it is reloading |
| `level.id` | The current level's id |
| `vars.<name>` | A [level variable](level-scripting.md#level-variables), such as `vars.score` |
| `abilities.<name>`, `abilityMax.<name>` | One of the player's [ability attributes](world-editor.md#abilities) and its maximum, such as `abilities.mana` and `abilityMax.mana` for a mana bar |
| `cooldowns.<ability>` | Seconds before one of the player's abilities can be used again, such as `cooldowns.fireball` (0 when ready) |

To bind an element to a live value, select it and use the **Bind** section of its properties: pick the property (for a Text Block, its text or colour) and the source, such as player health, **Game variable...** with a level variable's name (stored as `vars.<name>`), or **Player attribute...**, **Player attribute maximum...** or **Ability cooldown (s)...** with the attribute or ability's name. **Clear** removes the binding. Bound properties show a "Bound to ..." hint. Bindings apply only during play; the editor shows the authored value.

## Localization

Click **Localization** in the header to edit the game's text in several languages.

1. Choose the **default locale**, the language used when no translation exists.
2. Add the other locales by code, for example `fr`, `de` or `pt-BR`, and click **Add**.
3. Add a key for each piece of text, for example `hud.score`, with **Add key**, then fill in each language's text in the grid.
4. Click **Save**. Saving is disabled when the project is read-only.

Empty cells are untranslated. They show the text that will be used instead, and the panel header counts them. **Filter keys or text** narrows the grid.

To use a key, set a Text Block's **Text Key** or a Button's **Label Key**. When a key is set, it replaces the element's own text. The text is looked up in this order:

1. The player's language.
2. Its base language (`fr` for `fr-CA`).
3. The default locale.
4. The key itself, so a misspelt or missing key appears on screen as the key.

Players choose the language in **Options**, under **Language**. That section only appears when the project has more than one locale.

Notes:

- Elements made before localization was added, and the default menu layouts, have no key attribute. To translate them, replace them with new Text Blocks or Buttons from the Library.
- The built-in title, pause and Options screens are in English only. To translate menus, build your own.
- After opening a project, the HUD editor shows keys instead of text until you save in the Localization panel or play a level.
