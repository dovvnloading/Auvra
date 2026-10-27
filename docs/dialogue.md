# Dialogue

A **Dialogue** component gives an object a conversation: lines spoken by someone, each leading to the next line or offering the player a choice. During play the player walks up to the object and presses **Interact** (F, or the left face button on a gamepad) to talk. A **Start Dialogue** node or a script can open a conversation too.

## Adding a conversation

1. Select the object that should talk (an NPC, a sign, a terminal) and add a **Dialogue** component in the inspector.
2. Set **Reach**: how close, in metres, the player must be for the Interact prompt to appear. A reach of 0 hides the prompt, so only a Start Dialogue node or a script opens the conversation. The editor draws the reach as a ring around the object.
3. Set **Prompt**: the word shown next to the key, such as *Talk*, *Read* or *Use*.
4. Click **Edit Dialogue** to write the conversation.

## The dialogue editor

The left column lists the lines. The flag marks the **start line**, where the conversation begins; select another line and click **Start here** to move it. **Add Line** appends a line spoken by the same speaker as the last one. The arrows reorder lines in the list (the order is only for you; where each line leads is what matters), and the bin deletes a line. Anything that led to a deleted line ends the conversation there instead.

For the selected line:

| Field | Meaning |
|---|---|
| Speaker | The name shown above the text. Leave it empty for narration |
| Text | What is said. Line breaks are kept |
| Sets variable (on) when shown | A level variable switched on (true) as the line appears |
| Raises event when shown | A Dialogue Event raised as the line appears |
| Then | The line that follows, or **End conversation**. With choices, it is used only when none of the choices can be offered |

**Add Choice** gives the line up to eight answers. Each choice has:

| Field | Meaning |
|---|---|
| Text | What the player says |
| Leads to | The line that follows, or **End conversation** |
| Offered only while variable is on | The choice appears only while this level variable is true or non-zero. Leave it empty to always offer it |
| Sets variable (on) | A level variable switched on when the choice is taken |
| Raises event | A Dialogue Event raised when the choice is taken |

The footer warns about links to lines that no longer exist and lines nothing leads to. **Save** commits the whole conversation as one edit (undo takes it back); **Cancel** or Escape asks before throwing changes away.

Variable names are suggested from the level blueprint's variables, but any name works: an undeclared variable is created the first time a line or choice switches it on. See [Level variables](level-scripting.md#level-variables).

## Talking during play

- Near a speaker the prompt shows the Interact key and the prompt word. With several speakers in reach, the nearest one talks.
- While a conversation is open the player character stands still and the camera holds.
- **Interact**, **Jump** or a left click continues a line without choices.
- Choices are picked with **Move forward / Move back** (W/S, the arrow keys or the left stick) and taken with Interact, Jump or a click; keys 1 to 9 take a choice directly. On touch screens, tap the line or a choice.
- One conversation runs at a time. Pausing hides it; it carries on when play resumes. Restarting the level, opening another level or destroying the speaker ends it.

## Branching on what happened

Lines and choices only switch variables on, and choices only check that a variable is on, so a conversation can remember what the player did:

- A choice *Accept the quest* sets `acceptedQuest`; on a later visit a choice *About that quest...* requires `acceptedQuest`.
- A trigger or timeline elsewhere sets `heardRumour`; the innkeeper's *About the wolves...* requires it.

For anything else (counting, switching a variable off, giving items) raise an event and handle it in the level blueprint or a script.

## Dialogue events

A line or choice with **Raises event** sends a named event when it is shown or taken. Every event carries its name and the object whose Dialogue component holds the conversation.

- In level scripting, the **Dialogue Event** event runs when an event with its name is raised. Leave the name empty to catch every dialogue event. See [Level scripting](level-scripting.md#dialogue).
- Gameplay scripts receive `onDialogueEvent(ctx, name, objectId)`. See [Gameplay scripting](scripting.md#callbacks).

An event handler that opens another conversation, or ends this one, wins over the line that raised the event.

## Opening a conversation from logic

- The **Start Dialogue** node opens the conversation of the object picked in its inspector, wherever the player is. It does nothing while another conversation is open, and shows a warning when the object has no Dialogue component in the session.
- `ctx.startDialogue(objectId)` does the same from a script; without an id it opens the conversation on the script's own object.

A Dialogue component with a reach of 0 is a conversation only logic can open: a cutscene line, a radio message or a sign the player reads by pressing a button elsewhere.

## Translating dialogue

Lines are shown through the game's [localization](hud-and-menus.md#localization) tables. A locale can translate a conversation with these keys, where `<object>` is the id of the object with the Dialogue component, `<line>` a line id and `<choice>` a choice id:

| Key | Text |
|---|---|
| `dialogue.<object>.<line>.speaker` | The line's speaker |
| `dialogue.<object>.<line>.text` | The line's text |
| `dialogue.<object>.<line>.<choice>` | A choice's text |

Text a locale does not translate shows as written in the dialogue editor. New lines are numbered `line1`, `line2`, ... and choices `choice1`, `choice2`, ...; the ids do not change when lines are reordered.
