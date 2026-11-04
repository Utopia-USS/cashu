/// <reference types="node" />
import { appendFileSync, chmodSync, existsSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adminHandoverResultSchema,
  adminStatusResultSchema,
  deviceListParamsSchema,
  deviceListResultSchema,
  NATIVE_CONNECTORS_FEATURE,
  NOTIFICATION_INTENT_FEATURE,
  NOTIFICATION_INTENT_METHOD,
  nativeCreationCommitParamsSchema,
  nativeCreationCommitResultSchema,
  nativeCreationCurrentParamsSchema,
  nativeCreationCurrentResultSchema,
  nativeCreationInspectParamsSchema,
  nativeCreationInspectResultSchema,
  nativeCreationPrepareParamsSchema,
  nativeCreationPrepareResultSchema,
  notificationResolveResultSchema,
  pairingCancelParamsSchema,
  pairingCancelResultSchema,
  pairingConfirmParamsSchema,
  pairingConfirmResultSchema,
  pairingInspectParamsSchema,
  pairingInspectResultSchema,
  pairingInviteParamsSchema,
  pairingInviteResultSchema,
  revokeCancelParamsSchema,
  revokeCancelResultSchema,
  revokeCommitParamsSchema,
  revokeCommitResultSchema,
  revokeInspectParamsSchema,
  revokeInspectResultSchema,
  revokePreviewParamsSchema,
  revokePreviewResultSchema,
  uiCreationAllowed,
  uiDevicesAllowed,
  uiPairingAllowed,
} from "@cashu/host-protocol";
import {
  acquireHostLock,
  activateHost,
  assertUpdateHandoverComplete,
  cancelUpdateAdmission,
  clearUpdateAdmissionAfterReplacement,
  commitUpdateDispatch,
  connectHost,
  connectOrStart,
  HostConnectError,
  type HostLock,
  hostRunPaths,
  publishUpdateAdmission,
  readUpdateAdmission,
  recoverPreparedUpdateAdmission,
  type ServiceStatus,
  spawnDetachedHost,
  waitForHostLock,
} from "@cashu/node-host";
import { legacyDataAdmission, legacySourceRoots } from "@cashu/node-host/admission";
import { packagedBuildId, readBundleIdentity } from "@cashu/node-host/bundle-identity";
import { nativeImage, shell } from "electron/common";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  protocol,
  screen,
  session,
  Tray,
} from "electron/main";
import { DesktopApp, type WindowHandle } from "./app.js";
import { APP_ENTRY, appAssetResponse } from "./appProtocol.js";
import {
  checkDataDir,
  defaultDataDir,
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
import { createNotificationClickRouter } from "./notification/clickRouter.js";
import { notificationIntake } from "./notification/early.js";
import { loadNativeNotificationCenter, releaseResponseHandler } from "./notification/native.js";
import type { NotificationResponsePair } from "./notification/responses.js";
import { ALLOW, EXTERNAL, navigationDecision, redactToken } from "./security.js";
import { desktopHostService, nextDailyWake } from "./service/runtime.js";
import { ensurePrivateDir } from "./state.js";
import { pickLang, t } from "./strings.js";
import { releaseAuthority } from "./update/authority.js";
import { startMainUpdateBridge } from "./update/bridge.js";
import { createElectronUpdateController } from "./update/electron.js";
import { updatePreferences } from "./update/preferences.js";
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

const admissionRoots = legacySourceRoots(
  dataDir,
  root,
  homedir(),
  env,
  process.platform,
  choice.explicit,
);
const admission = legacyDataAdmission(admissionRoots);

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
  staticEntry:
    admission === "no_legacy_sentinel" ? APP_ENTRY : `${APP_ENTRY}?admission=${admission}`,
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
    window.webContents.on("did-start-navigation", () => notificationClickRouter.setUnready());
    window.on("closed", () => {
      mainWindow = null;
      notificationClickRouter.setUnready();
    });
    pinNavigation(window);
    void window.loadURL(loadingUrl);
    return toHandle(window);
  },
  createSidecar: () => {
    throw new Error("legacy_ui_unavailable");
  },
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
  rememberPort: () => {},
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

