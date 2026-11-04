import { builtinRegistry } from "@cashu/domain/core";
import type { HostService } from "@cashu/node-host";
import { mcpProfile } from "@cashu/store/core";
import type { HostStores, OpenVault } from "../stores.js";
import { type HostWorker, WorkerTickBusy } from "../worker/service.js";
import type { WorkspaceProvider } from "../workspace/index.js";
import type { PortedCommand } from "./tree.js";

export interface WorkerWorkspaceCliDeps {
  readonly stores: Pick<HostStores, "vaults">;
  readonly workspace?: WorkspaceProvider;
  readonly worker: () => HostWorker | null;
  readonly service?: () => HostService | null;
}

const M = {
  usageWorker: {
    pl: "Użycie: cashu worker run|install|uninstall|status [--json]",
    en: "Usage: cashu worker run|install|uninstall|status [--json]",
  },
  usageWorkspace: {
    pl: "Użycie: cashu workspace init|update|path --profile SLUG",
    en: "Usage: cashu workspace init|update|path --profile SLUG",
  },
  unavailable: {
    pl: "Ta funkcja nie jest dostępna w bieżącym hoście.",
    en: "This capability is unavailable in the current host.",
  },
  serviceUi: {
    pl: "Zmień codzienne uruchamianie w Ustawieniach > Uruchamianie po zamknięciu aplikacji.",
    en: "Change daily start in Settings > Start after closing the app.",
  },
  notifierUnavailable: {
    pl: "Wybrany sposób powiadamiania nie jest dostępny w tym hoście.",
    en: "The selected notification transport is unavailable in this host.",
  },
  profile: { pl: "Podaj jeden istniejący profil.", en: "Select one existing profile." },
  failed: { pl: "Operacja nie powiodła się.", en: "The operation failed." },
  busy: { pl: "Pracownik jest zajęty.", en: "The worker is busy." },
  done: { pl: "Gotowe.", en: "Done." },
} as const;

function parse(
  args: readonly string[],
  flags: readonly string[],
): {
  action: string;
  options: Set<string>;
  profile?: string;
  path?: string;
  notifier?: string;
} | null {
  const [action, ...tail] = args;
  if (!action) return null;
  const options = new Set<string>();
  let profile: string | undefined;
  let path: string | undefined;
  let notifier: string | undefined;
  for (let i = 0; i < tail.length; i++) {
    const token = tail[i];
    if (token === "--profile" || token === "-p" || token === "--path") {
      const value = tail[++i];
      if (!value) return null;
      if (token === "--path") path = value;
      else if (profile && profile !== value) return null;
      else profile = value;
    } else if (token === "--notifier" && flags.includes(token)) {
      const value = tail[++i];
      if (!value || notifier !== undefined) return null;
      notifier = value;
    } else if (token?.startsWith("--notifier=") && flags.includes("--notifier")) {
      if (notifier !== undefined || token.length === "--notifier=".length) return null;
      notifier = token.slice("--notifier=".length);
    } else if (token && flags.includes(token)) options.add(token);
    else return null;
  }
  return {
    action,
    options,
    ...(profile ? { profile } : {}),
    ...(path ? { path } : {}),
    ...(notifier ? { notifier } : {}),
  };
}

