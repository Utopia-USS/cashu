// The app root supplies device-local display settings. Nested privacy providers inherit locale
// unless explicitly overridden; components read the resolved environment rather than the store.
import { intlLocale } from "@cashu/i18n";
import { createContext, type ReactNode, use } from "react";

export interface UiEnv {
  /** Privacy mode: amounts are hidden everywhere (money, money axes); shares stay. */
  readonly privacy: boolean;
  /** Defaults to the app's current UI locale. */
  readonly locale?: string;
}

const UiEnvContext = createContext<UiEnv>({ privacy: false });

/** Provides locale and privacy mode to every packages/ui component below it. */
export function UiEnvProvider({ privacy, locale, children }: UiEnv & { children: ReactNode }) {
  const parent = use(UiEnvContext);
  return (
    <UiEnvContext value={{ privacy, locale: locale ?? parent.locale ?? intlLocale() }}>
      {children}
    </UiEnvContext>
  );
}

/** The current environment, with locale resolved even outside a provider. */
export function useUiEnv(): UiEnv & { readonly locale: string } {
  const env = use(UiEnvContext);
  return { ...env, locale: env.locale ?? intlLocale() };
}
