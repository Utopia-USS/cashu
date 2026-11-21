// useQuery(query, args): the rows of a store query, live. Built on useSyncExternalStore over the
// client's snapshot cache (one entry per target + query key, ref-counted, structurally shared). On the
// desktop the first read of a key waits for the store process, so it suspends to the route's
// <Suspense> once; later changes are pushed. On the phone (sync driver) it never suspends. A failed
// query throws to the nearest error boundary. A vault query reads the current profile's store.
import type { Query, QueryArgs } from "@cashu/store/query";
import { use, useSyncExternalStore } from "react";
import { DEVICE_TARGET, type Target } from "../client/types.js";
import { ProfileContext, StoreBindingError, useStoreClient } from "./context.js";

/** The store a query of `scope` reads under the current profile. */
export function useTarget(scope: "vault" | "device"): Target {
  const vault = use(ProfileContext);
  if (scope === "device") return DEVICE_TARGET;
  if (vault === null) {
    throw new StoreBindingError(
      "a vault query or command needs a current profile (ProfileProvider)",
    );
  }
  return { kind: "vault", vault };
}

type ArgsParam<A> = undefined extends A ? [args?: A] : [args: A];

export function useQuery<A extends QueryArgs, R>(query: Query<A, R>, ...rest: ArgsParam<A>): R {
  const client = useStoreClient();
  const target = useTarget(query.scope);
  const entry = client.entry(target, query, rest[0] as A);
  const state = useSyncExternalStore(entry.subscribe, entry.getSnapshot, entry.getSnapshot);
  // Always called (React tracks use() by position): suspends only while the first read is in flight.
  use(entry.ready);
  if (state.status === "error") throw state.error;
  if (state.status === "pending") throw new StoreBindingError("a settled query has no snapshot");
  return state.value;
}
