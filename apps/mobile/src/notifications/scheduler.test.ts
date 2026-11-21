// Removing this phone forgets its notifications: every pending one of ours (the planner's and the dev
// previews) is cancelled, another app's is left alone, and the delivered ones are dismissed. Synthetic.
import { forgetNotifications, isOurs } from "./scheduler";
import { memoryScheduler } from "./testing/memoryScheduler";

const note = (id: string, fireAt: string | null) => ({
  id,
  title: "cashU",
  body: "Your week is ready.",
  thread: "weekly" as const,
  data: { vault: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaa261", kind: "weekly" },
  fireAt,
});

it("tells our identifiers from anyone else's", () => {
  expect(isOurs("cashu.v.weekly.2026-11-15")).toBe(true);
  expect(isOurs("cashu-preview.v.weekly")).toBe(true);
  expect(isOurs("other.weekly")).toBe(false);
});

it("cancels the pending ones, previews included, and dismisses the delivered ones", async () => {
  const scheduler = memoryScheduler("granted");
  await scheduler.schedule(note("cashu.v.weekly.2026-11-15", "2026-11-15T17:00:00.000Z"));
  await scheduler.schedule(note("cashu-preview.v.weekly", "2026-11-12T08:00:05.000Z"));
  await scheduler.schedule(note("other.weekly", "2026-11-15T17:00:00.000Z"));
  await scheduler.schedule(note("cashu.v.alerts_fired.now", null));
  await forgetNotifications(scheduler);
  expect([...scheduler.pending.keys()]).toEqual(["other.weekly"]);
  expect(scheduler.cancelled.sort()).toEqual([
    "cashu-preview.v.weekly",
    "cashu.v.weekly.2026-11-15",
  ]);
  expect(scheduler.delivered).toEqual([]);
  expect(scheduler.dismissals()).toBe(1);
});
