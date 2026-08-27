/// <reference path="./webview2.d.ts" />

import { FakeHost } from "./fakeHost";
import { NativeHostTransport } from "./nativeTransport";
import type { HostTransport } from "./transport";

let singleton: HostTransport | undefined;

/** Create the one narrow UI-facing host connection before React mounts. */
export function bootstrapHostTransport(): HostTransport {
  if (singleton) return singleton;
  const webview = window.chrome?.webview;
  if (webview) {
    singleton = new NativeHostTransport(webview);
    return singleton;
  }
  const isDevelopment = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
  if (isDevelopment) {
    singleton = new FakeHost();
    return singleton;
  }
  throw new Error("Auvra requires the packaged WebView2 host");
}

export function getHostTransport(): HostTransport {
  if (!singleton) throw new Error("Host transport has not been bootstrapped");
  return singleton;
}
