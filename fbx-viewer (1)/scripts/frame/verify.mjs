import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const files = {
  index: resolve(root, "index.html"),
  hud: resolve(root, "hud-frame.html"),
  hudScript: resolve(root, "hud-frame.tsx"),
  dynamic: resolve(root, "components/HUDEditor/DynamicHUDComponent.tsx"),
  transport: resolve(root, "host/nativeTransport.ts"),
  protocol: resolve(root, "host/protocol.ts"),
  bootstrap: resolve(root, "host/bootstrap.ts"),
  vite: resolve(root, "vite.config.ts"),
  styles: resolve(root, "styles.css"),
  scope: resolve(root, "components/HUDEditor/assets/ScopeReticle.tsx"),
  texture: resolve(root, "components/UI/Browser/TextureCard.tsx"),
  retexture: resolve(root, "components/Tools/RetextureTool.tsx"),
  localEnvironment: resolve(root, "components/Scene/LocalEnvironment.tsx"),
  viewerScene: resolve(root, "components/Scene/ViewerScene.tsx"),
  graphPreview: resolve(root, "components/AnimationGraph/GraphPreview.tsx"),
  retextureEditor: resolve(root, "components/Tools/RetextureEditor.tsx"),
  thumbnailTooltip: resolve(root, "components/UI/ThumbnailTooltip.tsx"),
  skySystem: resolve(root, "components/Environment/SkySystem.tsx"),
  packageJson: resolve(root, "package.json"),
  packageLock: resolve(root, "package-lock.json"),
  postcss: resolve(root, "postcss.config.cjs"),
  tailwind: resolve(root, "tailwind.config.cjs"),
};

const source = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [name, await readFile(file, "utf8")] )));
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

