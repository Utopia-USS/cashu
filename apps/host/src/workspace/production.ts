import { isAbsolute, join, resolve } from "node:path";
import type { SkillSource } from "@cashu/domain/core";
import { builtinRegistry } from "@cashu/domain/core";
import { enabledModuleIds } from "@cashu/store/core";
import { z } from "zod";
import { TOOL_INVENTORY } from "../mcp/tools.js";
import type { NativeVaultSession } from "../nativeVault.js";
import type { NativeVaultInventoryEntry } from "../sync/keys/deviceAuthority.js";
import { createInjectedWorkspaceProvider, type WorkspaceVaultAuthority } from "./adapter.js";
import type { WorkspaceProvider } from "./index.js";
import { createProductionPublication, readCheckedText, secureTreeHash } from "./publication.js";

const ID = /^[0-9a-f]{32}$/;
const canonicalAbsolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => isAbsolute(path) && resolve(path) === path);
const configSchema = z
  .object({
    format: z.literal(1),
    vaultId: z.string().regex(ID),
    path: canonicalAbsolute,
    routinePermissions: z.boolean(),
  })
  .strict();
const SKILLS = [
  "workspace-setup",
  "budget-setup",
  "assets-setup",
  "loans-setup",
  "investments-setup",
  "import-builder",
  "extension-builder",
  "market-research",
  "review",
] as const;
const registry = builtinRegistry();

function shippedSkill(root: string, name: string): SkillSource | null {
  const path = join(root, name);
  const body = readCheckedText(join(path, "SKILL.md"), 1024 * 1024);
  if (body === null) return null;
  if (!body.startsWith("---\n")) throw new Error("invalid_skill_source");
  const close = body.indexOf("\n---", 4);
  if (close < 0) throw new Error("invalid_skill_source");
  const head = body.slice(4, close).split(/\s+/).join(" ");
  const scope =
    /Applicability - POSITIVE:\s*(.*?)\s*Applicability - NEGATIVE:\s*(.*?)(?:\s*Triggers:|$)/.exec(
      head,
    );
  if (!scope) throw new Error("invalid_skill_source");
  return {
    name,
    version: secureTreeHash(path),
    positive: scope[1] ?? "",
    negative: scope[2] ?? "",
  };
}

export interface ProductionWorkspaceOptions {
  readonly dataRoot: string;
  readonly home: string;
  readonly workspacesRoot: string;
  readonly checkout?: string;
  /** Host-known legacy/source roots beyond the native data root and checkout. */
  readonly protectedRoots?: readonly string[];
  readonly skillSource: string;
  readonly version: string;
  readonly program: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
  };
  sessions(vault: string): NativeVaultSession | null;
  inventory(): readonly NativeVaultInventoryEntry[];
  now?(): Date;
}

function configClaim(dataRoot: string, vault: string): string | null {
  const file = join(dataRoot, "workspace", "v1", `${vault}.json`);
  const text = readCheckedText(file, 4096);
  if (text === null) return null;
  const config = configSchema.parse(JSON.parse(text));
  if (config.vaultId !== vault) throw new Error("invalid_workspace_claim");
  return config.path;
}

