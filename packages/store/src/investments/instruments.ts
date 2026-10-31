// Instrument identity (events.md 6.4): `instrument.aliasAdded` claims `namespace:value` for
// `data.instrument` (a collision folds the later claimer into the first holder), `instrument.merged`
// folds the source's root into the target's root. The `inv_instruments` / aliases tables are S25's.
import type { IdentityKind } from "../engine/types.js";

export const INSTRUMENTS = "instruments";

export const instrumentIdentity: IdentityKind = {
  id: INSTRUMENTS,
  version: 1,
  handles: ["instrument.aliasAdded", "instrument.merged"],
  claims(e) {
    if (e.type !== "instrument.aliasAdded") return [];
    return [
      {
        gid: String(e.data.instrument),
        key: `${String(e.data.namespace)}:${String(e.data.value)}`,
      },
    ];
  },
  merges(e) {
    if (e.type !== "instrument.merged") return [];
    return [{ source: String(e.data.source), target: String(e.data.target) }];
  },
};