for (const [name, text] of Object.entries(source)) {
  if (name !== "packageLock") check(!/https?:\/\/(?!127\.0\.0\.1)/i.test(text), `${name} contains a remote URL`);
}
check(!source.index.includes("cdn.tailwindcss.com"), "editor still references Tailwind CDN");
check(source.index.includes("__AUVRA_EDITOR_CSP__"), "editor CSP placeholder missing");
check(source.hud.includes("__AUVRA_HUD_CSP__"), "HUD CSP placeholder missing");
check(source.vite.includes("'unsafe-eval'") && source.vite.includes("connect-src 'none'"), "HUD CSP does not confine evaluation and network access");
check(source.vite.includes("cspNonce"), "Vite CSP nonce integration is missing");
check(!/127\.0\.0\.1:\*/.test(source.vite), "development CSP grants unrelated loopback ports");
check(source.vite.includes("httpServer?.address()") && source.vite.includes("editorDevCsp(address.port, developmentNonce)"), "development CSP is not bound to the actual Vite listener");
check(source.dynamic.includes('sandbox="allow-scripts"'), "HUD iframe is not sandboxed");
check(!/sandbox\s*=\s*["'][^"']*allow-same-origin/i.test(source.dynamic), "HUD iframe grants same-origin access");
check(!source.dynamic.includes("srcDoc"), "HUD iframe still uses srcDoc");
check(source.dynamic.includes("MessageChannel"), "HUD iframe does not use MessageChannel");
check((source.dynamic.match(/postMessage\([^;]+,\s*["']\*["']/g) ?? []).length === 1, "HUD transfer is not one-shot");
check(source.dynamic.includes("[channel.port2]"), "HUD transfer does not transfer a MessagePort");
check(source.hudScript.includes("event.source !== window.parent"), "HUD bootstrap lacks source check");
check(source.hudScript.includes("window.removeEventListener(\"message\", receiveMessage)"), "HUD bootstrap listener is not torn down");
check(source.transport.includes("isValidMessage"), "native transport does not validate inbound messages");
check(source.transport.includes("assertRequest") && source.transport.includes("MAX_PENDING"), "native transport lacks outbound validation/bounds");
check(source.transport.includes("setTimeout") && source.transport.includes("clearTimeout"), "native transport lacks timeout cleanup");
check(source.transport.includes("postMessage"), "native transport lacks native postMessage");
check(!source.transport.includes("eval(") && !source.transport.includes("new Function"), "native transport exposes dynamic evaluation");
check(!/\b(eval|Function|require)\s*\(/.test(source.protocol), "browser protocol validator exposes dynamic evaluation or require");
check(source.bootstrap.includes("isDevelopment") && source.bootstrap.includes("FakeHost"), "development FakeHost fallback is not explicit");
check(source.bootstrap.includes("requires the packaged WebView2 host"), "production fallback does not fail closed");
check(source.vite.includes("hud-frame.html") && !source.vite.includes("@tailwindcss/vite"), "Vite still uses the rejected Tailwind 4 plugin");
check(source.styles.includes("@tailwind base") && source.styles.includes("@tailwind utilities"), "local Tailwind 3 directives are missing");
check(source.packageJson.includes('"tailwindcss": "3.4.17"') && source.packageJson.includes('"postcss": "8.5.26"') && source.packageJson.includes('"autoprefixer": "10.4.21"'), "pinned Tailwind 3/PostCSS pipeline is missing");
check(!source.packageJson.includes("@tailwindcss/vite") && !source.packageLock.includes('"node_modules/@tailwindcss/'), "rejected Tailwind 4 packages remain");
check(!source.packageLock.includes('"node_modules/lightningcss":') && !source.packageLock.includes('"node_modules/@tailwindcss/oxide'), "rejected MPL/native Tailwind closure remains");
check(source.postcss.includes("tailwindcss") && source.postcss.includes("autoprefixer"), "PostCSS config is incomplete");
check(source.tailwind.includes("content") && source.tailwind.includes("tsx"), "Tailwind content globs are missing");
check(source.tailwind.includes("750: '#333333'") && source.tailwind.includes("850: '#1f1f1f'"), "local Tailwind config lost the editor's custom gray palette");
check(source.scope.includes("reticle-noise"), "scope reticle lacks local noise replacement");
check(source.texture.includes("<button") && !source.texture.includes('target="_blank"'), "texture card retains popup behavior");
check(source.retexture.includes("texture-preview-surface"), "retexture preview lacks local surface");
const environmentSites = ["localEnvironment", "viewerScene", "graphPreview", "retextureEditor", "thumbnailTooltip", "skySystem"];
for (const name of environmentSites) {
  check(!/<Environment\s+preset\b|\bpreset\s*=|Drei.*preset|environment-assets/i.test(source[name]), `${name} retains preset-based environment resolution`);
  check(!/https?:\/\/(?!127\.0\.0\.1)|cdn\.tailwind|esm\.sh/i.test(source[name]), `${name} contains a remote render dependency`);
}
check(source.localEnvironment.includes("<Lightformer") && source.localEnvironment.includes("frames={1}"), "local procedural environment is missing deterministic Lightformer content");
check(source.localEnvironment.includes("export const LocalEnvironment"), "reusable local environment component is missing");
for (const name of environmentSites.slice(1)) check(source[name].includes("LocalEnvironment"), `${name} is missing the local environment replacement`);
check(source.skySystem.includes("<LocalEnvironment night={isNight}"), "SkySystem no longer distinguishes day and night lighting");
check(source.dynamic.indexOf("new TextEncoder().encode(code)") < source.dynamic.indexOf("Babel.transform"), "HUD source size is not checked before Babel");
check(source.dynamic.includes("try {\n      port.postMessage(message);") && source.dynamic.includes("could not be transferred"), "HUD non-cloneable props are not safely contained");
check(source.hudScript.includes("event.ports.length !== 1") && source.hudScript.includes("candidate.nonce === nonce"), "HUD port handshake lacks strict port/nonce binding");
check((source.hudScript.match(/window\.addEventListener\(["']message["']/g) ?? []).length === 1, "HUD bootstrap has a reusable window message listener");

async function runTransportTests() {
  const temporary = await mkdtemp(join(tmpdir(), "auvra-frame-"));
  try {
    const output = join(temporary, "nativeTransport.mjs");
    const esbuild = resolve(root, "node_modules/esbuild/bin/esbuild");
    const result = spawnSync(process.execPath, [esbuild, "host/nativeTransport.ts", "--bundle", "--platform=browser", "--format=esm", `--outfile=${output}`], { cwd: root, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(`transport bundle failed: ${result.stderr || result.stdout}`);
    const { NativeHostTransport } = await import(`${pathToFileURL(output).href}?frame-tests=${Date.now()}`);
    const session = { protocol: "auvra.host/1", type: "session", session: "test-session", revision: 0, status: "active" };
    const request = { protocol: "auvra.host/1", type: "request", id: "request-1", session: "test-session", revision: 0, method: "host.ping", payload: {} };
    class FakeWebView {
      listeners = new Set();
      sent = [];
      postMessage(message) { this.sent.push(message); }
      addEventListener(_type, listener) { this.listeners.add(listener); }
      removeEventListener(_type, listener) { this.listeners.delete(listener); }
      emit(data) { for (const listener of this.listeners) listener({ data }); }
    }
    const expectReject = async (promise, label) => { let rejected = false; try { await promise; } catch { rejected = true; } if (!rejected) throw new Error(`${label} did not reject`); };
    const makeTransport = () => { const wire = new FakeWebView(); const transport = new NativeHostTransport(wire, { timeoutMs: 25 }); wire.emit(session); return { wire, transport }; };
    const responseFor = (id, sessionId = session.session, revision = 0) => ({ protocol: "auvra.host/1", type: "response", id, session: sessionId, revision, ok: true, result: { pong: true } });
    const assertClosedAfter = async (label, emitInvalid) => {
      const { wire, transport } = makeTransport();
      const pending = transport.request({ ...request, id: `${label}-pending` });
      emitInvalid(wire);
      await expectReject(pending, label);
      await expectReject(transport.request({ ...request, id: `${label}-followup` }), `${label} close`);
    };

    { // authoritative session handshake and correlated success
      const { wire, transport } = makeTransport();
      const ready = await transport.ready();
      if (ready.session !== session.session || transport.session !== session.session) throw new Error("session handshake failed");
      const rejectedOutbound = transport.request({ ...request, id: "oversized-outbound", payload: { "unexpected": "x" } });
      await expectReject(rejectedOutbound, "invalid outbound request");
      if (wire.sent.length !== 0) throw new Error("invalid outbound request reached native channel");
      const pending = transport.request(request);
      await expectReject(transport.request(request), "duplicate outbound id");
      wire.emit(responseFor(request.id));
      if (!(await pending).ok) throw new Error("success response was not correlated");
      transport.close();
    }
    { // malformed, oversized, and duplicate/late messages fail closed
      const { wire, transport } = makeTransport();
      const pending = transport.request({ ...request, id: "request-2" });
      wire.emit({ nope: true });
      await expectReject(pending, "malformed response");
      await expectReject(transport.request({ ...request, id: "request-after-malformed" }), "malformed message follow-up");
      const second = makeTransport();
      const successful = second.transport.request({ ...request, id: "request-3" });
      second.wire.emit({ protocol: "auvra.host/1", type: "response", id: "request-3", session: session.session, revision: 0, ok: true, result: { pong: true } });
      await successful;
      second.wire.emit({ protocol: "auvra.host/1", type: "response", id: "request-3", session: session.session, revision: 0, ok: true, result: { pong: true } });
      await expectReject(second.transport.request({ ...request, id: "request-4" }), "late response follow-up");
      const oversized = makeTransport();
      oversized.wire.emit("x".repeat(256 * 1024 + 1));
      if (oversized.transport.session !== session.session) throw new Error("oversized message unexpectedly replaced session");
      await expectReject(oversized.transport.ready(), "oversized message close");
    }
    { // wrong session, stale revision, and unknown message type all close
      await assertClosedAfter("wrong-session", (wire) => wire.emit(responseFor("wrong-session-pending", "other-session")));
      const stale = makeTransport();
      stale.wire.emit({ protocol: "auvra.host/1", type: "event", event: "host.revision", session: session.session, revision: 1, payload: {} });
      const stalePending = stale.transport.request({ ...request, id: "stale-revision-pending", revision: 1 });
      stale.wire.emit(responseFor("stale-revision-pending", session.session, 0));
      await expectReject(stalePending, "stale revision");
      await assertClosedAfter("unknown-type", (wire) => wire.emit({ protocol: "auvra.host/1", type: "unknown", payload: {} }));
    }
    { // valid event/revision flow, throwing subscribers, and bounded IDs
      const { wire, transport } = makeTransport();
      const events = [];
      transport.subscribe((event) => events.push(event.event));
      wire.emit({ protocol: "auvra.host/1", type: "event", event: "host.revision", session: session.session, revision: 1, payload: {} });
      if (transport.currentRevision !== 1 || !events.includes("host.revision")) throw new Error("valid revision flow failed");
      const flow = transport.request({ ...request, id: "revision-flow", revision: 1 });
      wire.emit(responseFor("revision-flow", session.session, 1));
      await flow;
      for (let index = 0; index < 260; index += 1) {
        const id = `bounded-${index}`;
        const pending = transport.request({ ...request, id, revision: 1 });
        wire.emit(responseFor(id, session.session, 1));
        await pending;
      }
      if (transport.completed.size > 256 || transport.completed.has("bounded-0")) throw new Error("completed request retention is not bounded/evicting");
      const evictedReuse = transport.request({ ...request, id: "bounded-0", revision: 1 });
      wire.emit(responseFor("bounded-0", session.session, 1));
      await evictedReuse;
      transport.close();
      const subscriberFailure = makeTransport();
      subscriberFailure.transport.subscribe(() => { throw new Error("subscriber detail"); });
      let escaped = false;
      try { subscriberFailure.wire.emit({ protocol: "auvra.host/1", type: "event", event: "host.revision", session: session.session, revision: 1, payload: {} }); } catch { escaped = true; }
      if (escaped) throw new Error("throwing subscriber escaped native callback");
      await expectReject(subscriberFailure.transport.request({ ...request, id: "subscriber-followup" }), "subscriber failure close");
    }
    { // timeout, close rejection, and failed session replacement
      const noSessionWire = new FakeWebView();
      const noSession = new NativeHostTransport(noSessionWire, { timeoutMs: 25 });
      const readyWithoutSession = noSession.ready();
      await expectReject(readyWithoutSession, "session readiness timeout");
      const closeReady = new NativeHostTransport(new FakeWebView(), { timeoutMs: 500 });
      const readyBeforeClose = closeReady.ready();
      closeReady.close();
      await expectReject(readyBeforeClose, "close ready rejection");
      noSession.close();
      const timeout = makeTransport();
      await expectReject(timeout.transport.request({ ...request, id: "request-5" }), "request timeout");
      timeout.wire.emit(responseFor("request-5"));
      await expectReject(timeout.transport.request({ ...request, id: "request-5-followup" }), "late timeout response close");
      const closed = makeTransport();
      const pending = closed.transport.request({ ...request, id: "request-6" });
      closed.transport.close();
      await expectReject(pending, "close");
      const throwingWire = new (class extends closed.wire.constructor { postMessage() { throw new Error("sensitive native detail"); } })();
      const throwing = new NativeHostTransport(throwingWire, { timeoutMs: 25 });
      throwingWire.emit(session);
      let postMessageRejected = false;
      try { await throwing.request({ ...request, id: "request-7" }); } catch (error) {
        postMessageRejected = true;
        if (error instanceof Error && error.message.includes("sensitive native detail")) throw new Error("native exception detail leaked");
      }
      if (!postMessageRejected) throw new Error("postMessage failure did not reject");
      const replacement = makeTransport();
      replacement.wire.emit({ ...session, session: "other-session" });
      await expectReject(replacement.transport.ready(), "session replacement");
    }
    return true;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  try {
    await runTransportTests();
    console.log(`Frame invariants and transport tests passed (${Object.keys(source).length} files checked)`);
  } catch (error) {
    console.error(`FAIL: transport test harness: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
