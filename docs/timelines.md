# Timelines

A **Timeline** component plays keyed animation during play. It can move, rotate, scale, show and hide objects, write level variables, raise named events and cut between cameras. For cinematics it also plays clips on characters, sounds, subtitles and screen fades, and can take over the screen and the player's controls while it plays (see [Cinematics](#cinematics)). Use timelines for doors and lifts, light shows, cutscenes and other scripted sequences.

## Adding a timeline

Select an object and use **Add Component** > **Timeline** in the inspector. The object that carries the component owns the timeline. New object tracks target the owner, but one timeline can animate any object in the same level.

The component's inspector shows the timeline's duration and how many tracks and keys it has. Click **Edit Timeline** to open the editor.

## The timeline editor

The editor is a dope sheet docked along the bottom of the window. The viewport above it shows the timeline at the playhead as play would: objects moved and hidden, and characters posed by their clips. Scrub the playhead to see any moment; everything goes back when the editor closes. The toolbar along the top has:

- **Duration**: the length of the timeline in seconds (0.05 to 600). Playback stops or loops when it reaches the end.
- **Playhead**: the time where new keys go. You can also click or drag the ruler to move it. It snaps to 0.05 s; hold Shift for free timing. When the ruler has focus, the arrow keys move the playhead by 0.05 s (1 s with Shift), and Home and End jump to the start and the end.
- **Transform**, **Visibility**, **Variable**, **Event**, **Camera**, **Animation**, **Audio**, **Subtitles**, **Fade**: each adds a track of that kind.
- **Zoom**: widens or narrows the time scale.

Below the toolbar are the ruler and one row per track. Keys show as diamonds at their times; clips, sounds and subtitle lines show as bars as long as they last. The panel on the right edits the selected key.

Nothing you change reaches the level until you click **Save**, which stores the whole timeline as one edit, so a single Undo reverts it. **Cancel**, the close button and Escape all discard your changes, and the editor asks first if there are unsaved changes. The World Editor's shortcuts are off while the timeline editor is open, so Delete and Ctrl+Z there never change the level behind it.

## Tracks

