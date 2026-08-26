# Auvra

Auvra is an open-source game engine and editor under active development. The
current repository is an early working prototype, not a stable release. Project
files, workflows, and internal APIs may change while the engine is rebuilt on a
more durable foundation.

The editor currently includes scene assembly, environment tools, animation
graphs, visual blueprints, sandbox play, HUD editing, and texture workflows. It
uses React, TypeScript, Three.js, and Vite today. A Python host is present as a
scaffold and will take on desktop startup and local services as the refactor
progresses.

## Development status

Auvra is pre-alpha. It is suitable for development and experimentation, but it
should not yet be used for production projects or irreplaceable work.

The current refactor status is tracked in [REFACTOR.md](REFACTOR.md). That file
is a public summary; detailed architecture and internal implementation planning
are intentionally maintained outside the public repository history.

## Run the current editor

You will need Node.js and npm.

```powershell
cd "fbx-viewer (1)"
npm install
npm run dev
```

Vite serves the editor at `http://127.0.0.1:3000`. To verify a production
bundle locally:

```powershell
cd "fbx-viewer (1)"
npm run build
```

The Python launcher is not implemented yet. Until that stage is complete, the
commands above are the supported development path.

## Contributing

The codebase is moving through a staged refactor, and changes need to stay
within the active stage. Before starting a substantial pull request, open an
issue describing the problem and the files it would affect. Keep pull requests
focused, include the checks used to verify the change, and avoid unrelated
cleanup.

## License

Auvra is licensed under the [Apache License 2.0](LICENSE).
