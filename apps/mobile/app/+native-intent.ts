// expo-router's system-link hook: every deep link (`cashu://...`) passes here before it navigates. While
// the app lock holds navigation a link opens nothing and is replayed after the unlock; a cold start's
// link opens the start and is replayed after the mount (src/shell/heldLinks.ts).
import { redirectSystemLink } from "../src/shell/heldLinks";

export function redirectSystemPath(event: { path: string; initial: boolean }): string | null {
  return redirectSystemLink(event);
}
