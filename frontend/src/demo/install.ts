// Demo mode: routes the dashboard's /api traffic (fetch, the run event stream
// and download links) to the in-browser DemoServer instead of a real server.
import recordingUrl from "./recording.json?url";
import seed from "./seed.json";
import { DemoServer, type DemoResponse } from "./server";
import type { DemoRecording, DemoSeed } from "./types";

export let demoServer: DemoServer;

const isApi = (url: URL) => url.origin === window.location.origin && url.pathname.startsWith("/api/");

export async function installDemo(): Promise<DemoServer> {
  const realFetch = window.fetch.bind(window);
  const recording = (await (await realFetch(recordingUrl)).json()) as DemoRecording;
  demoServer = new DemoServer(recording, seed as unknown as DemoSeed);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (!isApi(url)) return realFetch(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    return toResponse(await demoServer.handle(method, url.pathname + url.search, body));
  };

  const RealEventSource = window.EventSource;
  window.EventSource = class extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly url: string = "";
    readonly withCredentials = false;
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    private unsubscribe?: () => void;

    constructor(url: string | URL, init?: EventSourceInit) {
      super();
      const target = new URL(String(url), window.location.href);
      const match = /^\/api\/runs\/([^/]+)\/events$/.exec(target.pathname);
      if (!isApi(target) || !match) return new RealEventSource(url, init) as never;
      this.url = target.href;
      // Handlers are attached after construction, so start on the next tick.
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.onopen?.(new Event("open"));
        this.unsubscribe = demoServer.subscribe(decodeURIComponent(match[1]!), (e) => {
          const msg = new MessageEvent("message", { data: JSON.stringify(e) });
          this.onmessage?.(msg);
          this.dispatchEvent(msg);
        });
      }, 0);
    }

    close() {
      this.readyState = 2;
      this.unsubscribe?.();
    }
  } as unknown as typeof EventSource;

  // Download links (report.md, report exports, snapshots) point at /api too.
  document.addEventListener(
    "click",
    (event) => {
      const link = (event.target as Element | null)?.closest?.("a[href]");
      const href = link?.getAttribute("href");
      if (!href || !href.startsWith("/api/")) return;
      event.preventDefault();
      void demoServer.handle("GET", href).then(download);
    },
    true,
  );

  return demoServer;
}

function toResponse(res: DemoResponse): Response {
  if (res.text !== undefined) return new Response(res.text, { status: res.status, headers: { "content-type": res.contentType ?? "text/plain" } });
  return new Response(JSON.stringify(res.body ?? {}), { status: res.status, headers: { "content-type": "application/json" } });
}

function download(res: DemoResponse) {
  if (res.text === undefined) {
    window.alert((res.body as { error?: string } | undefined)?.error ?? `Download failed (${res.status})`);
    return;
  }
  const url = URL.createObjectURL(new Blob([res.text], { type: res.contentType ?? "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = res.filename ?? "download.txt";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
