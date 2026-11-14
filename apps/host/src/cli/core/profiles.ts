import { slugify } from "@cashu/domain/core";
import { nativeCreationPrepareParamsSchema } from "@cashu/host-protocol";
import { mcpProfile } from "@cashu/store/core";
import type { createNativeCreationService } from "../../nativeCreation.js";
import type { HostStores } from "../../stores.js";
import { richTable } from "../budget/richTable.js";
import { parse } from "../nativeInput.js";
import type { CommandIo, PortedCommand } from "../tree.js";
import { C } from "./strings.js";

type Creation = Pick<
  ReturnType<typeof createNativeCreationService>,
  "prepare" | "commit" | "inspect"
>;
interface ProfileDeps {
  readonly stores: Pick<HostStores, "vaults">;
  readonly creation?: Creation;
  readonly onCreationReady?: () => void;
}

async function add(args: readonly string[], io: CommandIo, deps: ProfileDeps): Promise<number> {
  const parsed = parse(args, ["--currency", "--modules", "--privacy"]);
  if (parsed?.args.length !== 1) {
    io.stderr(`${io.t.tr(C.profileAddUsage)}\n`);
    return 2;
  }
  if (!io.tty.stdin || !io.tty.stdout || !io.tty.stderr) {
    io.stderr(`${io.t.tr(C.createTty)}\n`);
    return 2;
  }
  if (!deps.creation) {
    io.stderr(`${io.t.tr(C.createUnavailable)}\n`);
    return 69;
  }
  const name = parsed.args[0] as string;
  const slugs = new Set(
    [...deps.stores.vaults.values()].map((v) => mcpProfile(v.store.read.bind(v.store))?.slug),
  );
  const base = slugify(name);
  let slug = base;
  for (let i = 2; slugs.has(slug); i++) slug = `${base}-${i}`;
  const modules = (parsed.options.get("--modules") ?? "budget,assets,loans")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const input = nativeCreationPrepareParamsSchema.safeParse({
    name,
    slug,
    baseCurrency: parsed.options.get("--currency") ?? "PLN",
    modules,
    mcpPrivacy: parsed.options.get("--privacy") ?? "strict",
  });
  if (!input.success) {
    io.stderr(`${io.t.tr(C.invalidProfile)}\n`);
    return 2;
  }
  if (io.signal.aborted) return 130;
  const prepared = await deps.creation.prepare(input.data);
  if (prepared.kind !== "prepared") {
    io.stderr(`${io.t.tr(C.createRefused)(prepared.code)}\n`);
    return 1;
  }
  if (io.signal.aborted) return 130;
  io.stdout(`${io.t.tr(C.recoveryPhrase)(prepared.words)}\n`);
  const repeated = await io.prompt(io.t.tr(C.recoveryPrompt), { hidden: true });
  if (io.signal.aborted) return 130;
  if (repeated !== prepared.words) {
    io.stderr(`${io.t.tr(C.recoveryMismatch)}\n`);
    return 1;
  }
  io.stdout(`${io.t.tr(C.creationOperation)(prepared.operationId)}\n`);
  let result: Awaited<ReturnType<Creation["commit"]>>;
  try {
    result = await deps.creation.commit({
      operationId: prepared.operationId,
      phraseSession: prepared.phraseSession,
    });
  } catch {
    io.stderr(`${io.t.tr(C.creationUnknown)(prepared.operationId)}\n`);
    return 1;
  }
  if (result.kind === "ready") {
    io.stdout(`${io.t.tr(C.creationReady)(result.profileSlug)}\n`);
    deps.onCreationReady?.();
    return 0;
  }
  if (result.kind === "outcome_unknown") {
    io.stderr(`${io.t.tr(C.creationUnknown)(prepared.operationId)}\n`);
    return 1;
  }
  io.stderr(`${io.t.tr(C.creationRefusedInspect)(result.code, prepared.operationId)}\n`);
  return 1;
}

async function inspect(args: readonly string[], io: CommandIo, deps: ProfileDeps): Promise<number> {
  if (args.length !== 1 || !/^[0-9a-f]{32}$/.test(args[0] ?? "")) {
    io.stderr(`${io.t.tr(C.profileInspectUsage)}\n`);
    return 2;
  }
  if (!deps.creation) {
    io.stderr(`${io.t.tr(C.statusUnavailable)}\n`);
    return 69;
  }
  const result = await deps.creation.inspect({ operationId: args[0] as string });
  const message =
    result.kind === "pending"
      ? io.t.tr(C.inspectPending)(result.operationId, result.stage)
      : result.kind === "outcome_unknown"
        ? io.t.tr(C.inspectUnknown)(result.operationId, result.stage)
        : result.kind === "ready"
          ? io.t.tr(C.inspectReady)(result.operationId)
          : io.t.tr(C.inspectMissing)(result.operationId);
  io.stdout(`${message}\n`);
  if (result.kind === "ready" && !deps.stores.vaults.has(result.vaultId)) deps.onCreationReady?.();
  return result.kind === "ready" ? 0 : 1;
}

export function profileCommands(deps: ProfileDeps): PortedCommand[] {
  return [
    {
      name: "profiles",
      async run(args, io: CommandIo) {
        if (args[0] === "add") return add(args.slice(1), io, deps);
        if (args[0] === "inspect") return inspect(args.slice(1), io, deps);
        if (args.length !== 1 || args[0] !== "list") {
          io.stderr(`${io.t.tr(C.profileUsage)}\n`);
          return 2;
        }
        const rows = [...deps.stores.vaults.values()]
          .map((vault) => mcpProfile(vault.store.read.bind(vault.store)))
          .filter((row) => row !== undefined);
        if (rows.length === 0) {
          io.stdout(`${io.t.tr(C.noProfiles)}\n`);
          return 0;
        }
        const table = richTable(
          io,
          io.t.tr(C.profileHeaders).map((header) => ({ header })),
          rows.map((p) => [
            p.slug,
            p.name,
            p.baseCurrency,
            p.mcpPrivacy,
            p.modules.join(", ") || "-",
          ]),
          io.t.tr(C.profilesTitle),
        );
        if (table === null) {
          io.stderr(`${io.t.tr(C.profileRender)}\n`);
          return 2;
        }
        io.stdout(table);
        return 0;
      },
    },
  ];
}