ipcMain.on("cashu:bridge-allowed", (event) => {
  event.returnValue = desktop.exposesBridgeTo(fromMainFrame(event));
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
  if (
    !desktop.exposesBridgeTo(fromMainFrame(event)) ||
    typeof enabled !== "boolean" ||
    !nativeAdmissionOpen()
  ) {
    return { state: "unavailable" };
  }
  return visibleServiceStatus(await (enabled ? hostService.enable() : hostService.disable()));
});

ipcMain.handle("cashu:notifications-status", async (event) => {
  if (!desktop.exposesBridgeTo(fromMainFrame(event))) return "unavailable";
  if (process.platform === "linux") return "system";
  try {
    return (await loadNativeNotificationCenter()?.permissionStatus()) ?? "unavailable";
  } catch {
    return "unavailable";
  }
});
ipcMain.handle("cashu:notifications-request-permission", async (event) => {
  if (!desktop.exposesBridgeTo(fromMainFrame(event))) return "unavailable";
  if (process.platform === "linux") return "system";
  try {
    return (await loadNativeNotificationCenter()?.requestPermission()) ?? "unavailable";
  } catch {
    return "unavailable";
  }
});

// ---- the renderer's store channel, relayed to the local host (S56b) -----------------------------

// The data dir's host (apps/host): connected to as a `ui` client per renderer frame and started on
// demand by the verified service when available, otherwise detached. It exits when idle.
const HOST_BUILD = app.isPackaged
  ? (() => {
      const identity = readBundleIdentity(dirname(dirname(dirname(process.execPath))));
      if (identity.kind !== "present") throw new Error("packaged_bundle_identity_unavailable");
      return packagedBuildId(app.getVersion(), identity.contentDigest);
    })()
  : "desktop-dev";
let hostAdmissionOpen = true;
const nativeAdmissionOpen = () =>
  hostAdmissionOpen && legacyDataAdmission(admissionRoots) === "no_legacy_sentinel";
let updaterBridge: Awaited<ReturnType<typeof startMainUpdateBridge>> | null = null;
let updaterController: ReturnType<typeof createElectronUpdateController> | null = null;
let updateHoldLock: HostLock | null = null;

async function boundedAdminCall(
  connection: Awaited<ReturnType<typeof connectHost>>,
  method: "admin.status" | "admin.handover",
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      connection.call(method),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("admin_timeout")), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function drainForUpdate(targetVersion: string): Promise<
  | {
      kind: "ready";
      cancel(): Promise<boolean>;
      commitDispatch(): Promise<"committed" | "prepared" | "unknown">;
    }
  | { kind: "refused" | "unknown" }
