// The investments kit builds its vault once per file and hands every kit its own copy (S23): a write in
// one kit never shows in another, and a copy writes exactly as a fresh build would (same clock, HLC and
// id seed). Synthetic data only.
import { renameProfile } from "@cashu/store";
import { investmentsStore } from "./investmentsStore";

const events = (kit: ReturnType<typeof investmentsStore>) =>
  kit.store.read<{ n: number }>("SELECT count(*) AS n FROM event_log")[0]?.n ?? 0;
const lastEvent = (kit: ReturnType<typeof investmentsStore>) =>
  kit.store.read<{ hlc: string }>("SELECT hlc FROM event_log ORDER BY rowid DESC LIMIT 1")[0]?.hlc;

it("gives every kit its own copy of the built vault", () => {
  const first = investmentsStore();
  const second = investmentsStore();
  const before = events(second);
  expect(before).toBeGreaterThan(0);
  expect(events(first)).toBe(before);
  first.apply(renameProfile, { name: "Only in the first copy" });
  expect(events(first)).toBe(before + 1);
  expect(events(second)).toBe(before);
  first.close();
  // The second copy outlives the first one's close.
  expect(events(second)).toBe(before);
  second.apply(renameProfile, { name: "Only in the second copy" });
  // Both copies continue from the build's clock: the same command stamps the same HLC.
  const third = investmentsStore();
  third.apply(renameProfile, { name: "Only in the third copy" });
  expect(lastEvent(third)).toBe(lastEvent(second));
  second.close();
  third.close();
});
