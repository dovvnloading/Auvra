# Security

## Reporting a vulnerability

Please report anything you think is a security problem privately, through [GitHub's vulnerability reporting](https://github.com/dovvnloading/Auvra/security/advisories/new), rather than in a public issue.

Say what is affected and how to reproduce it. A project or level that shows the problem helps the most.

## What is in scope

Only the `main` branch is supported. These matter most, because they handle what the person using Auvra did not write themselves:

- Opening a project, or a built game, from someone else
- Importing models, textures and other assets
- Plugins and their sandbox
- AI providers: API keys and what is sent to them
- The local host and its protocol between the editor and the machine

A project's own scripts and blueprints run with the access the engine gives them. A way for them to get more than that is in scope.

## How problems are found

Pull requests run CodeQL, and Dependabot watches the npm, Python, Rust and GitHub Actions dependencies.
