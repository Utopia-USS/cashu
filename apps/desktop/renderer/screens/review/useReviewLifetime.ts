import { useLayoutEffect, useRef } from "react";
/** Every invocation pins a generation; a later effect mount can never revive its continuation. */
export function useReviewLifetime(vault: string | null, privacy: boolean) {
  const active = useRef(true),
    generation = useRef<object>({});
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current = {};
    };
  }, [vault, privacy]);
  return () => {
    const pinned = generation.current;
    return () => active.current && generation.current === pinned;
  };
}