function vaultFor(stores: Pick<HostStores, "vaults">, slug: string): OpenVault | null {
  const matches = [...stores.vaults.values()].filter(
    (vault) =>
      mcpProfile(vault.store.read.bind(vault.store))?.slug === slug &&
      vault.native?.isCurrent() === true,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function workerWorkspaceCommands(deps: WorkerWorkspaceCliDeps): readonly PortedCommand[] {
  const modules = builtinRegistry().modules;
  return [
    {
      name: "worker",
      async run(args, io) {
        const parsed = parse(args, [
          "--json",
          "--offline",
          "--budget",
          "--no-budget",
          "--notifier",
        ]);
        if (
          !parsed ||
          !["run", "install", "uninstall", "status"].includes(parsed.action) ||
          parsed.profile ||
          parsed.path ||
          (parsed.action !== "run" &&
            (parsed.notifier !== undefined ||
              parsed.options.has("--offline") ||
              parsed.options.has("--budget") ||
              parsed.options.has("--no-budget"))) ||
          (parsed.options.has("--budget") && parsed.options.has("--no-budget"))
        ) {
          io.stderr(`${io.t.tr(M.usageWorker)}\n`);
          return 2;
        }
        const worker = deps.worker();
        if (parsed.action === "status") {
          if (!worker) {
            io.stderr(`${io.t.tr(M.unavailable)}\n`);
            return 69;
          }
          const status = worker.status();
          io.stdout(
            parsed.options.has("--json")
              ? `${JSON.stringify(status)}\n`
              : `Worker: ${status.state}; next: ${status.nextRunAt ?? "-"}\n`,
          );
          return 0;
        }
        if (parsed.action === "run") {
          if (!worker) {
            io.stderr(`${io.t.tr(M.unavailable)}\n`);
            return 69;
          }
          if (io.signal.aborted) return 130;
          if (
            parsed.notifier !== undefined &&
            !["auto", "app", "terminal-notifier", "osascript", "log", "none"].includes(
              parsed.notifier,
            )
          ) {
            io.stderr(`${io.t.tr(M.usageWorker)}\n`);
            return 2;
          }
          if (
            ["terminal-notifier", "osascript", "log"].includes(parsed.notifier ?? "") ||
            (parsed.notifier === "app" && !worker.hasAppNotifier)
          ) {
            io.stderr(`${io.t.tr(M.notifierUnavailable)}\n`);
            return 69;
          }
          try {
            const options = {
              ...(parsed.options.has("--offline") ? { offline: true } : {}),
              ...(parsed.options.has("--no-budget") ? { budget: false } : {}),
              ...(parsed.notifier === "none"
                ? { notifier: "none" as const }
                : parsed.notifier === "app"
                  ? { notifier: "app" as const }
                  : {}),
            };
            await worker.tick(true, Object.keys(options).length === 0 ? undefined : options);
          } catch (error) {
            io.stderr(`${io.t.tr(error instanceof WorkerTickBusy ? M.busy : M.failed)}\n`);
            return 1;
          }
          if (io.signal.aborted) return 130;
          const status = worker.status();
          io.stdout(
            parsed.options.has("--json")
              ? `${JSON.stringify(status)}\n`
              : `Worker: ${status.state}\n`,
          );
          return status.state === "error" ? 1 : 0;
        }
        const service = deps.service?.();
        if (!service) {
          io.stderr(`${io.t.tr(M.serviceUi)}\n`);
          return 69;
        }
        const result =
          parsed.action === "install" ? await service.enable() : await service.disable();
        io.stdout(
          parsed.options.has("--json")
            ? `${JSON.stringify(result)}\n`
            : `Service: ${result.state}\n`,
        );
        return result.state === "error" || result.state === "unavailable" ? 1 : 0;
      },
    },
    {
      name: "workspace",
      async run(args, io, root) {
        const parsed = parse(args, [
          "--force",
          "--routine-permissions",
          "--no-routine-permissions",
        ]);
        if (
          !parsed ||
          !["init", "update", "path"].includes(parsed.action) ||
          (parsed.path && parsed.action !== "init") ||
          (root.profile && parsed.profile && root.profile !== parsed.profile)
        ) {
          io.stderr(`${io.t.tr(M.usageWorkspace)}\n`);
          return 2;
        }
        const slug = parsed.profile ?? root.profile ?? io.env.CASHU_PROFILE;
        const vault = slug ? vaultFor(deps.stores, slug) : null;
        if (!vault || !slug) {
          io.stderr(`${io.t.tr(M.profile)}\n`);
          return 1;
        }
        const binding = deps.workspace?.bind(vault.id);
        if (!binding?.isCurrent()) {
          io.stderr(`${io.t.tr(M.unavailable)}\n`);
          return 69;
        }
        const profile = mcpProfile(vault.store.read.bind(vault.store));
        if (!profile) {
          io.stderr(`${io.t.tr(M.profile)}\n`);
          return 1;
        }
        const base = {
          slug,
          modules: [...modules.values()]
            .filter((module) => profile.modules.includes(module.id))
            .map((module) => ({ id: module.id, name: module.name })),
          privacy: profile.mcpPrivacy === "amounts" ? ("amounts" as const) : ("strict" as const),
          baseCurrency: profile.baseCurrency,
        } as const;
        if (parsed.action === "path") {
          const result = await binding.inspect(base);
          if (result.availability !== "ready") {
            io.stderr(`${io.t.tr(M.unavailable)}\n`);
            return 69;
          }
          io.stdout(`${result.path}\n`);
          return 0;
        }
        const result = await binding.apply({
          ...base,
          ...(parsed.path ? { path: parsed.path } : {}),
          force: parsed.options.has("--force"),
          ...(parsed.options.has("--routine-permissions") ? { routinePermissions: true } : {}),
          ...(parsed.options.has("--no-routine-permissions") ? { routinePermissions: false } : {}),
          isCurrent: () => binding.isCurrent() && !io.signal.aborted,
        });
        if (result.kind !== "completed") {
          io.stderr(`${io.t.tr(M.failed)} (${result.code})\n`);
          return 1;
        }
        io.stdout(
          `${io.t.tr(M.done)}\n${result.status.availability === "ready" ? result.status.path : ""}\n`,
        );
        return 0;
      },
    },
  ];
}