> {
  if (!hostAdmissionOpen) return { kind: "refused" };
  const identity = readBundleIdentity(dirname(dirname(dirname(process.execPath))));
  if (identity.kind !== "present") return { kind: "refused" };
  hostAdmissionOpen = false;
  relays.closeAll();
  let published = false;
  let lock: HostLock | undefined;
  try {
    let connection: Awaited<ReturnType<typeof connectHost>> | null = null;
    try {
      connection = await connectHost({ dataDir, role: "admin", build: HOST_BUILD });
    } catch (error) {
      if (!(error instanceof HostConnectError) || error.kind !== "unavailable") throw error;
    }
    let admissionId: string;
    if (!connection) {
      ensurePrivateDir(hostRunPaths(dataDir).runDir);
      lock = acquireHostLock(hostRunPaths(dataDir).lockPath);
      if (!lock) return { kind: "unknown" };
      admissionId = publishUpdateAdmission(
        dataDir,
        identity.fingerprint,
        app.getVersion(),
        targetVersion,
      ).id;
      published = true;
    } else {
      try {
        const status = adminStatusResultSchema.parse(
          await boundedAdminCall(connection, "admin.status"),
        );
        if (
          status.build !== HOST_BUILD ||
          status.dataDir !== hostRunPaths(dataDir).dataDirId ||
          status.stopping
        ) {
          hostAdmissionOpen = true;
          return { kind: "refused" };
        }
        const expected = {
          pid: status.pid,
          startedAt: status.startedAt,
          build: status.build,
          dataDirId: status.dataDir,
        };
        admissionId = publishUpdateAdmission(
          dataDir,
          identity.fingerprint,
          app.getVersion(),
          targetVersion,
        ).id;
        published = true;
        const ack: unknown = await boundedAdminCall(connection, "admin.handover");
        adminHandoverResultSchema.parse(ack);
        if (!ack || typeof ack !== "object" || Object.keys(ack).length !== 1)
          throw new Error("handover_ack_invalid");
        lock = await waitForHostLock(dataDir, admissionId, 30_000);
        if (!lock) return { kind: "unknown" };
        assertUpdateHandoverComplete(lock, dataDir, admissionId, expected);
      } finally {
        connection.close();
      }
    }
    if (!lock) return { kind: "unknown" };
    updateHoldLock = lock;
    return {
      kind: "ready",
      async cancel() {
        if (!lock?.held) return false;
        try {
          cancelUpdateAdmission(lock, dataDir, admissionId);
        } catch {
          return false;
        } finally {
          lock.release();
          updateHoldLock = null;
        }
        hostAdmissionOpen = true;
        mainWindow?.webContents.reload();
        return true;
      },
      async commitDispatch() {
        if (!lock?.held) return "unknown";
        try {
          commitUpdateDispatch(lock, dataDir, admissionId);
          return "committed";
        } catch {
          try {
            const marker = readUpdateAdmission(dataDir);
            return marker?.id === admissionId && marker.phase === "prepared"
              ? "prepared"
              : "unknown";
          } catch {
            return "unknown";
          }
        }
      },
    };
  } catch {
    return { kind: "unknown" };
  } finally {
    if (lock && lock !== updateHoldLock) lock.release();
    if (!published) {
      hostAdmissionOpen = true;
      mainWindow?.webContents.reload();
    }
  }
}

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
    if (!nativeAdmissionOpen()) throw new Error("creation_unavailable");
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

function devicesIpc(
  method: "list" | "revokePreview" | "revokeCommit" | "revokeInspect" | "revokeCancel",
) {
  const paramsSchema = {
    list: deviceListParamsSchema,
    revokePreview: revokePreviewParamsSchema,
    revokeCommit: revokeCommitParamsSchema,
    revokeInspect: revokeInspectParamsSchema,
    revokeCancel: revokeCancelParamsSchema,
  }[method];
  const resultSchema = {
    list: deviceListResultSchema,
    revokePreview: revokePreviewResultSchema,
    revokeCommit: revokeCommitResultSchema,
    revokeInspect: revokeInspectResultSchema,
    revokeCancel: revokeCancelResultSchema,
  }[method];
  ipcMain.handle(`cashu:devices-${method}`, async (event, raw: unknown) => {
    if (!desktop.exposesBridgeTo(fromMainFrame(event)) || !nativeAdmissionOpen())
      throw new Error("devices_unavailable");
    const params = paramsSchema.safeParse(raw);
    if (!params.success) throw new Error("devices_invalid_params");
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
      const full = `native.devices.${method}`;
      if (!uiDevicesAllowed(full, connection.host.protocol.minor, connection.host.features))
        throw new Error("devices_unavailable");
      const result = resultSchema.safeParse(await connection.call(full, params.data));
      if (!result.success) throw new Error("devices_invalid_result");
      return result.data;
    } finally {
      connection.close();
    }
  });
}

devicesIpc("list");
devicesIpc("revokePreview");
devicesIpc("revokeCommit");
devicesIpc("revokeInspect");
devicesIpc("revokeCancel");

