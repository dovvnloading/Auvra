# AI tools

The editor can use AI models for texturing and for code. Nothing here is needed to make a game, and no model is called until you ask for something.

## Where they are

| Tool | Where | What it does |
|---|---|---|
| **Retexture** | Retexture tab | Changes a part's texture from a description, starting from the texture it has, and compares the results on the model |
| **AI Coder** | HUD/UI tab, right-hand panel | Proposes HUD elements and changes, shown dashed on the canvas until you apply them. Applied changes can be undone |
| **AI** | Script editor, top right | Writes or changes a script. Its changes appear in the code for you to keep or leave out one by one, and the editor's undo takes them back |

Each tool shows the model it will use and what that model costs. Click it to change the model there and then, or use **Settings: AI providers** to see everything together: which model does each job, the keys, and spending limits.

## Retexture

Pick a model, then the part to paint: click it on the model, or choose it under **Parts**. Pointing at a part names it and lights it up. Describe the change and press **Generate**, or Ctrl+Enter. The cost of the run is shown beside the button, and you can ask for up to four results at once.

A texture is always changed, never replaced. The tool draws the model as it looks now from six sides, a model edits that picture, and the change is put back on the map through the same views, so that the layout, seams, folds, print and cut-outs stay exactly where the model's UVs expect them. What the model does not use of the map is left untouched. It starts from whichever result is on the model, so changes can be built up. **All parts** changes every texture on the model at once, each from its own map. The views are laid out by the shape of the object, so a long one lies along the picture and gets more of it. All of a model's answer goes back at the size it came, and a map smaller than 2048 pixels grows to that, laid out as it was, to hold it.

Top models are suggested for this, as the job is to change a surface without disturbing anything else. A run on Flux 3, the first suggestion, comes to about $0.13 and takes a minute or two.

**Keep original detail** under a result says how much of the fine detail stays the original's. It works at once and costs nothing, as nothing goes back to the provider.

A map that repeats across a surface is a picture of that surface already, so a model is shown it directly. A part with no texture has nothing to start from, so **New** paints it from the description: on its shape, seen from every side and put on its map through the same views, or as one picture of a surface where its faces share one map, as a box's do. A model with no textures at all can also go whole to a model made for that (**Whole model**).

Every result stays in the strip under the model. Click one to try it on, or step through them with the left and right arrow keys. Nothing is saved until you say so:

- **Use on model** saves it on the model, and it is there when the project opens again. **Use original** puts the part back.
- **Save to library** keeps it among the project's textures without changing the model.

**Surface maps.** Under a result, **Make matching maps** makes normal, roughness and metal maps from it, for about a cent, so that light falls on it as it would on the real thing. They are saved with the result.

**Make matching maps** adds normal, roughness and metal maps, so that light falls on a result as it would on the real thing. Like colour, a laid-out map would only show a model scraps, so it is shown the object from every side, and what comes back goes on through the same views. The normal map holds the fine detail, as the mesh has the large shapes already.

**Whole model** is for a model with no textures: it paints the model as a shape, seen from every side, and makes surface maps as it goes. It costs $0.30 a run on fal and takes a few minutes. A model that has textures keeps them and changes from them instead.

**Compare** (B) splits the model in two at a line you can drag, the part as it was on one side and with the result on the other. **Studio**, **Daylight** and **Flat** change the light, and Flat is the one for judging colour. T turns the model on a turntable and F frames it again.

A part shaded by a material from the Materials tab will not show a texture. The tool says so and can take the material off.

## Skies and decals

In the Environment tab, a sky drawn with **Image** has **Describe** under its panorama. It paints a 360 degree panorama with the horizon across the middle, makes its left and right edges meet so that no line runs down the sky, keeps it with the project's textures and puts it on the sky. Models were tested for this: most paint a wide photograph, which falls apart wrapped around a level, so the ones offered first are those that paint a true panorama.

A **Decal** component has **Describe** under its texture too. It paints the picture on a really transparent background, so only the picture lands on the surface. Few models do this: most accept the setting and paint on white. **Offset** moves the decal from the object's origin, which on most props is at their base.

## Finished frames

