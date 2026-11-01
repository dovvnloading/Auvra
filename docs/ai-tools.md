# AI tools

The editor can use AI models for texturing and for code. Nothing here is needed to make a game, and no model is called until you ask for something.

## Where they are

| Tool | Where | What it does |
|---|---|---|
| **Generator** | Retexture tab | Restyles one of a model's texture maps from a description, or paints a new one |
| **Generative Retexture** | Scene tab, on the selected model | The same, on the model's first map |
| **AI Coder** | HUD/UI tab, right-hand panel | Proposes HUD elements and changes for you to approve. Approved changes can be undone |
| **AI** | Script editor, top right | Writes or changes a script. You choose to replace the script or insert the answer, and the editor's undo takes it back |

Each tool shows the model it will use and what that model costs. Click it to change the model there and then, or use **Settings: AI providers** to see everything together.

## fal.ai

One [fal.ai](https://fal.ai) key covers all of these tools. Choose fal.ai in a tool's model list and click **Add key**, or use **Configure Key** in Settings. The key goes into a native prompt and is kept by Windows Credential Manager, or for that session only if you untick **Keep in OS vault**. It never reaches the editor's page or the project.

**Image models.** Every active image model in fal's catalog is offered and kept up to date from fal itself: image-to-image models for restyling, and text-to-image models for painting new maps. Prices come in over the first couple of minutes after the list first opens. Sort by **Cheapest** or search by name.

Each model is sent what it says it takes: the picture in whichever form it wants, one image at a time, at the size of the map being restyled so that it still lines up with the model. A model that needs something the tool does not have, such as a mask, says so when you try it. Models that take no description, such as upscalers, simply work on the map.

**Language models.** fal's router reaches OpenRouter's language models, which are offered for coding and for the AI Coder. The AI Coder only lists those that can keep to the format its proposals must be in. The cheapest of those follow it less reliably, and a proposal that does not fit is refused rather than applied, so a slightly better model can save retries.

Prices are fal's and are shown as it bills them: per image, per megapixel, per second of compute, or per million input and output tokens. **Cheapest** weighs them by what a square 1024 texture would come to, which is an estimate.

Models that take a mesh and give back a mesh, such as fal's 3D retexturing models, are not offered: these tools work on texture maps.

## Budgets

**Settings: AI providers** can limit what a provider spends per job, per day and per month, in millionths of a dollar. Once all three are set, each image job is checked against them using the catalog's price before it is sent. Language model jobs are not counted, as their cost depends on the length of the answer.
