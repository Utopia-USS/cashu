import { LinkRouter, type LinkWindow, linkFromArgv } from "./links.js";
import { dataUrl, errorHtml, loadingHtml } from "./pages.js";
import { bridgeAllowed } from "./security.js";
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

export interface TrayHandle {
  destroy(): void;
}

export interface DesktopDeps {
  /** Native renderer served by the trusted app protocol. */
  staticEntry: string;
  lang: Lang;
  logFile: string | null;
  /** Result of Electron's single instance lock for this data dir. */
  hasSingleInstanceLock: boolean;
  closeToTray: boolean;
  createWindow(loadingUrl: string): WindowHandle;
  createTray(items: TrayItem[], onAction: (action: TrayAction) => void): TrayHandle | null;
  /** Ask the host to quit (Electron `app.quit()`, which ends in `shutdown`). */
  quit(): void;
}

export type StartResult = "started" | "already-running" | "failed";

/**
 * Native desktop window lifecycle, independent of the host:
 *  - one instance per data dir: a second launch fronts the running window and exits,
 *  - the window opens on a loading page, then the native renderer (including a pending link),
 *  - closing the window quits and destroys the tray,
 *  - native bridges are exposed only to the app origin.
 */
export class DesktopApp {
  readonly links = new LinkRouter();
  private window: WindowHandle | null = null;
  private tray: TrayHandle | null = null;
  private quitting = false;
  private shutdownPromise: Promise<void> | null = null;
  error: string | null = null;

  constructor(private readonly deps: DesktopDeps) {}

  get origin(): string {
    return this.deps.staticEntry;
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

    try {
      await window.loadUrl(this.links.ready(window, this.deps.staticEntry));
      return "started";
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      await this.showError(window, this.error);
      return "failed";
    }
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

  /** Destroys the tray once; awaited by Electron's before-quit handler. */
  shutdown(): Promise<void> {
    this.quitting = true;
    this.shutdownPromise ??= (async () => {
      this.tray?.destroy();
      this.tray = null;
    })();
    return this.shutdownPromise;
  }
}
