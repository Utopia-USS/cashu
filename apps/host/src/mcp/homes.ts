// Path.expanduser compatibility at the host filesystem boundary. Captured account-directory
// lookups run only for explicitly named ~user inputs; never through a shell or into logs.
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { win32 } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;
const accountLookup = (command: string, args: readonly string[]) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024,
  });
export function mcpFileHome(
  env: Environment,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") return env.HOME ?? userInfo().homedir;
  if (env.USERPROFILE !== undefined) return env.USERPROFILE;
  return env.HOMEPATH === undefined ? undefined : win32.join(env.HOMEDRIVE ?? "", env.HOMEPATH);
}
export function mcpNamedHome(
  name: string,
  env: Environment,
  platform: NodeJS.Platform = process.platform,
  lookup: (command: string, args: readonly string[]) => string = accountLookup,
): string | undefined {
  if (platform === "win32") {
    const home = mcpFileHome(env, platform);
    if (home === undefined || name === env.USERNAME) return home;
    return env.USERNAME === win32.basename(home)
      ? win32.join(win32.dirname(home), name)
      : undefined;
  }
  if (platform !== "darwin" && platform !== "linux") return undefined;
  try {
    // macOS id -P uses the account database (including directory accounts), unlike a local-only
    // dscl query. Linux getent uses its corresponding NSS database. -- prevents option injection.
    const line = lookup(
      platform === "darwin" ? "/usr/bin/id" : "/usr/bin/getent",
      platform === "darwin" ? ["-P", "--", name] : ["--", "passwd", name],
    ).replace(/\r?\n$/, "");
    const fields = line.split(":");
    if (fields.length !== (platform === "darwin" ? 10 : 7) || line.includes("\n")) return undefined;
    // Both utilities also accept numeric UIDs. Python getpwnam(~user) accepts only names.
    if (/^[+-]?\d+$/.test(name) && fields[0] !== name) return undefined;
    return fields[platform === "darwin" ? 8 : 5];
  } catch {
    return undefined;
  }
}
