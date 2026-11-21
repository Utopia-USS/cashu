import { describe, expect, it } from "vitest";
import { CreationTransition } from "./creationTransition.js";

describe("Create profile switch lifetime", () => {
  it("accepts only its target while selection is in flight", async () => {
    const transition = new CreationTransition();
    const first = transition.begin();
    transition.expect("new-vault");
    let release!: () => void;
    const delayedSelection = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = delayedSelection.then(() => transition.active(first));
    expect(transition.vaultChanged("third-vault")).toBe(false);
    release();
    expect(await result).toBe(false);

    const second = transition.begin();
    transition.expect("new-vault");
    expect(transition.vaultChanged("new-vault")).toBe(true);
    expect(transition.active(second)).toBe(true);
    transition.end();
    expect(transition.active(second)).toBe(false);
  });
});
