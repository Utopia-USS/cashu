// The app root supplies device-local display settings. Nested privacy providers inherit locale and the
// banana scale unless explicitly overridden; components read the resolved environment rather than the store.
import type { BananaScale } from "@cashu/domain/core";
import { intlLocale } from "@cashu/i18n";
import { createContext, type ReactNode, use } from "react";

export interface UiEnv {
  /** Privacy mode: amounts are hidden everywhere (money, money axes); shares stay. */
  readonly privacy: boolean;
  /** Defaults to the app's current UI locale. */
  readonly locale?: string;
  /** In privacy mode, money with a currency shows on this scale (`@cashu/domain` core/bananas.ts)
   * instead of dots. Null or absent: masked. */
  readonly bananas?: BananaScale | null;
}

const UiEnvContext = createContext<UiEnv>({ privacy: false });

/** Provides locale and privacy mode to every packages/ui component below it. */
export function UiEnvProvider({
  privacy,
  locale,
  bananas,
  children,
}: UiEnv & { children: ReactNode }) {
  const parent = use(UiEnvContext);
  return (
    <UiEnvContext
      value={{
        privacy,
        locale: locale ?? parent.locale ?? intlLocale(),
        bananas: bananas === undefined ? (parent.bananas ?? null) : bananas,
      }}
    >
      {children}
    </UiEnvContext>
  );
}

/** The current environment, with locale resolved even outside a provider. */
export function useUiEnv(): UiEnv & { readonly locale: string } {
  const env = use(UiEnvContext);
  return { ...env, locale: env.locale ?? intlLocale() };
}
