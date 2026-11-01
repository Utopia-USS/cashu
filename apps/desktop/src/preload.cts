/// <reference types="node" />
// Sandboxed preload (CommonJS: a sandboxed preload cannot be an ES module).
//
// TRANSITIONAL(S55z): `window.pywebview.api.token()` is a shim for the unmodified legacy SPA
// (frontend/src/core/token.ts asks it, and `"pywebview" in window` tells it that it runs in the
// desktop window); TS screens use the typed preload bridge (S55a) and S55z removes the shim with the SPA. Until then it is exposed only when
// the main process confirms (from the sending frame's URL, not from anything the page says) that
// this frame shows the app's own origin, and the token itself is again checked on every call.
import electron = require("electron");

/** The page's window as this preload uses it (the shell's tsconfig has no DOM lib). */
interface PageWindow {
  addEventListener(
    type: "message",
    listener: (event: { readonly source: unknown; readonly data: unknown }) => void,
  ): void;
  postMessage(message: unknown, targetOrigin: string, transfer: unknown[]): void;
  readonly location: { readonly origin: string };
}

if (electron.ipcRenderer.sendSync("cashu:bridge-allowed") === true) {
  electron.contextBridge.exposeInMainWorld("pywebview", {
    api: {
      token: (): Promise<string | null> => electron.ipcRenderer.invoke("cashu:token"),
    },
  });

  // Store port (TRANSITIONAL(S55a): the main process answers only with
  // CASHU_DESKTOP_STORE=1). A MessagePort cannot cross the context bridge, so the page asks with
  // `window.postMessage({ cashu: "store-port-request" })` and receives the port the same way, from
  // this frame's own origin; the main process checks the sending frame again before it routes a port.
  const page = (globalThis as { window?: PageWindow }).window;
  page?.addEventListener("message", (event) => {
    const data = event.data as { cashu?: unknown } | null;
    if (event.source !== page || data?.cashu !== "store-port-request") return;
    electron.ipcRenderer.send("cashu:store-port");
  });
  electron.ipcRenderer.on("cashu:store-port", (event) => {
    page?.postMessage({ cashu: "store-port" }, page.location.origin, [...event.ports]);
  });
}
