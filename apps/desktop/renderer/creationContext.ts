import { createContext, use } from "react";

export const CreationContext = createContext<(() => void) | null>(null);

export function useOpenCreation(): () => void {
  return use(CreationContext) ?? (() => {});
}
