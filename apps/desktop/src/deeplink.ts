import { ENV } from "./config.js";

/**
 * Registering a URL handler is a system-wide change. A development run never registers anything;
 * links reach it as `--open-link=cashu://...` or as the argument of a second launch instead.
 * macOS: the packaged bundle's Info.plist declares the scheme, so LaunchServices registers it with the
 * install; the app itself registers only when asked to. Windows: the NSIS installer registers no URL
 * scheme, so the packaged app registers itself for the current user (HKCU\Software\Classes, the
 * Info.plist's counterpart), with Electron's default command `"<cashU.exe>" "%1"`: the link arrives
 * in argv at a first start and through `second-instance` afterwards.
 */
export function shouldRegisterProtocol(opts: {
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): boolean {
  if (!opts.isPackaged) return false;
  return opts.platform === "win32" || opts.env[ENV.registerProtocol] === "1";
}
