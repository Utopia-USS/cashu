/// <reference types="node" />
// Sandboxed preload (CommonJS: a sandboxed preload cannot be an ES module).
//
const electron: typeof import("electron") = require("electron");

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
  electron.contextBridge.exposeInMainWorld("cashuService", {
    status: (): Promise<unknown> => electron.ipcRenderer.invoke("cashu:service-status"),
    setEnabled: (enabled: boolean): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:service-set-enabled", enabled),
  });
  electron.contextBridge.exposeInMainWorld("cashuCreation", {
    prepare: (input: unknown): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:creation-prepare", input),
    commit: (input: unknown): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:creation-commit", input),
    inspect: (input: unknown): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:creation-inspect", input),
    current: (): Promise<unknown> => electron.ipcRenderer.invoke("cashu:creation-current", {}),
  });
  electron.contextBridge.exposeInMainWorld("cashuDevices", {
    list: (input: unknown): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:devices-list", input),
    revokePreview: (input: unknown): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:devices-revokePreview", input),
    revokeCommit: (input: unknown): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:devices-revokeCommit", input),
    revokeInspect: (input: unknown): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:devices-revokeInspect", input),
    revokeCancel: (input: unknown): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:devices-revokeCancel", input),
    leaderPreview: (input: unknown): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:devices-leaderPreview", input),
    leaderCommit: (input: unknown): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:devices-leaderCommit", input),
    leaderInspect: (input: unknown): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:devices-leaderInspect", input),
  });
  electron.contextBridge.exposeInMainWorld("cashuConnectors", {
    installPending: (): Promise<unknown> => electron.ipcRenderer.invoke("cashu:connectors-install"),
  });
  electron.contextBridge.exposeInMainWorld("cashuBanking", {
    chooseKeyAndConfigure: (vaultId: string, appId: string): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:banking-configure", { vaultId, appId }),
    openBank: (vaultId: string, url: string): Promise<void> =>
      electron.ipcRenderer.invoke("cashu:banking-open", { vaultId, url }),
  });
  electron.contextBridge.exposeInMainWorld("cashuPairing", {
    invite: (input: unknown): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:pairing-invite", input),
    confirm: (input: unknown): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:pairing-confirm", input),
    inspect: (input: unknown): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:pairing-inspect", input),
    cancel: (input: unknown): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:pairing-cancel", input),
  });
  electron.contextBridge.exposeInMainWorld("cashuNotifications", {
    status: (): Promise<unknown> => electron.ipcRenderer.invoke("cashu:notifications-status"),
    requestPermission: (): Promise<unknown> =>
      electron.ipcRenderer.invoke("cashu:notifications-request-permission"),
    onPending: (handler: () => void) => {
      const listener = () => handler();
      electron.ipcRenderer.on("cashu:notification-pending", listener);
      return () => electron.ipcRenderer.removeListener("cashu:notification-pending", listener);
    },
    onTarget: (handler: (target: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, target: unknown) => handler(target);
      electron.ipcRenderer.on("cashu:notification-target", listener);
      electron.ipcRenderer.send("cashu:notification-ready");
      return () => electron.ipcRenderer.removeListener("cashu:notification-target", listener);
    },
  });
  // Store port: the renderer's store channel, which the main process relays to the local host. A
  // MessagePort cannot cross the context bridge, so the page asks with
  // `window.postMessage({ cashu: "store-port-request" })` and receives the port the same way, from
  // this frame's own origin; the main process checks the sending frame again before it opens a host
  // session for it.
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
