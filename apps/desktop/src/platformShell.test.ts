import { describe, expect, it } from "vitest";
import {
  applicationMenuRoles,
  appUserModelId,
  runningBundle,
  trayIconSource,
  trayOpensOnClick,
} from "./platformShell.js";

describe("the running packaged build", () => {
  it("is the .app three levels above the macOS executable", () => {
    expect(runningBundle("/Applications/cashU.app/Contents/MacOS/cashU", "darwin")).toBe(
      "/Applications/cashU.app",
    );
  });

  it("is the install dir holding cashU.exe on Windows", () => {
    expect(runningBundle("C:\\Users\\x\\AppData\\Local\\Programs\\cashu\\cashU.exe", "win32")).toBe(
      "C:\\Users\\x\\AppData\\Local\\Programs\\cashu",
    );
  });
});

describe("the application menu", () => {
  it("keeps the macOS menu bar (and Linux's) as it was", () => {
    expect(applicationMenuRoles("darwin", false)).toEqual(["appMenu", "editMenu", "windowMenu"]);
    expect(applicationMenuRoles("darwin", true)).toEqual([
      "appMenu",
      "editMenu",
      "viewMenu",
      "windowMenu",
    ]);
    expect(applicationMenuRoles("linux", false)).toEqual(["appMenu", "editMenu", "windowMenu"]);
  });

  it("shows no menu bar on Windows, the standard menus in a debug run", () => {
    expect(applicationMenuRoles("win32", false)).toBeNull();
    expect(applicationMenuRoles("win32", true)).toEqual([
      "fileMenu",
      "editMenu",
      "viewMenu",
      "windowMenu",
    ]);
    expect(applicationMenuRoles("win32", true)).not.toContain("appMenu");
  });
});

describe("the tray", () => {
  it("draws the checkout PNG at the platform's tray size", () => {
    expect(trayIconSource("darwin", true)).toEqual({ kind: "png", size: 18 });
    expect(trayIconSource("darwin", false)).toEqual({ kind: "png", size: 18 });
    expect(trayIconSource("win32", true)).toEqual({ kind: "png", size: 16 });
  });

  it("uses the executable's own icon in a Windows package (no PNG ships)", () => {
    expect(trayIconSource("win32", false)).toEqual({ kind: "executable" });
  });

  it("opens the window on a click only on Windows", () => {
    expect(trayOpensOnClick("win32")).toBe(true);
    expect(trayOpensOnClick("darwin")).toBe(false);
    expect(trayOpensOnClick("linux")).toBe(false);
  });
});

it("names the Windows taskbar identity after the bundle ID, nothing elsewhere", () => {
  expect(appUserModelId("win32", "io.utopiasoft.cashu")).toBe("io.utopiasoft.cashu");
  expect(appUserModelId("darwin", "io.utopiasoft.cashu")).toBeNull();
});
