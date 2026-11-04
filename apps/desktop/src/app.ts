import { LinkRouter, type LinkWindow, linkFromArgv } from "./links.js";
import { dataUrl, errorHtml, loadingHtml } from "./pages.js";
import { bridgeAllowed } from "./security.js";
import type { SidecarInfo } from "./sidecar.js";
import type { Lang } from "./strings.js";
import { type TrayAction, type TrayItem, trayItems } from "./tray.js";

/** The window, as the orchestrator sees it (Electron's `BrowserWindow` in main.ts, a fake in tests). */
export interface WindowHandle extends LinkWindow {
  focus(): void;
  restore(): void;
  hide(): void;
  isMinimized(): boolean;
  /** Called when the user closes the window; `prevent()` keeps it open. */
  onClose(handler: (prevent: () => void) => void): void;
  onClosed(handler: () => void): void;
}

export interface SidecarLike {
  start(): Promise<SidecarInfo>;
  stop(): Promise<void>;
}

export interface TrayHandle {
  destroy(): void;
}

export interface DesktopDeps {
  /** Packaged native renderer, served by the trusted app protocol without starting Python. */
  staticEntry?: string;
  /** Same trusted sidecar origin; unported SPA routes remain available at its root. */
  rendererPath?: string;
  lang: Lang;
  logFile: string | null;
  /** Result of Electron's single instance lock for this data dir. */
  hasSingleInstanceLock: boolean;
  closeToTray: boolean;
  createWindow(loadingUrl: string): WindowHandle;
  /** `onExit`: the sidecar died after it had started. */
  createSidecar(onExit: (message: string) => void): SidecarLike;
  createTray(items: TrayItem[], onAction: (action: TrayAction) => void): TrayHandle | null;
  /** Ask the host to quit (Electron `app.quit()`, which ends in `shutdown`). */
  quit(): void;
  rememberPort(port: number): void;
}

export type StartResult = "started" | "already-running" | "failed";

/**
 * The behaviours of `desktop/shell.py run()`, host-independent:
 *  - one instance per data dir: a second launch fronts the running window and exits,
 *  - the window opens on a loading page, the sidecar starts, the window shows the dashboard (on
 *    the view of a link that arrived meanwhile), a failed start shows an error page,
 *  - closing the window quits and stops the sidecar,
 *  - the token reaches the page only through `tokenForSender` (own origin only).
 */
export class DesktopApp {
  readonly links = new LinkRouter();
  private window: WindowHandle | null = null;
  private tray: TrayHandle | null = null;
  private info: SidecarInfo | null = null;
  private sidecar: SidecarLike | null = null;
  private quitting = false;
  private shutdownPromise: Promise<void> | null = null;
  error: string | null = null;

  constructor(private readonly deps: DesktopDeps) {}

  get origin(): string | null {
    return this.deps.staticEntry ?? this.info?.origin ?? null;
  }

  get windowHandle(): WindowHandle | null {
    return this.window;
  }

  async start(firstLink?: string | null): Promise<StartResult> {
    if (!this.deps.hasSingleInstanceLock) return "already-running";
    if (firstLink) this.links.open(firstLink);
    const window = this.deps.createWindow(dataUrl(loadingHtml(this.deps.lang)));
    this.window = window;
    window.onClose((prevent) => {
      if (this.deps.closeToTray && !this.quitting) {
        prevent();
        window.hide();
      }
    });
    window.onClosed(() => {
      this.window = null;
      this.requestQuit();
    });
    this.tray = this.deps.createTray(trayItems(this.deps.lang), (action) => {
      if (action === "open") this.focusWindow();
      else this.requestQuit();
    });

    if (this.deps.staticEntry) {
      try {
        await window.loadUrl(this.links.ready(window, this.deps.staticEntry));
        return "started";
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        await this.showError(window, this.error);
        return "failed";
      }
    }

    const sidecar = this.deps.createSidecar((message) => {
      if (this.quitting) return;
      this.error = message;
      void this.showError(window, message);
    });
    this.sidecar = sidecar;
    try {
      this.info = await sidecar.start();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      await this.showError(window, this.error);
      return "failed";
    }
    if (this.quitting) return "started";
    try {
      this.deps.rememberPort(this.info.port);
      const entry =
        this.deps.rendererPath === undefined
          ? this.info.url
          : new URL(this.deps.rendererPath, this.info.url).href;
      await window.loadUrl(this.links.ready(window, entry));
    } catch (e) {
      this.error = `Unexpected error while opening the window: ${e instanceof Error ? e.message : String(e)}`;
      await this.showError(window, this.error);
      return "failed";
    }
    return "started";
  }

  private async showError(window: WindowHandle, message: string): Promise<void> {
    try {
      await window.loadUrl(dataUrl(errorHtml(this.deps.lang, message, this.deps.logFile)));
    } catch {
      // the window is gone: nothing to show the error in
    }
  }

  /** A second launch (the lock holder gets its argv): front the window, open a link it carries. */
  secondInstance(argv: readonly string[]): void {
    this.focusWindow();
    const link = linkFromArgv(argv);
    if (link) this.links.open(link);
  }

  focusWindow(): void {
    const window = this.window;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  /** Whether the preload exposes native bridges to this page. */
  exposesBridgeTo(senderUrl: string | null | undefined): boolean {
    return bridgeAllowed(senderUrl, this.origin);
  }

  requestQuit(): void {
    if (this.quitting) return;
    this.quitting = true;
    this.deps.quit();
  }

  get isQuitting(): boolean {
    return this.quitting;
  }

  /** Stops the sidecar (once) and the tray; awaited by the host's before-quit handler. */
  shutdown(): Promise<void> {
    this.quitting = true;
    this.shutdownPromise ??= (async () => {
      this.tray?.destroy();
      this.tray = null;
      await this.sidecar?.stop();
    })();
    return this.shutdownPromise;
  }
}
