/**
 * Generated account labels for MCP: `"<institution> <type> <n>"` (e.g. `"mBank checking 1"`), port of
 * `core/mcp/accounts.py`.
 *
 * Stored account names are never sent (they are free text and often carry a person's name); the
 * number counts the profile's accounts of the same institution and type in creation order, so a label
 * is stable while accounts are only added.
 */

import { pyStrip } from "@cashu/domain";
import { pyRe, W } from "./pyRegex.js";

const UNSAFE = pyRe(`[^${W} .&+\\-]`, "g");

export interface LabelledAccount<Id> {
  readonly id: Id;
  readonly bank: string | null;
  readonly type: string | null;
}

/**
 * Labels of a profile's accounts. `accounts` must be every account of the profile in id order
 * (creation order); `displayName` is the institution registry's display name in the current language.
 */
export function accountLabels<Id>(
  accounts: readonly LabelledAccount<Id>[],
  displayName: (institutionId: string) => string,
): Map<Id, string> {
  const seen = new Map<string, number>();
  const out = new Map<Id, string>();
  for (const acc of accounts) {
    const inst = pyStrip(displayName(acc.bank || "manual").replace(UNSAFE, "")) || "account";
    const kind = acc.type || "other";
    const key = `${inst}\u0000${kind}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    out.set(acc.id, `${inst} ${kind} ${n}`);
  }
  return out;
}
