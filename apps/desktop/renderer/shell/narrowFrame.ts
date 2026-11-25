// The old shell's narrow frame (ab24ab6 core/Shell.tsx `narrow` + `setNarrow` in ShellContext): a page asks for the
// 1120px frame (the investments-only Przegląd, the light investments grid); the shell drops the request when the
// page goes. The asset page's own request comes from its route (routes.tsx).
import { createContext, use, useEffect } from "react";

interface NarrowFrame {
  /** A page asked for the narrow frame. */
  readonly narrow: boolean;
  request(narrow: boolean): void;
}

export const NarrowFrameContext = createContext<NarrowFrame>({
  narrow: false,
  request: () => {},
});

/** Ask for the narrow frame while `narrow` holds and this page is mounted (old `setNarrow` effect). */
export function useNarrowFrame(narrow: boolean): void {
  const { request } = use(NarrowFrameContext);
  useEffect(() => {
    request(narrow);
    return () => request(false);
  }, [narrow, request]);
}

/** The frame a page box should follow (old `.wrap.narrow` around the whole page). */
export const useFrameNarrow = (): boolean => use(NarrowFrameContext).narrow;
