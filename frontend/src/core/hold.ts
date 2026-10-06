// The shell's reload hold (FE-2): while a Start page's drawer is open, nothing may re-read the profile list and
// swap that page away under it (the setup poll and the window-focus reload share this one guard). A counter, so
// overlapping holders (two drawers, a remount) release independently. Pure; tested in tests/first-steps.test.mjs.

export interface ReloadHold {
  /** Take the hold; the returned function releases it (idempotent). */
  acquire(): () => void;
  /** Some holder is active: a profile reload must wait. */
  held(): boolean;
}

export function createReloadHold(): ReloadHold {
  let n = 0;
  return {
    acquire() {
      n += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        n -= 1;
      };
    },
    held: () => n > 0,
  };
}
