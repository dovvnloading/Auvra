# Editor frontend

This directory contains Auvra's current React and TypeScript editor.

The supported development entry point is the Python launcher at the repository
root:

```powershell
python Auvra/Auvra.py
```

It validates Python, Node.js, npm, and the committed lockfile; installs only
when the dependency state is missing or stale; and owns the development-server
process tree. It binds to `127.0.0.1` and does not open a browser.

For direct frontend diagnosis, use the manual fallback from this directory:

```powershell
npm ci
npm run dev
```

The supported frontend runtimes are Node.js 22.12+ on the Node 22 LTS line or
Node.js 24, with npm 10 or 11.

Create a production bundle with:

```powershell
npm run build
```

Repository status, licensing, and contribution guidance are documented in the
root [README](../README.md).
