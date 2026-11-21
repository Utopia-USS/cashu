// Starts vault queries before the screen reads them. Every `useQuery` suspends until its first value, so a
// hook that reads N queries one after another waits for them one after another (each first read starts only
// after the previous one resolved). `client.entry` opens a query's live read at once and keeps it while a
// reader subscribes (or for the cache's idle time), so warming every query a render will read first lets
// their first values arrive together: the screen's one Suspense boundary reveals once.
import type { Query, QueryArgs } from "@cashu/store/query";
import { useProfile, useStoreClient } from "@cashu/store-react";

export function useWarmQueries(): <A extends QueryArgs, R>(query: Query<A, R>, args: A) => void {
  const client = useStoreClient();
  const vault = useProfile();
  return (query, args) => {
    client.entry({ kind: "vault", vault }, query, args);
  };
}
