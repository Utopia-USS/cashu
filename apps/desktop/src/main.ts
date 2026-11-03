/// <reference types="node" />
import { appendFileSync, chmodSync, existsSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  nativeCreationCommitParamsSchema,
  nativeCreationCommitResultSchema,
  nativeCreationCurrentParamsSchema,
  nativeCreationCurrentResultSchema,
  nativeCreationInspectParamsSchema,
  nativeCreationInspectResultSchema,
  nativeCreationPrepareParamsSchema,
  nativeCreationPrepareResultSchema,
  uiCreationAllowed,
} from "@cashu/host-protocol";
import {
  activateHost,
  connectOrStart,
  hostRunPaths,
  type ServiceStatus,
  spawnDetachedHost,
} from "@cashu/node-host";
import { nativeImage, shell } from "electron/common";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  MessageChannelMain,
  Notification,
  screen,
  session,
  Tray,
} from "electron/main";
import { DesktopApp, type WindowHandle } from "./app.js";
import {
  checkDataDir,
  ENV,
  LOG_FILE,
  MIN_SIZE,
  repoRoot,
  resolveDataDir,
  TITLE,
  USER_DATA_SUBDIR,
} from "./config.js";
import { shouldRegisterProtocol } from "./deeplink.js";
import { hostLaunch, PACKAGED_HOST_ENTRY } from "./hostLaunch.js";
import { HostRelay, HostRelays, type RelayPort } from "./hostRelay.js";
import { linkFromArgv } from "./links.js";
import { Notifier } from "./notify.js";
import { ALLOW, EXTERNAL, navigationDecision, redactToken } from "./security.js";
import { desktopHostService, nextDailyWake } from "./service/runtime.js";
import { Sidecar, sidecarSpec, verifyDataDir } from "./sidecar.js";
import { ensurePrivateDir, loadState, rememberedPort, rememberPort, statePath } from "./state.js";
import { pickLang, t } from "./strings.js";
import { windowSize } from "./window.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = repoRoot(here);
const env = process.env;
const choice = resolveDataDir(env);
const dataDir = choice.dir;

// ---- guards that run before anything is created ------------------------------------------------

function fatal(message: string): never {
  process.stderr.write(`${message}\n`);
  app.exit(2);
  process.exit(2);
}

const problem = checkDataDir({
  choice,
  isPackaged: app.isPackaged,
  allowedRoot: env[ENV.allowedRoot] || undefined,
});
if (problem) fatal(problem);

const spec = sidecarSpec(root, env);
if (env[ENV.skipDataDirCheck] !== "1") {
  const mismatch = verifyDataDir(spec, dataDir, env);
  if (mismatch) fatal(mismatch);
}

// ---- log (owner-only, rotated at 1 MB, the token is never written) -----------------------------

const logDir = ensurePrivateDir(join(ensurePrivateDir(dataDir), "logs"));
const logFile = join(logDir, LOG_FILE);

function log(line: string): void {
  try {
    if (existsSync(logFile) && statSync(logFile).size > 1_000_000)
      renameSync(logFile, `${logFile}.1`);
    appendFileSync(logFile, `${new Date().toISOString()} ${redactToken(line)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(logFile, 0o600);
  } catch {
    // logging must never keep the window from opening
  }
}

// ---- Electron profile inside the data dir: the single instance lock is per data dir ------------

app.setName(TITLE);
app.setPath("userData", ensurePrivateDir(join(dataDir, USER_DATA_SUBDIR)));
const hasLock = app.requestSingleInstanceLock();
const lang = pickLang(env[ENV.lang], app.getLocale());

const iconPath = join(root, "packaging", "icon", "cashu-1024.png");

let mainWindow: BrowserWindow | null = null;

function toHandle(window: BrowserWindow): WindowHandle {
  return {
    currentUrl: () => window.webContents.getURL(),
    loadUrl: (url) => window.loadURL(url),
    setHash: async (hash) => {
      await window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)};`);
    },
    show: () => window.show(),
    focus: () => window.focus(),
    restore: () => window.restore(),
    hide: () => window.hide(),
    isMinimized: () => window.isMinimized(),
    onClose: (handler) => {
      window.on("close", (event) => handler(() => event.preventDefault()));
    },
    onClosed: (handler) => {
      window.on("closed", handler);
    },
  };
}

