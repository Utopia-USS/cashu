import { describe, expect, it } from "vitest";
import {
  DesktopApp,
  type DesktopDeps,
  type SidecarLike,
  type TrayHandle,
  type WindowHandle,
} from "./app.js";
import type { SidecarInfo } from "./sidecar.js";
import type { TrayAction, TrayItem } from "./tray.js";

const INFO: SidecarInfo = {
  port: 51500,
  token: "tok_abcdefghijklmnopqrstuvwxyz0123",
  origin: "http://127.0.0.1:51500",
  url: "http://127.0.0.1:51500/",
  pid: 1,
};

class FakeWindow implements WindowHandle {
  url = "";
  loaded: string[] = [];
  calls: string[] = [];
  minimized = false;
  private closeHandler: ((prevent: () => void) => void) | null = null;
  private closedHandler: (() => void) | null = null;
  currentUrl() {
    return this.url;
  }
  async loadUrl(url: string) {
    this.loaded.push(url);
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
  userClose(): boolean {
    let prevented = false;
    this.closeHandler?.(() => {
      prevented = true;
    });
    if (!prevented) this.closedHandler?.();
    return !prevented;
  }
}

function setup(overrides: Partial<DesktopDeps> = {}, sidecarImpl?: Partial<SidecarLike>) {
  const window = new FakeWindow();
  const events: string[] = [];
  const remembered: number[] = [];
  let exitCallback: ((message: string) => void) | null = null;
  const sidecar: SidecarLike = {
    start: async () => INFO,
    stop: async () => {
      events.push("sidecar stopped");
    },
    ...sidecarImpl,
  };
  let trayActions: ((action: TrayAction) => void) | null = null;
  let trayItemsSeen: TrayItem[] = [];
  const tray: TrayHandle = { destroy: () => events.push("tray destroyed") };
  const app = new DesktopApp({
    lang: "en",
    logFile: "/tmp/data/logs/electron.log",
    hasSingleInstanceLock: true,
    closeToTray: false,
    createWindow: (loadingUrl) => {
      window.loaded.push(loadingUrl);
      return window;
    },
    createSidecar: (onExit) => {
      exitCallback = onExit;
      return sidecar;
    },
    createTray: (items, onAction) => {
      trayItemsSeen = items;
      trayActions = onAction;
      return tray;
    },
    quit: () => events.push("quit"),
    rememberPort: (port) => remembered.push(port),
    ...overrides,
  });
  return {
    app,
    window,
    events,
    remembered,
    tray: () => ({ items: trayItemsSeen, act: (a: TrayAction) => trayActions?.(a) }),
    sidecarExit: (m: string) => exitCallback?.(m),
  };
}

describe("opening the window (shell.run)", () => {
  it("shows a loading page, starts the sidecar, remembers the port and loads the dashboard", async () => {
    const { app, window, remembered } = setup();
    expect(await app.start()).toBe("started");
    expect(window.loaded).toHaveLength(2);
    expect(window.loaded[0]).toContain("data:text/html");
    expect(decodeURIComponent(window.loaded[0] ?? "")).toContain("Starting cashU");
    expect(window.loaded[1]).toBe(INFO.url);
    expect(remembered).toEqual([INFO.port]);
    expect(app.origin).toBe(INFO.origin);
    expect(app.error).toBeNull();
  });

  it("opens on the view of a link that launched the app", async () => {
    const { app, window } = setup();
    await app.start("cashu://review/demo-anna");
    expect(window.loaded[1]).toBe(`${INFO.url}#/demo-anna/investments.portfolio/?review=1`);
  });

  it("shows an error page when the sidecar fails to start (and stays open)", async () => {
    const { app, window, events } = setup(
      {},
      {
        start: async () => {
          throw new Error("The local server stopped during startup (exit 3): <boom>");
        },
      },
    );
    expect(await app.start()).toBe("failed");
    const shown = decodeURIComponent(window.loaded.at(-1) ?? "");
    expect(shown).toContain("cashU could not start");
    expect(shown).toContain("&lt;boom&gt;");
    expect(shown).toContain("electron.log");
    expect(app.error).toMatch(/exit 3/);
    expect(app.tokenFor(INFO.origin)).toBeNull(); // no token without a running sidecar
    await app.shutdown();
    expect(events).toContain("sidecar stopped");
  });

  it("shows the error page when the sidecar dies later", async () => {
    const { app, window, sidecarExit } = setup();
    await app.start();
    sidecarExit("The local server stopped unexpectedly (SIGKILL)");
    await new Promise((done) => setTimeout(done, 0));
    expect(decodeURIComponent(window.loaded.at(-1) ?? "")).toContain("stopped unexpectedly");
  });

  it("answers the token bridge for the app's own origin only", async () => {
    const { app } = setup();
    await app.start();
    expect(app.tokenFor(`${INFO.origin}/#/demo-anna/overview`)).toBe(INFO.token);
    expect(app.tokenFor("https://evil.example/")).toBeNull();
    expect(app.tokenFor("data:text/html,x")).toBeNull();
    expect(app.tokenFor(undefined)).toBeNull();
  });
});

describe("single instance (test_second_instance_is_refused_and_focuses_the_first)", () => {
  it("a second launch without the lock starts nothing", async () => {
    let sidecars = 0;
    let windows = 0;
    const { app } = setup({
      hasSingleInstanceLock: false,
      createSidecar: () => {
        sidecars++;
        return { start: async () => INFO, stop: async () => {} };
      },
      createWindow: () => {
        windows++;
        return new FakeWindow();
      },
    });
    expect(await app.start()).toBe("already-running");
    expect(sidecars).toBe(0);
    expect(windows).toBe(0);
  });

  it("the running instance fronts its window, restores a minimized one, and opens a link", async () => {
    const { app, window } = setup();
    await app.start();
    window.url = INFO.url;
    window.minimized = true;
    app.secondInstance(["Electron", ".", "cashu://investments/demo-anna"]);
    await new Promise((done) => setTimeout(done, 0));
    expect(window.calls.slice(0, 3)).toEqual(["restore", "show", "focus"]);
    expect(window.calls).toContain("hash #/demo-anna/investments.portfolio");
  });
});

describe("quitting (test_cmd_q_stops_the_server_before_the_process_exits)", () => {
  it("closing the window quits, and shutdown stops the sidecar and the tray once", async () => {
    const { app, window, events } = setup();
    await app.start();
    expect(window.userClose()).toBe(true);
    expect(events).toContain("quit");
    await Promise.all([app.shutdown(), app.shutdown()]);
    expect(events.filter((e) => e === "sidecar stopped")).toHaveLength(1);
    expect(events.filter((e) => e === "tray destroyed")).toHaveLength(1);
  });

  it("Cmd+Q (a quit request without a window close) also stops the sidecar", async () => {
    const { app, events } = setup();
    await app.start();
    app.requestQuit();
    app.requestQuit();
    expect(events.filter((e) => e === "quit")).toHaveLength(1);
    await app.shutdown();
    expect(events).toContain("sidecar stopped");
  });

  it("a quit during startup stops the sidecar that was still starting", async () => {
    let release: (info: SidecarInfo) => void = () => {};
    const { app, window, events } = setup(
      {},
      { start: () => new Promise<SidecarInfo>((resolve) => (release = resolve)) },
    );
    const started = app.start();
    await new Promise((done) => setTimeout(done, 0));
    app.requestQuit();
    const down = app.shutdown();
    release(INFO);
    expect(await started).toBe("started");
    await down;
    expect(events).toContain("sidecar stopped");
    expect(window.loaded).toHaveLength(1); // never navigated to the dashboard
  });
});

describe("tray", () => {
  it("opens the window and quits from the menu", async () => {
    const { app, window, events, tray } = setup();
    await app.start();
    expect(tray().items.map((i) => ("label" in i ? i.label : "-"))).toEqual([
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

  it("close-to-tray hides the window instead of quitting, until a real quit", async () => {
    const { app, window, events } = setup({ closeToTray: true });
    await app.start();
    expect(window.userClose()).toBe(false);
    expect(window.calls).toContain("hide");
    expect(events).not.toContain("quit");
    app.requestQuit();
    expect(window.userClose()).toBe(true);
  });
});
