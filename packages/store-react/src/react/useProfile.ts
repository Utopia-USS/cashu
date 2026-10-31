import { use } from "react";
import { ProfileContext, StoreBindingError } from "./context.js";

/** The vault id of the current profile; throws outside a ProfileProvider with a profile. */
export function useProfile(): string {
  const vault = use(ProfileContext);
  if (vault === null) throw new StoreBindingError("useProfile needs a ProfileProvider above it");
  return vault;
}
