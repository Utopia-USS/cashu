// Rows keyed by one account (loans, depreciations, asset details: events.md 6.4 row key
// `resolve(account)`, gid.md 4.5 DET[@account]): the partition is the resolved account, its members
// are the DET gids of every account in the component, so a re-fold finds every event of the row and
// two merged accounts' rows collapse with LWW over the merged stream (R-2).
import type { FoldContext, FoldEvent, Materializer } from "../engine/types.js";
import type { GidTable } from "../gid.js";
import { ACCOUNTS } from "./accounts.js";

type Keying = Pick<Materializer, "identity" | "partitions" | "subjects">;

export function accountKeyed(domain: GidTable): Keying {
  return {
    identity: [ACCOUNTS],
    partitions: (e: FoldEvent, ctx: FoldContext) => [ctx.resolve(ACCOUNTS, String(e.data.account))],
    subjects: (root: string, ctx: FoldContext) =>
      ctx.identityMembers(ACCOUNTS, root).map((account) => ctx.det(domain, [account])),
  };
}