**Render this view**, the aperture button in the Environment toolbar, path traces what the camera sees with [Reframe](https://github.com/dovvnloading/Reframe-Diffused), a renderer on this computer. It needs an NVIDIA graphics card and costs nothing. **Preview**, **Good** and **Final** trade time for a cleaner picture. A finished frame can be kept in the texture library. A frame is lit by what lights the view, its reflections and its plain fill or Sky Light, and shows the sky the view shows, whichever kind that is. It carries the fog, in the colour it takes in each direction, the shadows of the clouds, particles, and what a level's post-process stack does: its exposure, including what auto exposure has adapted to, tone curve, white balance, bloom, depth of field, grade, look and vignette. AgX and Neutral have no curve in Reframe, so those frames use its filmic one. The light itself is traced, so shadows and bounced colour differ from the viewport, as they should, and so do the viewport's own screen-space bounces and reflections. Reframe uses Intel's Open Image Denoise where its Python has the `oidn` package, and its own filter where not.

Reframe is found where it is usually kept. If it is kept somewhere else, the panel asks where, and remembers it on this computer. The `AUVRA_REFRAME_HOME` environment variable wins over both. It runs under the Python in its own `.venv`, or the one named by `AUVRA_REFRAME_PYTHON`, or else the one on the path. Each render is a process of its own and leaves Reframe's folder as it was.

It takes each surface's colour, roughness, metal and normal maps and values, the level's lights, the sky and the camera. A procedural sky is captured into a panorama as it stands. Whatever works out a surface's look in its own shader is asked for the result: a material from the Materials tab, terrain and its layers, water, weather, vertex colours. It comes through as it looks in the view at that moment and from that camera. One that goes by where a surface stands or faces gets a picture with a place for each triangle, so each surface has its own look, and its normal is left out. A glow lights what is around it, and one that varies has a map of its own. A surface as big as a level gets a picture for what is near the camera and one for what is further off, so ground close to the frame stays sharp. Water's waves, wind and **World Position Offset** reach the frame where they had moved to. Far scatter goes in as the objects its cards stand for.

## Materials

In the Materials tab, **Describe** paints a seamless texture from a description, with normal, roughness and metal maps, for about a cent. It keeps them in the project and makes a new material with each one wired to the input it is for, ready to change like any other node graph.

## fal.ai

One [fal.ai](https://fal.ai) key covers all of these tools. Choose fal.ai in a tool's model list and click **Add key**, or use the **Keys** page in Settings. The key goes into a native prompt and is kept by Windows Credential Manager, or until the editor closes if you untick **Keep keys in the Windows vault**. It never reaches the editor's page or the project.

**Image models.** Every active image model in fal's catalog is offered and kept up to date from fal itself: image-to-image models for restyling, and text-to-image models for painting new maps. Prices come in over the first couple of minutes after the list first opens. **Suggested** gives a short list by purpose, with a sample each model painted from the same picture and description. **All** has the rest, sorted by **Cheapest** or by name, and searching looks through everything. Models that do not paint from a description, such as upscalers and background removers, stay out of the way until you tick them in.

Each model is sent what it says it takes: the picture in whichever form it wants, one image at a time, at the size of the map being restyled so that it still lines up with the model. A model that needs something the tool does not have, such as a mask, says so when you try it. Models that take no description, such as upscalers, simply work on the map.

**Language models.** fal's router reaches OpenRouter's language models, which are offered for coding and for the AI Coder. The AI Coder only lists those that can keep to the format its proposals must be in. The cheapest of those follow it less reliably, and a proposal that does not fit is refused rather than applied, so a slightly better model can save retries.

Prices are fal's and are shown as it bills them: per image, per megapixel, per second of compute, or per million input and output tokens. **Cheapest** weighs them by what a square 1024 texture would come to, which is an estimate.

Of fal's models that take a whole mesh, the Meshy retexture models are offered for **Whole model**: they paint from a description and keep the model's own texture layout, so what they make fits the model as it is. The others need a reference picture, or give back a different mesh.

## Budgets

The **Spending** page in Settings can limit what a provider spends per job, per day and per month. Once all three are set, each image job is checked against them using the catalog's price before it is sent. Language model jobs are not counted, as their cost depends on the length of the answer.
