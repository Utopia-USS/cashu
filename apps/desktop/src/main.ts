/// <reference types="node" />
import { appendFileSync, chmodSync, existsSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeImage, shell } from "electron/common";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
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
import { linkFromArgv } from "./links.js";
import { Notifier } from "./notify.js";
import { ALLOW, EXTERNAL, navigationDecision, redactToken } from "./security.js";
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

ipcMain.handle("cashu:token", (event) => {
  const frame = event.senderFrame;
  const fromMain =
    mainWindow !== null &&
    event.sender === mainWindow.webContents &&
    frame !== null &&
    frame === event.sender.mainFrame;
  const token = fromMain ? desktop.tokenFor(frame.url) : null;
  if (token === null) log("token request from a page outside the app refused");
  return token;
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
