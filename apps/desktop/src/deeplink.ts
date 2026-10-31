import { ENV } from "./config.js";

/**
 * Registering a URL handler is a system-wide change (LaunchServices on macOS). It happens only
 * for the packaged app and only when asked for; a development run never registers anything, links
 * reach it as `--open-link=cashu://...` or as the argument of a second launch instead.
 */
export function shouldRegisterProtocol(opts: {
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
}): boolean {
  return opts.isPackaged && opts.env[ENV.registerProtocol] === "1";
}
