// What the window shell does differently per OS, as pure decisions main.ts applies: where the running
// packaged build sits, the application menu, the tray icon and the Windows taskbar identity. macOS keeps
// exactly the shell it had; Windows follows its own conventions (no app menu, the executable's icon in
// the notification area, a click on it opens the window).
import { dirname, win32 } from "node:path";

/**
 * The packaged build this Electron main runs from, by path shape (readBundleIdentity verifies it):
 * `<x>.app` three levels above `Contents/MacOS/cashU` on macOS, the install dir holding `cashU.exe`
 * on Windows (electron-builder NSIS, C5).
 */
export function runningBundle(execPath: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return win32.dirname(execPath);
  return dirname(dirname(dirname(execPath)));
}

/** The roles of the application menu's top-level entries. */
export type MenuRole = "appMenu" | "fileMenu" | "editMenu" | "viewMenu" | "windowMenu";

/**
 * The application menu, or null for none. macOS needs its menu bar (the app menu, and the Edit menu
 * that carries Cmd+C / Cmd+V). On Windows a single-window app shows no menu bar (Chromium handles
 * Ctrl+C / Ctrl+V / Ctrl+Z in text fields on its own, the tray and the window close quit); a debug run
 * keeps the menus for the View role's reload and developer tools. Linux keeps the shell it had.
 */
export function applicationMenuRoles(
  platform: NodeJS.Platform,
  debug: boolean,
): readonly MenuRole[] | null {
  if (platform === "win32")
    return debug ? ["fileMenu", "editMenu", "viewMenu", "windowMenu"] : null;
  return ["appMenu", "editMenu", ...(debug ? (["viewMenu"] as const) : []), "windowMenu"];
}

/** Where the tray icon comes from. */
export type TrayIconSource =
  | { readonly kind: "png"; readonly size: number }
  | { readonly kind: "executable" };

/**
 * The tray icon: the checkout's PNG at the platform's tray size (18 px menu bar on macOS, 16 px
 * notification area on Windows). A packaged Windows app has no such PNG; it uses its executable's own
 * icon, which electron-builder embeds in cashU.exe (`app.getFileIcon`, small = 16 px), so no extra
 * file ships for it.
 */
export function trayIconSource(platform: NodeJS.Platform, pngExists: boolean): TrayIconSource {
  if (platform === "win32") return pngExists ? { kind: "png", size: 16 } : { kind: "executable" };
  return { kind: "png", size: 18 };
}

/** Windows convention: a click on the notification area icon opens the app (the menu is right click). */
export function trayOpensOnClick(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

/**
 * The Windows App User Model ID: the bundle ID, the one electron-builder writes into the Start menu
 * and desktop shortcuts, so the running window groups with its taskbar pin (and later toasts resolve
 * to it). Null elsewhere.
 */
export function appUserModelId(platform: NodeJS.Platform, bundleId: string): string | null {
  return platform === "win32" ? bundleId : null;
}
