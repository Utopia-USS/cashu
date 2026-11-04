// Pure, host-independent parts of the desktop shell. The Electron wiring is main.ts (the app entry).
export const PACKAGE_NAME = "@cashu/desktop";
export * from "./app.js";
export * from "./config.js";
export * from "./deeplink.js";
export * from "./hostLaunch.js";
export * from "./hostRelay.js";
export * from "./links.js";
export * from "./notify.js";
export * from "./pages.js";
export * from "./security.js";
export * from "./state.js";
export * from "./strings.js";
export * from "./tray.js";
export * from "./window.js";
