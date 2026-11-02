import { describe, expect, it } from "vitest";
import { memoryDriver } from "../../testing/store.js";
import { NotificationQueue, notificationDisposition } from "./notificationQueue.js";
import { LocalRunStatus } from "./runStatus.js";

describe("local daily state", () => {
  it("dedupes by vault/episode/queued severity and claims before send without automatic retry", () => {
    const driver = memoryDriver();
    const queue = new NotificationQueue(driver);
    expect(queue.enqueue("a", "signal", "info", "2026-10-31 12:00:00.000000")).toBe(true);
    expect(queue.enqueue("a", "signal", "info", "2026-10-31T12:00:01Z")).toBe(false);
    expect(queue.enqueue("b", "signal", "info", "2026-10-31T12:00:01Z")).toBe(true);
    const id = queue.pending("a")[0]?.id;
    if (id === undefined) throw new Error("missing synthetic queue row");
    expect(queue.claim("b", id, "2026-10-31T12:01:00Z", "test")).toBe(false);
    expect(queue.claim("a", id, "2026-10-31T12:01:00Z", "test")).toBe(true);
    expect(queue.claim("a", id, "2026-10-31T12:02:00Z", "other")).toBe(false);
    expect(new NotificationQueue(driver).pending("a")).toHaveLength(0);
    expect(queue.release("a", id, "2026-10-31T12:02:00Z")).toBe(false);
    expect(queue.release("a", id, "2026-10-31T12:01:00Z")).toBe(true);
    expect(queue.dropUnsent("a", "signal")).toBe(1);
    expect(queue.enqueue("a", "signal", "info", "2026-10-31T13:00:00Z")).toBe(true);
    driver.close();
  });
  it("uses queued severity and defers snoozed acknowledged entries before deciding", () => {
    const row = {
      id: 1,
      vault: "a",
      signal: "signal",
      severity: "info",
      createdAt: "2026-10-31T12:00:00Z",
    };
    const state = {
      status: "active",
      severity: "action",
      decided: false,
      hidden: false,
      snoozedUntil: null,
    };
    const now = "2026-10-31T12:00:00Z";
    const policy = new Set(["info"]);
    expect(notificationDisposition(row, state, now, policy)).toBe("send");
    expect(
      notificationDisposition(
        row,
        { ...state, status: "acknowledged", snoozedUntil: "2026-10-31 13:00:00.000000" },
        now,
        policy,
      ),
    ).toBe("wait");
    expect(notificationDisposition(row, { ...state, status: "acknowledged" }, now, policy)).toBe(
      "discard",
    );
    expect(
      notificationDisposition(
        row,
        { ...state, hidden: true, snoozedUntil: "2026-10-31 13:00:00" },
        now,
        policy,
      ),
    ).toBe("discard");
  });
  it("tracks newest local add/update with the Python thirty minute boundary", () => {
    const driver = memoryDriver();
    const status = new LocalRunStatus(driver);
    status.started("a", "2026-10-31 12:00:00.000000");
    expect(status.get("b", "2026-10-31T12:01:00Z").running).toBe(false);
    expect(status.get("a", "2026-10-31T12:29:59.999Z").running).toBe(true);
    expect(status.get("a", "2026-10-31T12:30:00Z").running).toBe(false);
    status.started("a", "2026-10-31T13:00:00Z");
    status.finished("a", "2026-10-31 12:00:00.000000");
    expect(status.get("a", "2026-10-31T13:01:00Z").running).toBe(true);
    status.finished("a", "2026-10-31T13:00:00Z");
    expect(status.get("a", "2026-10-31T13:01:00Z").running).toBe(false);
    driver.close();
  });
});