ipcMain.handle("cashu:connectors-install", async (event) => {
  if (!desktop.exposesBridgeTo(fromMainFrame(event)) || !nativeAdmissionOpen() || !mainWindow)
    throw new Error("connectors_unavailable");
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
    if (!connection.host.features.includes(NATIVE_CONNECTORS_FEATURE))
      throw new Error("connectors_unavailable");
    const prepared = await connection.call("native.connectors.prepareInstall", {});
    if (
      !prepared ||
      typeof prepared !== "object" ||
      !("token" in prepared) ||
      typeof prepared.token !== "string"
    )
      throw new Error("connector_picker_unavailable");
    const chosen = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      securityScopedBookmarks: false,
    });
    if (chosen.canceled || chosen.filePaths.length !== 1) return { kind: "cancelled" };
    const result = await connection.call("native.connectors.commitInstall", {
      token: prepared.token,
      source: chosen.filePaths[0],
    });
    if (!result || typeof result !== "object" || !("id" in result) || !("digest" in result))
      throw new Error("connector_install_failed");
    return { kind: "installed", id: result.id, digest: result.digest };
  } finally {
    connection.close();
  }
});

function pairingIpc(method: "invite" | "confirm" | "inspect" | "cancel") {
  const paramsSchema = {
    invite: pairingInviteParamsSchema,
    confirm: pairingConfirmParamsSchema,
    inspect: pairingInspectParamsSchema,
    cancel: pairingCancelParamsSchema,
  }[method];
  const resultSchema = {
    invite: pairingInviteResultSchema,
    confirm: pairingConfirmResultSchema,
    inspect: pairingInspectResultSchema,
    cancel: pairingCancelResultSchema,
  }[method];
  ipcMain.handle(`cashu:pairing-${method}`, async (event, raw: unknown) => {
    if (!desktop.exposesBridgeTo(fromMainFrame(event)) || !nativeAdmissionOpen())
      throw new Error("pairing_unavailable");
    const params = paramsSchema.safeParse(raw);
    if (!params.success) throw new Error("pairing_invalid_params");
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
      const full = `native.pairing.${method}`;
      if (!uiPairingAllowed(full, connection.host.protocol.minor, connection.host.features))
        throw new Error("pairing_unavailable");
      const result = resultSchema.safeParse(await connection.call(full, params.data));
      if (!result.success) throw new Error("pairing_invalid_result");
      return result.data;
    } finally {
      connection.close();
    }
  });
}

pairingIpc("invite");
pairingIpc("confirm");
pairingIpc("inspect");
pairingIpc("cancel");

function startHost(): void {
  if (!nativeAdmissionOpen()) throw new Error("host admission closed");
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

type ResolvedNotification = Extract<
  import("@cashu/host-protocol").NotificationResolveResult,
  { kind: "target" }
>;

async function resolveNotificationClick(
  pair: NotificationResponsePair,
): Promise<ResolvedNotification | null> {
  try {
    if (!nativeAdmissionOpen()) return null;
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
      if (
        connection.host.protocol.minor < 4 ||
        !connection.host.features.includes(NOTIFICATION_INTENT_FEATURE)
      )
        return null;
      const raw = await connection.call(NOTIFICATION_INTENT_METHOD, pair);
      const result = notificationResolveResultSchema.safeParse(raw);
      return result.success && result.data.kind === "target" ? result.data : null;
    } finally {
      connection.close();
    }
  } catch {
    return null;
  }
}

const notificationClickRouter = createNotificationClickRouter<ResolvedNotification>({
  resolve: resolveNotificationClick,
  focus: () => desktop.focusWindow(),
  start: () => mainWindow?.webContents.send("cashu:notification-pending"),
  publish: (target) =>
    mainWindow?.webContents.send("cashu:notification-target", target ?? { kind: "unavailable" }),
});

ipcMain.on("cashu:notification-ready", (event) => {
  if (!desktop.exposesBridgeTo(fromMainFrame(event))) return;
  notificationClickRouter.setReady();
  notificationIntake.bind(notificationClickRouter.enqueue);
});

const relays = new HostRelays(
  (port) =>
    new HostRelay({
      port,
      connect: async (onStarting) => {
        if (!nativeAdmissionOpen()) throw new Error("host admission closed");
        return (
          await connectOrStart({
            dataDir,
            role: "ui",
            build: HOST_BUILD,
            start: async () => {
              onStarting();
              await activateHost(hostService, startHost);
            },
          })
        ).connection;
      },
      log,
    }),
);

const watchedPages = new Set<number>();

