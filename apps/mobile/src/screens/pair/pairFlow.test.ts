// Removing this phone resets the pairing flow kept outside React: no role or first-sync step reopens
// the pair modal for a vault the wipe removed. Synthetic vault id only.
import { beforeWipeTasks } from "../../services/wipe";
import { pairFlow, pairingContinues } from "./pairFlow";

const VAULT = "4a2b3c4d5e6f708192a3b4c5d6e7f804";

it("a wipe resets the pairing flow", async () => {
  pairFlow.get("iPhone 16 Pro");
  for (const event of [
    { type: "connecting" },
    { type: "sas", sas: "418207", expiresAt: Date.now() + 60_000 },
    { type: "storing" },
    { type: "stored", vault: VAULT },
  ] as const) {
    pairFlow.dispatch(event);
  }
  expect(pairFlow.peek()?.kind).toBe("role");
  expect(pairingContinues()).toBe(true);
  let emitted = 0;
  const stop = pairFlow.subscribe(() => emitted++);
  await Promise.all(beforeWipeTasks().map((task) => task()));
  stop();
  expect(pairFlow.peek()).toBeUndefined();
  expect(pairingContinues()).toBe(false);
  expect(emitted).toBe(1);
});
