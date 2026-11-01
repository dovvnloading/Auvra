# AI tools

The editor can use AI models for texturing and for code. Nothing here is needed to make a game, and no model is called until you ask for something.

## Where they are

| Tool | Where | What it does |
|---|---|---|
| **Retexture** | Retexture tab | Restyles a part of a model from a description, or paints it a new texture, and compares the results on the model |
| **AI Coder** | HUD/UI tab, right-hand panel | Proposes HUD elements and changes, shown dashed on the canvas until you apply them. Applied changes can be undone |
| **AI** | Script editor, top right | Writes or changes a script. Its changes appear in the code for you to keep or leave out one by one, and the editor's undo takes them back |

Each tool shows the model it will use and what that model costs. Click it to change the model there and then, or use **Settings: AI providers** to see everything together: which model does each job, the keys, and spending limits.

## Retexture

Pick a model, then the part to paint: click it on the model, or choose it under **Parts**. Pointing at a part names it and lights it up. Describe the change and press **Generate**, or Ctrl+Enter. The cost of the run is shown beside the button, and you can ask for up to four results at once.

**Restyle** changes what the part has now, keeping its layout, and starts from whichever result is on the model. **New** paints from the description alone, for a part with no texture or to start over.

Every result stays in the strip under the model. Click one to try it on, or step through them with the left and right arrow keys. Nothing is saved until you say so:

- **Use on model** saves it on the model, and it is there when the project opens again. **Use original** puts the part back.
- **Save to library** keeps it among the project's textures without changing the model.

**Surface maps.** Under a result, **Make matching maps** makes normal, roughness and metal maps from it, for about a cent, so that light falls on it as it would on the real thing. They are saved with the result.

**Whole model** paints the model as a shape, seen from every side, rather than a flat sheet, so seams and shapes come out right, and it makes surface maps as it goes. It costs more ($0.30 a run on fal) and takes a few minutes. It works on a model with one texture, as most props have: a model with several comes back merged into one mesh, without its rig, so it is not offered for those.

**Compare** (B) splits the model in two at a line you can drag, the part as it was on one side and with the result on the other. **Studio**, **Daylight** and **Flat** change the light, and Flat is the one for judging colour. T turns the model on a turntable and F frames it again.

A part shaded by a material from the Materials tab will not show a texture. The tool says so and can take the material off.

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
