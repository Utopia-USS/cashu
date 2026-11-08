import {
  issueText,
  STRATEGY_TEMPLATE_NAMES,
  strategyTemplate,
} from "@cashu/domain/investments/strategy";
import { enabledModuleIds, mcpProfile } from "@cashu/store/core";
import {
  DurableWriteUnknown,
  loadStrategy,
  type StrategyFilesPort,
} from "@cashu/store/investments/services";
import { cliCommandKey, runCliVaultCommand } from "../commandOutcome.js";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { type InvestmentCliDeps, investmentVault } from "./context.js";
import { UNHANDLED } from "./inspection.js";
import { investmentCliText as M, strategyState } from "./strings.js";

function initArgs(args: readonly string[]): { template: string; force: boolean } | null {
  let template: string = STRATEGY_TEMPLATE_NAMES[0] ?? "passive_etf";
  let force = false;
  let seen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--force" && !force) force = true;
    else if (arg === "--template" && !seen && args[i + 1]) {
      template = args[++i] as string;
      seen = true;
    } else if (arg?.startsWith("--template=") && !seen) {
      template = arg.slice(11);
      seen = true;
    } else return null;
  }
  return template ? { template, force } : null;
}

export async function strategy(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: InvestmentCliDeps,
): Promise<number | typeof UNHANDLED> {
  const [action, ...rest] = args;
  if (action !== "init" && action !== "validate") return UNHANDLED;
  if (action === "validate" && rest.length) return UNHANDLED;
  const parsed = action === "init" ? initArgs(rest) : null;
  if (action === "init" && !parsed) return UNHANDLED;
  const vault = investmentVault(io, root, deps);
  const slug = root.profile || io.env.CASHU_PROFILE;
  if (!vault || !slug || !deps.strategyFiles) return UNHANDLED;
  const source = deps.strategyFiles(vault, slug);
  if (!source) return UNHANDLED;
  if (action === "init" && !source.createAbsent) return UNHANDLED;
  if (action === "init" && parsed?.force && !source.replaceForced) {
    io.stderr(`${io.t.tr(M.forceUnavailable)}\n`);
    return 2;
  }
  const read = vault.store.read.bind(vault.store);
  const current = () =>
    !io.signal.aborted &&
    deps.stores.vaults.get(vault.id) === vault &&
    mcpProfile(read)?.slug === slug &&
    enabledModuleIds(read).has("investments");
  if (!current()) return UNHANDLED;
  const files: StrategyFilesPort = {
    read(name) {
      if (!current()) throw new Error("strategy_authority_changed");
      return source.read(name);
    },
    exists(name) {
      if (!current()) throw new Error("strategy_authority_changed");
      return source.exists(name);
    },
    write(name, text) {
      if (!current()) throw new Error("strategy_authority_changed");
      return source.write(name, text);
    },
  };
  if (io.signal.aborted) return 130;
  if (action === "init" && parsed) {
    const written: string[] = [];
    let attempted: string | null = null;
    const partial = () => {
      io.stderr(`${io.t.tr(M.partialStrategy)}\n`);
      if (written.length) io.stderr(`${io.t.tr(M.completedFiles)} ${written.join(", ")}\n`);
      if (attempted) io.stderr(`${io.t.tr(M.attemptedFile)} ${attempted}\n`);
      return 1;
    };
    try {
      return await vault.queue.run(async () => {
        const template = strategyTemplate(parsed.template);
        if (!template) {
          io.stderr(`${io.t.tr(M.unknownTemplate)}\n`);
          return 2;
        }
        if (
          !parsed.force &&
          ((await files.exists("strategy.yaml")) || (await files.exists("strategy.md")))
        ) {
          io.stderr(`${io.t.tr(M.strategyExists)}\n`);
          return 2;
        }
        for (const [name, text] of [
          ["strategy.yaml", template.yaml],
          ["strategy.md", template.markdown],
        ] as const) {
          if (!current()) {
            return partial();
          }
          attempted = name;
          const result = parsed.force
            ? await source.replaceForced?.(name, text).then(() => "created" as const)
            : await source.createAbsent?.(name, text);
          if (!current()) {
            return partial();
          }
          if (result !== "created") {
            if (name !== "strategy.yaml") return partial();
            io.stderr(`${io.t.tr(M.strategyExists)}\n`);
            return 1;
          }
          written.push(name);
          attempted = null;
          printConsole(io, `${io.t.tr(M.written)} ${name}`);
        }
        return 0;
      });
    } catch {
      return partial();
    }
  }
  try {
    // Recording needs the device's private journal: without it the files are only read.
    const state =
      source.sync === undefined
        ? await loadStrategy(vault.store, files)
        : await loadStrategy(vault.store, files, {
            record: true,
            writer: vault.writer,
            env: vault.env,
            sync: source.sync,
            beforeRecord: current,
            durableWrite: (command, input) =>
              runCliVaultCommand(vault, command, input, cliCommandKey(), current),
          });
    if (!current()) {
      io.stderr(`${io.t.tr(M.contextChanged)}\n`);
      return 1;
    }
    if (state.state === "missing") {
      printConsole(io, io.t.tr(M.noStrategy));
      return 1;
    }
    printConsole(
      io,
      `strategy.yaml: ${io.t.tr(strategyState[state.state])}${state.version ? ` (${io.t.tr(M.version)} ${state.version.version})` : ""}`,
      { highlight: false },
    );
    if (state.readError)
      printConsole(io, `  ${io.t.tr(M.error)} ${state.readError}`, { highlight: false });
    for (const issue of state.issues)
      printConsole(io, `  ${issueText(issue)}`, { highlight: false });
    for (const rule of state.inactiveRules)
      printConsole(
        io,
        `  ${io.t.tr(M.inactiveRule)} ${rule.ruleId || rule.index} (${io.t.tr(M.line)} ${rule.line})`,
        {
          highlight: false,
        },
      );
    return state.state === "invalid" ? 1 : 0;
  } catch (error) {
    if (error instanceof DurableWriteUnknown) {
      io.stderr(
        `${io.t.tr(M.unknownOutcome)} cashu command-status ${error.commandId} ${error.key}. ${io.t.tr(M.doNotRetry)}\n`,
      );
      return 1;
    }
    io.stderr(`${io.t.tr(M.strategyFailed)}\n`);
    return 1;
  }
}
