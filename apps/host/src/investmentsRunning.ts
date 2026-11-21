import {
  type InvestmentsRunning,
  investmentsRunning,
  NOTHING_RUNNING,
} from "@cashu/store/investments/screen";
import { type ChangeSource, defineQuery } from "@cashu/store/query";

/** The served `investmentsRunning`: the worker's in-flight quote refresh / daily rules check of the
 * current vault, re-run when one starts or ends (no renderer timer). */
export function investmentsRunningQuery(deps: {
  readonly changes: ChangeSource;
  running(vault: string): InvestmentsRunning;
}) {
  return defineQuery({
    id: investmentsRunning.id,
    changes: deps.changes,
    run(read, _args: undefined): InvestmentsRunning {
      const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
      return vault === undefined ? NOTHING_RUNNING : deps.running(vault);
    },
  });
}
