// The UI environment the app root provides to packages/ui (cashu-ui skill, components.md "Value
// components"): privacy mode for now, fed by the app from the store's device-local settings. Components
// read it here and never check privacy mode on their own.
import { createContext, type ReactNode, use } from "react";

export interface UiEnv {
  /** Privacy mode: amounts are hidden everywhere (money, money axes); shares stay. */
  privacy: boolean;
}

const UiEnvContext = createContext<UiEnv>({ privacy: false });

/** Provides the UI environment (privacy mode) to every packages/ui component below it. */
export function UiEnvProvider({ privacy, children }: UiEnv & { children: ReactNode }) {
  return <UiEnvContext value={{ privacy }}>{children}</UiEnvContext>;
}

/** The current UI environment (privacy mode off outside a provider). */
export function useUiEnv(): UiEnv {
  return use(UiEnvContext);
}
