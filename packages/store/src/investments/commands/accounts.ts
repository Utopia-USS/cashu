// Brokerage accounts (Python `service/accounts.py`, write side): a core account of type `brokerage`
// (bank = a broker / exchange / manual institution) plus its investments settings (tax wrapper,
// remembered importer and generic CSV mapping, `invAccount.settingsSet`, LWW per field).
import { pyCasefold, pyStrip, pyUpper } from "@cashu/domain";
import { builtinRegistry, MANUAL_INSTITUTION } from "@cashu/domain/core";
import { GENERIC_CSV_BROKER_ID } from "@cashu/domain/investments/importing";
import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../../command.js";
import { ensureAccount } from "../../core/commands.js";
import { ACCOUNT_WRAPPERS } from "../../events/v1/investments.js";
import { accountSettings, BROKERAGE, brokerageAccounts } from "../queries/transactions.js";

const institutions = builtinRegistry().institutions;

/** Python `broker_ids`: institutions a brokerage account may belong to. */
export function brokerIds(): string[] {
  return [...institutions.ids("broker"), ...institutions.ids("exchange"), MANUAL_INSTITUTION];
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID's 128 bits as 32 lower-case hex digits (Python `uuid4().hex` shape). */
function ulidHex(ulid: string): string {
  let n = 0n;
  for (const ch of ulid) n = n * 32n + BigInt(CROCKFORD.indexOf(ch));
  return n.toString(16).padStart(32, "0");
}

const isWrapper = (w: string): w is (typeof ACCOUNT_WRAPPERS)[number] =>
  (ACCOUNT_WRAPPERS as readonly string[]).includes(w);

export const addBrokerageAccount = defineCommand({
  id: "investments.addBrokerageAccount",
  input: z.object({
    name: z.string(),
    broker: z.string(),
    wrapper: z.string().default("regular"),
    currency: z.string().default("PLN"),
  }),
  /**
   * Python `add_account`: name required, a known broker, a known wrapper, a 3-letter currency, and no
   * account of the same broker with the same name (casefold). The core account gets a random
   * `brokerage:<hex>` key (a name key: ULID gid, never identity, gid.md 4.3).
   */
  run(ctx, input) {
    const name = pyStrip(input.name);
    if (!name) return refuse("name_required");
    if (!brokerIds().includes(input.broker)) return refuse("unknown_broker");
    if (!isWrapper(input.wrapper)) return refuse("unknown_wrapper");
    const currency = pyUpper(pyStrip(input.currency));
    if (!/^[A-Z]{3}$/.test(currency)) return refuse("invalid_currency");
    const folded = pyCasefold(name);
    for (const existing of brokerageAccounts(ctx.read)) {
      if (existing.bank === input.broker && pyCasefold(pyStrip(existing.name)) === folded) {
        return refuse("account_exists");
      }
    }
    const account = ensureAccount(ctx, {
      bank: input.broker,
      name,
      externalId: `brokerage:${ulidHex(ctx.newGid())}`,
      type: BROKERAGE,
      currency,
    });
    ctx.emit("invAccount.settingsSet", ctx.det("inv_account_settings", [account.gid]), {
      account: account.gid,
      wrapper: input.wrapper,
    });
    return ok({ account: account.gid });
  },
});

type SettingsPatch = {
  wrapper?: (typeof ACCOUNT_WRAPPERS)[number];
  importer?: string | null;
  mappingYaml?: string | null;
};

/**
 * Emit the fields of `patch` that differ from the stored settings (`invAccount.settingsSet`, one
 * event); nothing when none differs. Returns whether it emitted.
 */
function patchSettings(ctx: CommandContext, account: string, patch: SettingsPatch): boolean {
  const current = accountSettings(ctx.read, account);
  const data: Record<string, unknown> = {};
  if (patch.wrapper !== undefined && patch.wrapper !== current.wrapper)
    data.wrapper = patch.wrapper;
  if (patch.importer !== undefined && patch.importer !== current.importer) {
    data.importer = patch.importer;
  }
  if (patch.mappingYaml !== undefined && patch.mappingYaml !== current.mappingYaml) {
    data.mappingYaml = patch.mappingYaml;
  }
  if (Object.keys(data).length === 0) return false;
  ctx.emit("invAccount.settingsSet", ctx.det("inv_account_settings", [account]), {
    account,
    ...data,
  });
  return true;
}

/**
 * Python import commit step 6: remember the importer of a file with transactions for the account,
 * and the mapping when the importer is the generic CSV one or a mapping was given (else the stored
 * mapping stays). Touches the settings only when the importer or the mapping changed (an unchanged
 * re-import writes nothing). A building block for the import commit's batch; `account` is the view's
 * brokerage account gid. Returns whether it emitted.
 */
export function rememberImporter(
  ctx: CommandContext,
  account: string,
  importer: string,
  mappingYaml: string | undefined,
): boolean {
  const current = accountSettings(ctx.read, account);
  const mapping =
    importer === GENERIC_CSV_BROKER_ID || mappingYaml
      ? mappingYaml || current.mappingYaml
      : current.mappingYaml;
  return patchSettings(ctx, account, { importer, mappingYaml: mapping });
}