/** Native Create and one-shot imported vaults use the same authenticated open-session source. */
export function createProductionWorkspaceProvider(
  options: ProductionWorkspaceOptions,
): WorkspaceProvider {
  const listeners = new Set<(vault: string) => void>();
  const baseProtectedRoots = [
    options.dataRoot,
    options.skillSource,
    ...(options.checkout ? [options.checkout] : []),
    ...(options.protectedRoots ?? []),
  ];
  if (baseProtectedRoots.some((root) => !canonicalAbsolute.safeParse(root).success))
    throw new Error("invalid_workspace_protected_root");
  const shipped = new Map(
    SKILLS.flatMap((name) => {
      const source = shippedSkill(options.skillSource, name);
      return source ? [[name, source] as const] : [];
    }),
  );
  const source = {
    bind(vault: string): WorkspaceVaultAuthority | null {
      if (!ID.test(vault)) return null;
      const session = options.sessions(vault);
      const native = session?.workspaceAuthority();
      if (!session || !native || session.id !== vault || native.vault !== vault) return null;
      const inventory = options.inventory();
      const entry = inventory.find((item) => item.vaultId === vault && item.state === "ready");
      if (!entry || inventory.filter((item) => item.vaultId === vault).length !== 1) return null;
      if (inventory.some((item) => !canonicalAbsolute.safeParse(item.vaultRoot).success))
        return null;
      const protectedRoots = [...baseProtectedRoots, ...inventory.map((item) => item.vaultRoot)];
      const profile = session.store.read<{ slug: string; baseCurrency: string; privacy: string }>(
        "SELECT slug, base_currency AS baseCurrency, mcp_privacy AS privacy FROM profiles",
      );
      if (
        profile.length !== 1 ||
        !profile[0] ||
        !["strict", "amounts"].includes(profile[0].privacy)
      )
        return null;
      const { slug, baseCurrency, privacy } = profile[0];
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(slug)) return null;
      const enabled = enabledModuleIds(session.store.read.bind(session.store));
      const modules = [...registry.modules.values()]
        .filter((module) => enabled.has(module.id))
        .map((module) => ({ id: module.id, name: module.name }));
      const claims = new Map<string, string>();
      try {
        for (const item of inventory) {
          if (!ID.test(item.vaultId)) return null;
          const claim = configClaim(options.dataRoot, item.vaultId);
          if (claim) claims.set(item.vaultId, claim);
        }
      } catch {
        return null;
      }
      const defaultPath = join(options.workspacesRoot, slug);
      const config = join(options.dataRoot, "workspace", "v1", `${vault}.json`);
      const context = JSON.stringify({ slug, baseCurrency, privacy, modules });
      const claimInventory = JSON.stringify(
        inventory.map((item) => [item.vaultId, item.state, item.vaultRoot]),
      );
      let valid = true;
      const current = () => {
        if (!valid) return false;
        if (options.sessions(vault) !== session || !native.isCurrent()) {
          valid = false;
          return false;
        }
        try {
          const latestInventory = options.inventory();
          if (
            JSON.stringify(
              latestInventory.map((item) => [item.vaultId, item.state, item.vaultRoot]),
            ) !== claimInventory
          ) {
            valid = false;
            return false;
          }
          for (const item of latestInventory) {
            if (
              configClaim(options.dataRoot, item.vaultId) !== (claims.get(item.vaultId) ?? null)
            ) {
              valid = false;
              return false;
            }
          }
          const fresh = session.store.read<{ slug: string; baseCurrency: string; privacy: string }>(
            "SELECT slug, base_currency AS baseCurrency, mcp_privacy AS privacy FROM profiles",
          );
          if (fresh.length !== 1 || !fresh[0]) {
            valid = false;
            return false;
          }
          const enabledNow = enabledModuleIds(session.store.read.bind(session.store));
          const modulesNow = [...registry.modules.values()]
            .filter((module) => enabledNow.has(module.id))
            .map((module) => ({ id: module.id, name: module.name }));
          valid = JSON.stringify({ ...fresh[0], modules: modulesNow }) === context;
          return valid;
        } catch {
          valid = false;
          return false;
        }
      };
      const now = options.now ?? (() => new Date());
      return {
        vault,
        generation: native.generation,
        slug,
        version: options.version,
        modules,
        privacy: privacy as "strict" | "amounts",
        baseCurrency,
        dataRoot: options.dataRoot,
        defaultPath,
        policy: { home: options.home, protectedRoots, checkout: options.checkout, claims },
        shipped,
        skillsSourceAvailable: shipped.size === SKILLS.length,
        invocation: {
          command: options.program.command,
          args: [...options.program.args, "mcp", "--profile", slug],
          ...(options.program.env ? { env: options.program.env } : {}),
          server: `cashu-${slug}`,
        },
        cli: [options.program.command, ...options.program.args],
        tools: TOOL_INVENTORY.filter(
          (tool) =>
            tool.module === "core" ||
            enabled.has(tool.module) ||
            tool.also.some((module) => enabled.has(module)),
        ).map((tool) => ({ name: tool.name, module: tool.module, write: tool.write })),
        protected: protectedRoots,
        publication: createProductionPublication({
          workspace: defaultPath,
          config,
          skillSource: options.skillSource,
          isCurrent: current,
        }),
        publicationFor: (path) =>
          createProductionPublication({
            workspace: path,
            config,
            skillSource: options.skillSource,
            isCurrent: current,
          }),
        recordConfiguredPath: (path) => {
          claims.set(vault, path);
        },
        isCurrent: current,
        now: () => now().toISOString(),
        stamp: () =>
          now()
            .toISOString()
            .replace(/[-:TZ.]/g, "")
            .slice(0, 14),
      };
    },
  };
  const provider = createInjectedWorkspaceProvider(source);
  return {
    changes: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    bind(vault) {
      const binding = provider.bind(vault);
      if (!binding) return null;
      return {
        ...binding,
        async apply(input) {
          try {
            return await binding.apply(input);
          } finally {
            // A partial or thrown operation may already have published file effects.
            for (const listener of [...listeners]) {
              try {
                listener(vault);
              } catch {
                // Observation cannot change an already completed publication result.
                process.emitWarning("workspace_change_listener_failed");
              }
            }
          }
        },
      };
    },
  };
}
