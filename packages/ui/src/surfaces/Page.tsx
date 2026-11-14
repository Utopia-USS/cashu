import type { ReactNode } from "react";

export interface PageProps {
  children: ReactNode;
  /** `wide` = old `.wrap.wide` (max 1440px, Przegląd and the investments workspace); `narrow` = `.wrap.narrow`
   * (1120px, the other pages and the minimal Przegląd). */
  width?: "wide" | "narrow";
  /** Accessible name of the page's `main` landmark. */
  label?: string;
  testID?: string;
}

/** The page box under the app bar (old `.wrap`): centred, 20px sides, 70px bottom (the shell above carries the
 * 24px top), with the old body type (15px / 1.5). */
export function Page({ children, width = "wide", label, testID }: PageProps) {
  return (
    <main
      aria-label={label}
      data-testid={testID}
      className={`mx-auto px-5 pb-17.5 text-base leading-normal text-fg ${width === "narrow" ? "max-w-280" : "max-w-360"}`}
    >
      {children}
    </main>
  );
}