const desktop = new DesktopApp({
  // TRANSITIONAL(S53b): real-vault identity is not enabled by selecting the native renderer.
  rendererPath:
    env.CASHU_DESKTOP_NATIVE_OVERVIEW === "1" ? "/assets/desktop/index.html" : undefined,
  lang,
  logFile,
  hasSingleInstanceLock: hasLock,
  closeToTray: env[ENV.closeToTray] === "1",
  createWindow(loadingUrl) {
    const size = windowSize(screen.getAllDisplays().map((d) => d.workAreaSize));
    const window = new BrowserWindow({
      title: TITLE,
      width: size.width,
      height: size.height,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      webPreferences: {
        preload: join(here, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        devTools: env.CASHU_DESKTOP_DEBUG === "1",
      },
    });
    mainWindow = window;
    window.on("closed", () => {
      mainWindow = null;
    });
    pinNavigation(window);
    void window.loadURL(loadingUrl);
    return toHandle(window);
  },
  createSidecar: (onExit) =>
    new Sidecar({
      spec,
      dataDir,
      baseEnv: env,
      preferredPort: rememberedPort(loadState(statePath(dataDir))),
      onLog: (line) => log(`sidecar: ${line}`),
      onExit: (message) => {
        log(message);
        onExit(message);
      },
    }),
  createTray(items, onAction) {
    if (env[ENV.noTray] === "1") return null;
    let image = nativeImage.createFromPath(iconPath);
    image = image.isEmpty() ? image : image.resize({ width: 18, height: 18 });
    const tray = new Tray(image);
    tray.setToolTip(t(lang, "trayTooltip"));
    tray.setContextMenu(
      Menu.buildFromTemplate(
        items.map((item) =>
          "separator" in item
            ? { type: "separator" as const }
            : { label: item.label, click: () => onAction(item.action) },
        ),
      ),
    );
    return { destroy: () => tray.destroy() };
  },
  quit: () => app.quit(),
  rememberPort: (port) => rememberPort(statePath(dataDir), port),
});

/** Pin the window to the app's own origin (PK5): links elsewhere open in the browser or are dropped. */
function pinNavigation(window: BrowserWindow): void {
  const decide = (url: string): boolean => {
    const origin = desktop.origin;
    const decision = origin ? navigationDecision(url, origin) : "block";
    if (decision === EXTERNAL) openExternal(url);
    return decision === ALLOW;
  };
  window.webContents.on("will-navigate", (event, url) => {
    if (!decide(url)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!decide(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    decide(url); // external links open in the browser; a second window never opens
    return { action: "deny" };
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function openExternal(url: string): void {
  shell.openExternal(url).catch(() => log("could not open a link in the browser"));
}

// ---- notifications (main process; the worker of S40 will post through this) ---------------------

export const notifier = new Notifier({
  supported: () => Notification.isSupported(),
  create: (options) => new Notification(options),
  onClick: (url) => {
    if (url) desktop.links.open(url);
    desktop.focusWindow();
  },
});

// ---- token bridge (PK1): the page asks, the main process answers for the app's origin only ------

/** The sender is the main window's top frame (no iframe, no other window). */
function fromMainFrame(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): string | null {
  const frame = event.senderFrame;
  const ok =
    mainWindow !== null &&
    event.sender === mainWindow.webContents &&
    frame !== null &&
    frame === event.sender.mainFrame;
  return ok ? frame.url : null;
}

// TRANSITIONAL(S55z): the preload asks (synchronously, before page scripts run) whether to expose
// the `window.pywebview` shim at all; only the app's own origin gets it.
ipcMain.on("cashu:bridge-allowed", (event) => {
  event.returnValue = desktop.exposesBridgeTo(fromMainFrame(event));
});

ipcMain.handle("cashu:token", (event) => {
  const token = desktop.tokenFor(fromMainFrame(event));
  if (token === null) log("token request from a page outside the app refused");
  return token;
});

// Registration belongs to the OS, not the host worker snapshot. The page can request only a
// boolean transition and never supplies an agent label, executable, bundle or data directory.
const hostService = desktopHostService(dataDir, app.isPackaged);
function visibleServiceStatus(status: ServiceStatus) {
  return {
    state: status.state,
    ...(status.reason ? { reason: status.reason } : {}),
    ...(status.state === "enabled" ? { nextWake: nextDailyWake() } : {}),
  };
}
async function serviceStatus() {
  return visibleServiceStatus(await hostService.status());
}
ipcMain.handle("cashu:service-status", async (event) => {
  if (!desktop.exposesBridgeTo(fromMainFrame(event))) return { state: "unavailable" };
  return serviceStatus();
});
ipcMain.handle("cashu:service-set-enabled", async (event, enabled: unknown) => {
  if (!desktop.exposesBridgeTo(fromMainFrame(event)) || typeof enabled !== "boolean") {
    return { state: "unavailable" };
  }
  return visibleServiceStatus(await (enabled ? hostService.enable() : hostService.disable()));
});

// ---- the renderer's store channel, relayed to the local host (S56b) -----------------------------

// The data dir's host (apps/host): connected to as a `ui` client per renderer frame and started on
// demand by the verified service when available, otherwise detached. It exits when idle.
const HOST_BUILD = `desktop-${app.isPackaged ? app.getVersion() : "dev"}`;

// The page never chooses a host method, path or key name. Each call uses a fresh authenticated UI
// session so it cannot race the renderer's store relay handler.
function creationIpc(method: "prepare" | "commit" | "inspect" | "current") {
  const paramsSchema = {
    prepare: nativeCreationPrepareParamsSchema,
    commit: nativeCreationCommitParamsSchema,
    inspect: nativeCreationInspectParamsSchema,
    current: nativeCreationCurrentParamsSchema,
  }[method];
  const resultSchema = {
    prepare: nativeCreationPrepareResultSchema,
    commit: nativeCreationCommitResultSchema,
    inspect: nativeCreationInspectResultSchema,
    current: nativeCreationCurrentResultSchema,
  }[method];
  ipcMain.handle(`cashu:creation-${method}`, async (event, raw: unknown) => {
    if (!desktop.exposesBridgeTo(fromMainFrame(event))) throw new Error("creation_unavailable");
    const parsedParams = paramsSchema.safeParse(raw);
    if (!parsedParams.success) throw new Error("creation_invalid_params");
    const connection = (
      await connectOrStart({
        dataDir,
        role: "ui",
        build: HOST_BUILD,
        start: async () => {
          await activateHost(hostService, startHost);
        },
      })
    ).connection;
    try {
      const full = `native.creation.${method}`;
      if (!uiCreationAllowed(full, connection.host.protocol.minor, connection.host.features))
        throw new Error("creation_unavailable");
      const parsedResult = resultSchema.safeParse(await connection.call(full, parsedParams.data));
      if (!parsedResult.success) throw new Error("creation_invalid_result");
      return parsedResult.data;
    } finally {
      connection.close();
    }
  });
}

creationIpc("prepare");
creationIpc("commit");
creationIpc("inspect");
creationIpc("current");

function startHost(): void {
  if (app.isPackaged && !existsSync(join(process.resourcesPath, PACKAGED_HOST_ENTRY))) {
    throw new Error("bundled host unavailable");
  }
  const launch = hostLaunch({
    root,
    dataDir,
    execPath: process.execPath,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    env,
    build: HOST_BUILD,
  });
  spawnDetachedHost({ ...launch, logPath: hostRunPaths(dataDir).logPath });
  log("local host started");
}

const relays = new HostRelays(
  (port) =>
    new HostRelay({
      port,
      connect: async (onStarting) =>
        (
          await connectOrStart({
            dataDir,
            role: "ui",
            build: HOST_BUILD,
            start: async () => {
              onStarting();
              await activateHost(hostService, startHost);
            },
          })
        ).connection,
      log,
    }),
);

const watchedPages = new Set<number>();

// A page of the app's own origin asks for a store port (the preload forwards the request): main keeps
// one end and relays it to its own host session for that frame; the other end goes back to that frame.
ipcMain.on("cashu:store-port", (event) => {
  const frame = event.senderFrame;
  if (frame === null || !desktop.exposesBridgeTo(fromMainFrame(event))) {
    log("store port request from a page outside the app refused");
    return;
  }
  const { port1, port2 } = new MessageChannelMain();
  const port: RelayPort = {
    post: (message) => port1.postMessage(message),
    onMessage: (handler) => port1.on("message", (e) => handler(e.data)),
    onClose: (handler) => port1.on("close", handler),
    close: () => port1.close(),
  };
  const page = event.sender.id;
  relays.open(`${page}:${frame.processId}:${frame.routingId}`, port);
  if (!watchedPages.has(page)) {
    watchedPages.add(page);
    event.sender.once("destroyed", () => {
      watchedPages.delete(page);
      relays.closePage(String(page));
    });
  }
  port1.start();
  event.sender.postMessage("cashu:store-port", null, [port2]);
});

// ---- lifecycle -----------------------------------------------------------------------------------

app.on("second-instance", (_event, argv) => desktop.secondInstance(argv));
app.on("open-url", (event, url) => {
  event.preventDefault();
  desktop.links.open(url);
});
app.on("window-all-closed", () => desktop.requestQuit());

let shutDown = false;
app.on("before-quit", (event) => {
  if (shutDown) return;
  event.preventDefault();
  relays.closeAll();
  void desktop.shutdown().finally(() => {
    shutDown = true;
    app.quit();
  });
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => desktop.requestQuit());
}
process.on("uncaughtException", (error) => {
  log(`uncaught: ${error.stack ?? error.message}`);
  desktop.requestQuit();
});

// Only a packaged app registers the URL scheme with the system, and only when asked to.
if (shouldRegisterProtocol({ isPackaged: app.isPackaged, env })) {
  app.setAsDefaultProtocolClient("cashu");
}

function applicationMenu(): Menu {
  const debug = env.CASHU_DESKTOP_DEBUG === "1";
  return Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "editMenu" },
    ...(debug ? [{ role: "viewMenu" as const }] : []),
    { role: "windowMenu" },
  ]);
}

if (!hasLock) {
  process.stderr.write(`${t(lang, "alreadyRunning")}\n`);
  app.quit();
} else {
  app.whenReady().then(async () => {
    const hardened = session.defaultSession;
    hardened.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    hardened.setPermissionCheckHandler(() => false);
    Menu.setApplicationMenu(applicationMenu());
    if (process.platform === "darwin" && existsSync(iconPath)) {
      app.dock?.setIcon(nativeImage.createFromPath(iconPath));
    }
    const result = await desktop.start(linkFromArgv(process.argv.slice(1)));
    log(`start: ${result}${desktop.error ? ` (${desktop.error})` : ""}`);
  });
}
