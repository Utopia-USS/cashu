import { describe, expect, it } from "vitest";
import { DesktopApp, type DesktopDeps, type TrayHandle, type WindowHandle } from "./app.js";
import type { TrayAction, TrayItem } from "./tray.js";

const ENTRY = "app://cashu/index.html";

class FakeWindow implements WindowHandle {
  url = "";
  loaded: string[] = [];
  calls: string[] = [];
  minimized = false;
  failLoad = false;
  private closeHandler: ((prevent: () => void) => void) | null = null;
  private closedHandler: () => void = () => {};
  currentUrl() {
    return this.url;
  }
  async loadUrl(url: string) {
    this.loaded.push(url);
    if (this.failLoad) {
      this.failLoad = false;
      throw new Error("native renderer unavailable");
    }
    this.url = url;
  }
  async setHash(hash: string) {
    this.calls.push(`hash ${hash}`);
  }
  show() {
    this.calls.push("show");
  }
  focus() {
    this.calls.push("focus");
  }
  restore() {
    this.minimized = false;
    this.calls.push("restore");
  }
  hide() {
    this.calls.push("hide");
  }
  isMinimized() {
    return this.minimized;
  }
  onClose(handler: (prevent: () => void) => void) {
    this.closeHandler = handler;
  }
  onClosed(handler: () => void) {
    this.closedHandler = handler;
  }
  destroy() {
    this.calls.push("destroy");
    this.closedHandler();
  }
  userClose(): boolean {
    let prevented = false;
    this.closeHandler?.(() => {
      prevented = true;
    });
    if (!prevented) this.closedHandler();
    return !prevented;
  }
}

function setup(overrides: Partial<DesktopDeps> = {}) {
  const window = new FakeWindow();
  const events: string[] = [];
  let trayActions: ((action: TrayAction) => void) | null = null;
  let trayItemsSeen: TrayItem[] = [];
  const tray: TrayHandle = { destroy: () => events.push("tray destroyed") };
  const app = new DesktopApp({
    staticEntry: ENTRY,
    recoveryEntry: `${ENTRY}?recovery=1`,
    recovering: () => false,
    lang: "en",
    logFile: "/tmp/synthetic/electron.log",
    hasSingleInstanceLock: true,
    closeToTray: false,
    createWindow: (loadingUrl) => {
      window.loaded.push(loadingUrl);
      return window;
    },
    createTray: (items, onAction) => {
      trayItemsSeen = items;
      trayActions = onAction;
      return tray;
    },
    quit: () => events.push("quit"),
    ...overrides,
  });
  return {
    app,
    window,
    events,
    tray: () => ({ items: trayItemsSeen, act: (a: TrayAction) => trayActions?.(a) }),
  };
}

describe("native desktop window", () => {
  it("loads the native renderer after a loading page", async () => {
    const { app, window } = setup();
    expect(await app.start()).toBe("started");
    expect(window.loaded).toHaveLength(2);
    expect(window.loaded[0]).toContain("data:text/html");
    expect(window.loaded[1]).toBe(ENTRY);
    expect(app.origin).toBe(ENTRY);
    expect(app.error).toBeNull();
  });

  it("loads the recovery screen instead while main is recovering, and the app after a retry", async () => {
    let recovering = true;
    const { app, window } = setup({ recovering: () => recovering });
    expect(await app.start("cashu://review/demo-anna")).toBe("started");
    expect(window.loaded[1]).toBe(`${ENTRY}?recovery=1`);
    expect(app.exposesBridgeTo(`${ENTRY}?recovery=1`)).toBe(true);
    await app.restart();
    expect(window.loaded.at(-1)).toBe(`${ENTRY}?recovery=1`);
    recovering = false;
    await app.restart();
    expect(window.loaded.at(-1)).toBe(ENTRY);
  });

  it("shows the recovery screen in the open window when a host failure is found", async () => {
    const { app, window } = setup();
    await app.start();
    window.calls.length = 0;
    await app.showRecovery();
    expect(window.loaded.at(-1)).toBe(`${ENTRY}?recovery=1`);
    expect(window.calls).toEqual(["show"]);
  });

  it("opens a pending link in the native renderer", async () => {
    const { app, window } = setup();
    await app.start("cashu://review/demo-anna");
    expect(window.loaded[1]).toBe(`${ENTRY}#/demo-anna/investments.portfolio/?review=1`);
  });

  it("shows an error page when the renderer cannot load", async () => {
    const { app, window } = setup({
      createWindow: (loadingUrl) => {
        window.loaded.push(loadingUrl);
        window.failLoad = true;
        return window;
      },
    });
    expect(await app.start()).toBe("failed");
    expect(app.error).toBe("native renderer unavailable");
    expect(decodeURIComponent(window.loaded.at(-1) ?? "")).toContain("cashU could not start");
  });

  it("exposes native bridges only to app origin", async () => {
    const { app } = setup();
    expect(app.exposesBridgeTo("app://cashu/index.html")).toBe(true);
    expect(app.exposesBridgeTo("data:text/html,loading")).toBe(false);
    expect(app.exposesBridgeTo("https://evil.example/")).toBe(false);
    expect(app.exposesBridgeTo(null)).toBe(false);
  });
});

describe("single instance and shutdown", () => {
  it("a second launch without the lock opens no window", async () => {
    let windows = 0;
    const { app } = setup({
      hasSingleInstanceLock: false,
      createWindow: () => {
        windows++;
        return new FakeWindow();
      },
    });
    expect(await app.start()).toBe("already-running");
    expect(windows).toBe(0);
  });

  it("fronts the window and opens a second-instance link", async () => {
    const { app, window } = setup();
    await app.start();
    window.minimized = true;
    app.secondInstance(["Electron", ".", "cashu://investments/demo-anna"]);
    await new Promise((done) => setTimeout(done, 0));
    expect(window.calls.slice(0, 3)).toEqual(["restore", "show", "focus"]);
    expect(window.calls).toContain("hash #/demo-anna/investments.portfolio");
  });

  it("closing quits and shutdown destroys the tray once", async () => {
    const { app, window, events } = setup();
    await app.start();
    expect(window.userClose()).toBe(true);
    expect(events).toContain("quit");
    await Promise.all([app.shutdown(), app.shutdown()]);
    expect(events.filter((event) => event === "tray destroyed")).toHaveLength(1);
  });

  it("a quit destroys the open window instead of asking the page to close", async () => {
    const { app, window, events } = setup();
    await app.start();
    await Promise.all([app.shutdown(), app.shutdown()]);
    expect(window.calls.filter((call) => call === "destroy")).toHaveLength(1);
    expect(events.filter((event) => event === "quit")).toHaveLength(0);
  });

  it("close-to-tray hides until an explicit quit", async () => {
    const { app, window, events } = setup({ closeToTray: true });
    await app.start();
    expect(window.userClose()).toBe(false);
    expect(window.calls).toContain("hide");
    expect(events).not.toContain("quit");
    app.requestQuit();
    expect(window.userClose()).toBe(true);
  });
});

describe("tray", () => {
  it("opens the window and quits from the menu", async () => {
    const { app, window, events, tray } = setup();
    await app.start();
    expect(tray().items.map((item) => ("label" in item ? item.label : "-"))).toEqual([
      "Open cashU",
      "-",
      "Quit cashU",
    ]);
    window.minimized = true;
    tray().act("open");
    expect(window.calls).toEqual(["restore", "show", "focus"]);
    tray().act("quit");
    expect(events).toContain("quit");
  });
});
