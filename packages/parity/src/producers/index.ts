/**
 * The TS parity producers: one function per golden check, each reading the dataset through the
 * read-only source (`../sources`) and returning the check's JSON tree. `cli.ts` runs them and writes
 * `<lab>/parity/ts-out/<dataset>/<check>.json`, the comparer's default actual dir.
 */

import type { Dataset, PythonDb } from "../sources/index.ts";
import { readBridge } from "./core/bridge.ts";
import { produceNetworth } from "./core/networth.ts";
import type { OutValue } from "./output.ts";

export interface Producer {
  /** The golden check this producer writes. */
  readonly check: string;
  /** Datasets it is enabled for (a lab check may wait for a later port). */
  readonly datasets: readonly Dataset[];
  readonly produce: (db: PythonDb) => OutValue;
}

export const PRODUCERS: readonly Producer[] = [
  {
    check: "core.networth",
    // Lab waits for the brokerage contributor (S13): see packages/parity/README.md.
    datasets: ["demo"],
    produce: (db) => produceNetworth(db, readBridge(db.dataset)),
  },
];
