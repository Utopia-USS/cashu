/// <reference types="node" />
// Sandboxed preload (CommonJS: a sandboxed preload cannot be an ES module).
//
// Strangler v1: the unmodified SPA asks `window.pywebview.api.token()` (frontend/src/core/token.ts)
// and checks `"pywebview" in window` to know it runs in the desktop window. This bridge answers
// exactly that one call; the main process hands out the token only to the app's own origin.
import electron = require("electron");

electron.contextBridge.exposeInMainWorld("pywebview", {
  api: {
    token: (): Promise<string | null> => electron.ipcRenderer.invoke("cashu:token"),
  },
});
