/// <reference types="node" />
// Sandboxed preload (CommonJS: a sandboxed preload cannot be an ES module).
//
// TRANSITIONAL(S36): `window.pywebview.api.token()` is a shim for the unmodified legacy SPA
// (frontend/src/core/token.ts asks it, and `"pywebview" in window` tells it that it runs in the
// desktop window); S36 replaces it with the typed preload bridge. Until then it is exposed only when
// the main process confirms (from the sending frame's URL, not from anything the page says) that
// this frame shows the app's own origin, and the token itself is again checked on every call.
import electron = require("electron");

if (electron.ipcRenderer.sendSync("cashu:bridge-allowed") === true) {
  electron.contextBridge.exposeInMainWorld("pywebview", {
    api: {
      token: (): Promise<string | null> => electron.ipcRenderer.invoke("cashu:token"),
    },
  });
}
