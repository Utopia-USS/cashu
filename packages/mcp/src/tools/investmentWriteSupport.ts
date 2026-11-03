/** Shared transport adapters only; validation and effects stay in native commands. */
import { pyStrip, pyUpper } from "@cashu/domain";
import { type Command, type CommandContext, defineCommand, ok } from "@cashu/store";
import * as Q from "@cashu/store/investments/queries";
import { type ToolContext, ToolError } from "../registry.js";
import { decodeEntityRef, type EntityRefKind } from "../runtime/refs.js";
import type { NativeToolStore } from "../runtime/types.js";
export type Context = ToolContext<NativeToolStore>;
/** Current checked profile files, normalized exactly like Python Path.read_text. */
export function currentStrategyFiles(ctx: Context) {
  const service = ctx.store.investmentWrites;
  const files = service?.strategyFiles;
  if (!service || !files)
    throw new ToolError("native strategy-file authority is unavailable", "unsupported");
  if (files.vault !== service.vault)
    throw new Error("native strategy-file vault binding is inconsistent");
  if (!files.isCurrent())
    throw new ToolError("native strategy-file authority is unavailable", "unsupported");
  const raw = files.read();
  if (!files.isCurrent())
    throw new ToolError("native strategy-file authority is unavailable", "unsupported");
  const normalize = (value: string | null) => value?.replace(/\r\n?/gu, "\n") ?? null;
  const base = { yaml: normalize(raw.yaml), md: normalize(raw.md) };
  const checked = {
    vault: files.vault,
    isCurrent: files.isCurrent.bind(files),
    read: () => {
      const next = files.read();
      return { yaml: normalize(next.yaml), md: normalize(next.md) };
    },
  };
  return { service, files: checked, base };
}
export function reference(kind: EntityRefKind, raw: unknown): string {
  try {
    if (typeof raw !== "string") throw new Error();
    return decodeEntityRef(kind, raw);
  } catch {
    throw new ToolError(`no such ${kind} in this profile`, "not_found");
  }
}
export function instrument(
  ctx: ToolContext<Pick<NativeToolStore, "read">>,
  raw: unknown,
  broad = false,
): string {
  if (typeof raw !== "string")
    throw new ToolError("no such instrument in this profile", "not_found");
  const ref =
    raw.includes(":") && /^[a-z_]+:[uv][a-p]+$/u.test(raw) ? reference("instrument", raw) : raw;
  if (ref === raw && [...raw].length > 40)
    throw new ToolError("instrument is too long (max 40)", "invalid_arguments", { system: true });
  const owned = Q.vaultInstrumentGids(ctx.store.read);
  if (ref !== raw) {
    const root = Q.instrumentGid(ctx.store.read, ref);
    if (root !== undefined && owned.has(root)) return root;
    throw new ToolError("no such instrument in this profile", "not_found");
  }
  const wanted = pyUpper(pyStrip(raw));
  const matches = [...Q.loadInstruments(ctx.store.read, owned).values()].filter(
    (i) =>
      pyUpper(i.symbol ?? "") === wanted ||
      pyUpper(i.isin ?? "") === wanted ||
      (broad &&
        i.aliases.some((alias) => alias.namespace === "yahoo" && pyUpper(alias.value) === wanted)),
  );
  if (matches.length === 1 && matches[0]) return matches[0].id;
  throw new ToolError(
    matches.length > 1
      ? "several instruments match; pass the instrument_id from positions"
      : "no such instrument in this profile (see positions)",
    matches.length > 1 ? "invalid" : "not_found",
  );
}
export function execute<I, V>(ctx: Context, command: Command<I, V>, input: unknown): V {
  const out = ctx.store.run(command, input);
  if (!out.ok) {
    const messages: Record<string, string> = {
      needs_held: "reduce and exit_asap require a held instrument",
      reason_too_long: "reason is too long (max 280 characters)",
      incomplete_coverage:
        "recommendation coverage incomplete; see research_context for rows with recommendation null",
      outside_scope: "recommendation is outside the selected scope",
      duplicate_instrument: "recommendations duplicate an instrument",
      no_instrument: "no such instrument in this profile",
      no_signal: "no such signal in this profile (see signals)",
      no_item: "no such watchlist item in this profile (see watchlist)",
      no_alert: "no such alert in this profile (see alerts)",
      already_watched: "the instrument is already watched",
      agent_alert_limit:
        "At most 50 active agent alerts per profile; mute or let some expire first",
      invalid_entry_type: "unknown entry_type",
      thesis_required: "thesis is required",
      watchlist_full: "watchlist is full (max 200)",
    };
    throw new ToolError(
      messages[out.reason] ?? `investment write refused: ${out.reason}`,
      out.reason === "incomplete_coverage"
        ? "incomplete_coverage"
        : out.reason === "outside_scope" || out.reason === "duplicate_instrument"
          ? "invalid_arguments"
          : out.reason === "agent_alert_limit"
            ? "limit"
            : out.reason === "already_watched"
              ? "conflict"
              : out.reason.startsWith("no_")
                ? "not_found"
                : "invalid",
    );
  }
  return out.value;
}
export function capture<I, V>(command: Command<I, V>) {
  return defineCommand({
    id: `${command.id}.mcp`,
    input: command.input,
    run(ctx, input) {
      const effects: { type: string; gid: string; data: Record<string, unknown> }[] = [];
      const child: CommandContext = {
        ...ctx,
        emit(type, gid, data, options) {
          effects.push({ type, gid, data });
          return ctx.emit(type, gid, data, options);
        },
      };
      const out = command.run(child, input);
      return out.ok ? ok({ value: out.value, effects }) : out;
    },
  });
}
