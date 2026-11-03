import { D, parseDateTime } from "@cashu/domain";
import { investmentsCommands } from "@cashu/store";
import { openSignals, strategyVersions } from "@cashu/store/investments/queries";
import { afterEach, expect, it } from "vitest";
import { cleanup } from "../testing/harness.js";
import { command, seedWorkerHolding, workerFixture } from "../testing/worker.js";
import type { WorkerBindings, WorkerNotification, WorkerNotifier } from "./contracts.js";
import { deliverWorkerNotifications } from "./notifications.js";
import { localDay } from "./schedule.js";
import { HostWorker } from "./service.js";

afterEach(cleanup);
const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
function strategy(digest: string, count = 5): string {
  return `version: 1\nbase_currency: PLN\ndata: {max_stale_weight: 1}\nnotifications: {digest_weekday: ${digest}}\nrules:\n${Array.from({ length: count }, (_, i) => `  - {id: concentration${i}, kind: position_concentration, severity: action, params: {max_weight: 0.3}}`).join("\n")}\n`;
}
class Notifier implements WorkerNotifier {
  readonly name = "synthetic";
  readonly messages: WorkerNotification[] = [];
  fail = false;
  async send(message: WorkerNotification) {
    this.messages.push(message);
    return { ok: !this.fail };
  }
}
async function holding(f: Awaited<ReturnType<typeof workerFixture>>) {
  const vault = f.vaults[0];
  if (vault === undefined) throw new Error("synthetic vault absent");
  await seedWorkerHolding(vault, f.time());
  f.prices.upsertBars(
    { provider: "yahoo", symbol: "SYN.WA" },
    [
      {
        date: localDay(f.time()),
        close: D("12"),
        open: null,
        high: null,
        low: null,
        volume: null,
        currency: null,
        fetchedAt: null,
      },
    ],
    parseDateTime(new Date(f.time()).toISOString()),
  );
}
it.each(["pl", "en"] as const)(
  "delivers actual queued rules with max-three overflow, exact %s copy and no duplicate delivery",
  async (language) => {
    const tomorrow = weekdays[(new Date().getDay() + 1) % 7] ?? "sunday";
    const f = await workerFixture({ yaml: strategy(tomorrow) });
    const vault = f.vaults[0];
    if (vault === undefined) throw new Error("synthetic vault absent");
    await holding(f);
    const notifier = new Notifier(),
      bindings: WorkerBindings = { ...f.bindings, language: () => language, notifier };
    const worker = new HostWorker(f.context, bindings);
    try {
      await worker.tick();
      expect(openSignals(vault.store.read.bind(vault.store))).toHaveLength(5);
      expect(notifier.messages).toHaveLength(4);
      expect(notifier.messages[3]?.message).toBe(
        language === "pl" ? "Jeszcze 2 sygnały" : "2 signals more",
      );
      expect(notifier.messages[0]?.subtitle).toBe(
        language === "pl" ? "Sygnał do działania" : "Action signal",
      );
      expect(f.notifications.pending(vault.id)).toEqual([]);
      await worker.tick(true);
      expect(notifier.messages).toHaveLength(4);
    } finally {
      await worker.stop();
      await f.close();
    }
  },
);
it("releases observed failed claims, rolls back failed digest markers and sends successful weekly digest once", async () => {
  const today = weekdays[new Date().getDay()] ?? "sunday";
  const f = await workerFixture({ yaml: strategy(today, 1) });
  const vault = f.vaults[0];
  if (vault === undefined) throw new Error("synthetic vault absent");
  await holding(f);
  const notifier = new Notifier();
  notifier.fail = true;
  const bindings: WorkerBindings = { ...f.bindings, notifier },
    worker = new HostWorker(f.context, bindings);
  try {
    await worker.tick();
    expect(f.notifications.pending(vault.id)).toHaveLength(1);
    expect((await bindings.state.load()).digests[vault.id]).toBeUndefined();
    notifier.fail = false;
    await worker.tick(true);
    expect(f.notifications.pending(vault.id)).toEqual([]);
    expect((await bindings.state.load()).digests[vault.id]).toBe(localDay(f.time()));
    expect(notifier.messages.at(-1)?.message).toBe("1 signal to review");
    const count = notifier.messages.length;
    await worker.tick(true);
    expect(notifier.messages).toHaveLength(count);
  } finally {
    await worker.stop();
    await f.close();
  }
});
it("rechecks actual owner acknowledgement and snooze before queue delivery", async () => {
  const f = await workerFixture({ yaml: strategy("sunday", 2) });
  const vault = f.vaults[0];
  if (vault === undefined) throw new Error("synthetic vault absent");
  await holding(f);
  const worker = new HostWorker(f.context, f.bindings),
    notifier = new Notifier();
  try {
    await worker.tick();
    const signals = openSignals(vault.store.read.bind(vault.store));
    const first = signals[0],
      second = signals[1];
    if (first === undefined || second === undefined) throw new Error("synthetic signal absent");
    await command(vault, investmentsCommands.acknowledgeSignal, { signal: first.gid });
    await command(vault, investmentsCommands.snoozeSignalCommand, {
      signal: second.gid,
      until: new Date(f.time() + 86_400_000).toISOString(),
    });
    const result = await deliverWorkerNotifications({
      vault,
      bindings: f.bindings,
      notifier,
      queue: f.notifications,
      now: () => f.time(),
      guard: () => {
        if (!f.holders.has(vault.id)) throw new Error("synthetic authority lost");
      },
    });
    expect(result.stats).toMatchObject({ skipped: 1, delivered: 0 });
    expect(notifier.messages).toEqual([]);
    expect(f.notifications.pending(vault.id)).toHaveLength(1);
  } finally {
    await worker.stop();
    await f.close();
  }
});

it("reads current unrecorded file policy without recording a new strategy version", async () => {
  const options = { yaml: strategy("sunday", 1) },
    f = await workerFixture(options);
  const vault = f.vaults[0];
  if (vault === undefined) throw new Error("synthetic vault absent");
  await holding(f);
  const worker = new HostWorker(f.context, f.bindings),
    notifier = new Notifier();
  try {
    await worker.tick();
    expect(f.notifications.pending(vault.id)).toHaveLength(1);
    const before = strategyVersions(vault.store.read.bind(vault.store)).length;
    options.yaml = options.yaml.replace(
      "notifications: {digest_weekday: sunday}",
      "notifications: {immediate: [], digest_weekday: sunday}",
    );
    const result = await deliverWorkerNotifications({
      vault,
      bindings: f.bindings,
      notifier,
      queue: f.notifications,
      now: () => f.time(),
      guard: () => {
        if (!f.holders.has(vault.id)) throw new Error("synthetic authority lost");
      },
    });
    expect(result.stats).toMatchObject({ skipped: 1, delivered: 0 });
    expect(notifier.messages).toEqual([]);
    expect(f.notifications.pending(vault.id)).toEqual([]);
    expect(strategyVersions(vault.store.read.bind(vault.store))).toHaveLength(before);
  } finally {
    await worker.stop();
    await f.close();
  }
});