| Track | Target | Keys hold |
|---|---|---|
| Transform | An object in this level | Position, rotation (degrees) and scale, each on its own row. They are local to the object's parent, like the inspector's fields. A row without keys leaves that part of the transform alone |
| Visibility | An object in this level | Visible or hidden |
| Variable | A level variable, by name | A number |
| Event | None | An event name (see [Events](#events)) |
| Camera | None | The camera to show from this key on: an object with a Camera component, or the gameplay camera (see [Camera cuts](#camera-cuts)) |
| Animation | A character: an object with a model, or the player | A clip of the character's model, played from the key for a length (see [Character animation](#character-animation)) |
| Audio | Everywhere (2D), an object, or the player; and a mixer bus | A sound, played from the key for at most a length, at a volume |
| Subtitles | None | A line and who says it, shown from the key for a length |
| Fade | None; the track has a colour | How much the colour covers the screen, from 0 (clear) to 1 (covered) |

Each track's header has:

- **Name**: leave it blank to show the target's name.
- **Target**: Transform and Visibility tracks list the level's objects. An Animation track lists the objects with a model and the player; an Audio track lists the objects and the player, or plays everywhere, and picks a mixer bus. A Fade track picks its colour. A Variable track takes a variable name and suggests the variables declared in the Level Blueprint's **Variables** panel (see [Level variables](level-scripting.md#level-variables)).
- **Mute** (speaker icon): playback skips a muted track. Muting is a quick way to try a timeline without one of its tracks.
- **Delete** (bin icon): removes the track and its keys.

When two tracks drive the same part of the same object, or the same variable, the lower track in the list wins.

## Keys

- **Add a key**: move the playhead, then double-click a row. If a key is already at that time, it is selected instead. A new transform key copies the key next to it, or the target's current transform when the row is empty. A new visibility key flips the key before it (the first one is visible). Variable and event keys copy their neighbour.
- **Add key from object** (Transform tracks): keys the target's current position, rotation and scale at the playhead on all three rows, replacing keys already at that time. To key a pose, place the object in the World Editor, open the timeline editor, set the playhead and click the button.
- **Select** a key by clicking it. The panel on the right shows its **Time**, **Value** and **Interpolation**, and a **Delete Key** button.
- **Move** a key by dragging it. It snaps to 0.05 s; hold Shift for free timing. Keys stay between 0 and the duration.
- **Delete** the selected key with Delete or Backspace.

Keys past the end of the timeline, for example after you shorten the duration, are kept but drawn faded at the end of their row. The editor's footer counts them. Drag them back in, or delete them.

## Interpolation

Before its first key a track holds the first key's value, and after its last key it holds the last. Between two keys, the interpolation of the first key decides how the value changes:

| Interpolation | Between this key and the next |
|---|---|
| Linear (default) | Moves in a straight line |
| Step | Holds this key's value, then jumps at the next key |
| Smooth | Eases out of this key and into the next |

Only Transform, Variable and Fade keys interpolate. Visibility, event and camera keys always step; clips blend by their own blend in and out. Two keys at the same time make an instant jump.

## Playback

The Timeline component's own settings, in the inspector above the summary, control playback:

| Setting | Default | Does |
|---|---|---|
| Autoplay | On | Starts the timeline when play begins |
| Loop | Off | Wraps back to the start at the end. Without it the timeline stops at the end and holds its last values |
| Speed | 1 | Playback rate, from 0 to 10. 2 plays twice as fast, 0.5 half as fast, and 0 holds the timeline where it is |
| Play Variable | Blank | The name of a level variable. When set, the timeline plays only while that variable is true or non-zero (text that reads `true` or a non-zero number also counts), and Autoplay is ignored |
| Cinematic | Off | While it plays: letterbox bars, the HUD hidden, the player's controls taken (see [Cinematics](#cinematics)) |
| Can Be Skipped | On | A cinematic the player can skip with Enter |
| Hold End Pose | Off | Once finished, characters keep the timeline's last pose instead of going back to their own animation |

Timelines run during play, and in the editor only while the timeline editor shows them. A timeline paused by its Play Variable resumes from where it stopped. A paused or finished timeline leaves its targets where it last put them; characters hold their pose while it is paused. Play never changes the project: objects are back in their places when play stops.

Variable tracks write their variable each frame while the timeline plays. Values are converted to the variable's declared type, as with **Set Level Variable**, and a name that was never declared is created as a number. Bind a HUD element to `vars.<name>` to show it (see [Live values](hud-and-menus.md#live-values)).

For example, a door that opens when the player steps on a switch:

1. Add a **Timeline** to the door. Turn **Autoplay** off and set **Play Variable** to `doorOpen`.
2. In the editor, add a Transform track (it targets the door), key the closed pose at 0 s and the open pose at 1.5 s, and set the first key's interpolation to **Smooth**.
3. In the Level Blueprint, declare `doorOpen` as a Boolean (false), and connect **On Overlap** on the switch to **Set Level Variable** `doorOpen` = true.

## Camera cuts

A Camera track switches the view at each key to the camera chosen for it, until the next key. Choose **Gameplay camera** to hand the view back to the player's camera. The track's **Blend** sets how long each switch eases over (0 cuts at once). Cameras are objects with a **Camera** component; the editor shows its view pyramid. When a timeline that switched cameras goes away, the gameplay camera comes back.

## Character animation

An Animation track plays clips on one character: a placed object with a model, or the player. Each key is a clip of that character's model placed on the timeline:

- **Clip**: one of the model's clips. A clip the model does not have plays nothing.
- **Length**: how long it plays on the timeline. **Start at** skips into the clip, and **Speed** sets its rate (negative plays it backwards).
- **Loop the clip**: plays round again past the clip's end; otherwise it holds its last frame for the rest of its length.
- **Blend in** and **Blend out**: seconds over which the clip eases in from the pose underneath and back out to it.

The clips lie over the character's own animation: its graph, its Animation component, or its rest pose. Where clips overlap they crossfade by their blends, so to go from a walk to a stand, overlap the two by the walk's blend out and the stand's blend in. Where no clip plays, the character's own animation shows. IK and Procedural Rig components work on the result. Move a character across the scene with a Transform track on the same object while a walk clip plays.

## Cinematics

A cutscene is a timeline with the **Cinematic** setting on. While it plays, the view gets letterbox bars, the HUD is hidden (it keeps its state for afterwards), and the player's controls are taken, as during a conversation. When it ends, the gameplay camera, the HUD and the controls come back. With **Can Be Skipped**, a prompt in the corner lets the player press Enter (or click it) to jump to the end: the timeline puts everything where its end has it, raises the events it had left (so a level script waiting for its last event still runs), and stops its sounds.

Any timeline, cinematic or not, can also show:

- **Subtitles**: each line shows at the bottom of the screen with its speaker for its length. When lines overlap, the one that started last shows. To translate a line, add the key `timeline.<object id>.<track id>.<milliseconds>` to the project's string tables (the speaker's key adds `.speaker`); the authored text shows where a language has none.
- **Sounds**: each Audio key plays its sound from its time, through the track's mixer bus, from the track's object in 3D or everywhere alike. A sound stops at the end of its length or when the timeline ends, and one that takes a moment to load still starts in step.
- **Fades**: a Fade track covers the screen with its colour. Fade in from black at the start (keys 1 then 0) and out at the end. A fade still showing when the timeline ends stays on screen, so bring a cutscene's fade back to 0 before its end unless it leads into another level.

Give a cutscene's characters **Hold End Pose** when they should stay as the cutscene leaves them, such as a guard lying where he fell. Without it, they go back to their own animation, so give their last clips a blend out.

## Events

Each key on an Event track raises an event named by the key's value when playback passes its time. Keys at 0 s fire as soon as the timeline starts, a looping timeline raises its events again on every loop, and keys with blank names and keys on muted tracks raise nothing.

Every event carries its name and the object that carries the timeline. In level scripting, the **Timeline Event** event runs when an event with its name is raised (leave the name empty to catch every timeline event). Gameplay scripts receive them in `onTimelineEvent(ctx, name, timelineObjectId)` (see [Gameplay scripting](scripting.md)).
