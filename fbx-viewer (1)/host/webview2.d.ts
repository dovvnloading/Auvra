/** Minimal WebView2 DOM surface. The native host is the only bridge authority. */
interface WebView2MessageEvent extends Event {
  readonly data: unknown;
}

interface WebView2Host {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: WebView2MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: WebView2MessageEvent) => void): void;
}

interface Window {
  chrome?: {
    readonly webview?: WebView2Host;
  };
}
