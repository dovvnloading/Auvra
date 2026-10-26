# Getting started

## Run the editor

From the repository root:

```powershell
python Auvra/Auvra.py
```

The launcher prepares its own Python environment and frontend dependencies, then opens the editor in its own window. See the main [README](../README.md) for requirements and launcher commands.

## Create a project

The quickest start is **Starter** in the header. It creates a project with a playable level (rolling terrain, sky, a player start, a player character and scattered props) and game settings already filled in. Press **PLAY LEVEL** in the World Editor straight away, then change things.

For an empty project:

1. Click **New** in the header (click again to confirm). A project is a folder with an `.auvra` descriptor, JSON documents and content-addressed assets.
2. Use **Save** / **Save As** to choose where it lives. **Open** reopens it later; **Export** writes a portable `.auvrapack`.

## Make a level

1. Open the **Environment** tab (the World Editor).
2. In the level selector at the top left, choose **New Level** and give it a name, then select it.
3. Add the basics from the left panel:
   - **Add Player Start**: where the player spawns.
   - **Sky Sphere**: sky, sun and fog.
   - **Terrain** (toolbar): create and sculpt ground.
4. Import a model from the **Content Browser** and drag it into the viewport, or switch to **Place** and click.

## Set up the player

1. In the **Blueprints** tab, create a **Player Character** blueprint and link a character model.
2. Open **Game Settings** in the header and choose the startup level and player blueprint.

## Play

Click **PLAY LEVEL** in the World Editor toolbar to play the current level inside the editor. **Esc** leaves play mode, and **F3** shows a performance overlay. Play never changes your saved project: anything destroyed or spawned while playing is reset when you stop.

When the level works, see [Building and shipping games](building-games.md).