// A page of the app's own origin asks for a store port (the preload forwards the request): main keeps
// one end and relays it to its own host session for that frame; the other end goes back to that frame.
ipcMain.on("cashu:store-port", (event) => {
  const frame = event.senderFrame;
  if (!nativeAdmissionOpen() || frame === null || !desktop.exposesBridgeTo(fromMainFrame(event))) {
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
  notificationIntake.dispose();
  notificationClickRouter.dispose();
  releaseResponseHandler();
  relays.closeAll();
  void updaterBridge?.close();
  updaterController?.dispose();
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
    protocol.handle("app", (request) =>
      appAssetResponse(
        request.url,
        app.isPackaged ? process.resourcesPath : join(root, "apps", "desktop", "dist"),
      ),
    );
    if (app.isPackaged) {
      const bundle = dirname(dirname(dirname(process.execPath)));
      const identity = readBundleIdentity(bundle);
      const authority = releaseAuthority(
        {
          isPackaged: true,
          execPath: process.execPath,
          resourcesPath: process.resourcesPath,
          dataDir,
          expectedDataDir: defaultDataDir(process.platform, homedir(), env),
        },
        drainForUpdate,
      );
      try {
        const pending = readUpdateAdmission(dataDir);
        if (pending) {
          hostAdmissionOpen = false;
          const gate = await authority.check();
          if (gate.ok && identity.kind === "present") {
            let expectedHost:
              | { pid: number; startedAt: string; build: string; dataDirId: string }
              | undefined;
            if (pending.phase === "prepared") {
              if (
                pending.fromFingerprint !== identity.fingerprint ||
                pending.fromVersion !== app.getVersion()
              )
                throw new Error("prepared_identity_mismatch");
              let connection: Awaited<ReturnType<typeof connectHost>> | null = null;
              try {
                connection = await connectHost({ dataDir, role: "admin", build: HOST_BUILD });
              } catch (error) {
                if (!(error instanceof HostConnectError) || error.kind !== "unavailable")
                  throw error;
              }
              if (connection) {
                try {
                  const status = adminStatusResultSchema.parse(
                    await boundedAdminCall(connection, "admin.status"),
                  );
                  if (
                    status.build !== HOST_BUILD ||
                    status.dataDir !== hostRunPaths(dataDir).dataDirId ||
                    status.stopping
                  )
                    throw new Error("prepared_host_mismatch");
                  expectedHost = {
                    pid: status.pid,
                    startedAt: status.startedAt,
                    build: status.build,
                    dataDirId: status.dataDir,
                  };
                  const ack: unknown = await boundedAdminCall(connection, "admin.handover");
                  adminHandoverResultSchema.parse(ack);
                  if (!ack || typeof ack !== "object" || Object.keys(ack).length !== 1)
                    throw new Error("prepared_handover_ack_invalid");
                } finally {
                  connection.close();
                }
              }
            }
            const lock = await waitForHostLock(dataDir, pending.id, 30_000);
            if (lock) {
              try {
                if (pending.phase === "prepared") {
                  if (expectedHost)
                    assertUpdateHandoverComplete(lock, dataDir, pending.id, expectedHost);
                  recoverPreparedUpdateAdmission(
                    lock,
                    dataDir,
                    identity.fingerprint,
                    app.getVersion(),
                  );
                } else {
                  clearUpdateAdmissionAfterReplacement(
                    lock,
                    dataDir,
                    identity.fingerprint,
                    app.getVersion(),
                  );
                }
                hostAdmissionOpen = true;
              } finally {
                lock.release();
              }
            }
          }
        }
      } catch (error) {
        hostAdmissionOpen = false;
        log(`update barrier: ${error instanceof Error ? error.name : "unknown"}`);
      }
      updaterController = createElectronUpdateController(
        authority,
        updatePreferences(dataDir),
        app.getVersion(),
      );
      await updaterController.initialize();
      if (identity.kind === "present" && updaterController.status().availability === "ready") {
        updaterBridge = await startMainUpdateBridge(
          updaterController,
          dataDir,
          HOST_BUILD,
          identity.fingerprint,
        );
      }
    }
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
