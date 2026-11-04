import { describe, expect, it } from "vitest";
import { createResponseIntake, parseNotificationResponse } from "./responses.js";

const pair = {
  version: 1,
  requestId: "12345678-1234-4234-8234-123456789abc",
  intentToken: "b".repeat(64),
};

describe("notification response intake", () => {
  it("validates only the opaque pair", () => {
    expect(parseNotificationResponse(pair)).toEqual({
      requestId: pair.requestId,
      intentToken: pair.intentToken,
    });
    expect(parseNotificationResponse({ ...pair, vaultId: "secret" })).toBeNull();
    expect(parseNotificationResponse({ ...pair, version: 2 })).toBeNull();
    expect(parseNotificationResponse({ ...pair, intentToken: "x" })).toBeNull();
  });

  it("accepts a previously parsed pair and refuses non-objects or missing fields", () => {
    const { requestId, intentToken } = pair;
    expect(parseNotificationResponse({ requestId, intentToken })).toEqual({
      requestId,
      intentToken,
    });
    expect(parseNotificationResponse({ ...pair, version: undefined })).toBeNull();
    expect(parseNotificationResponse({ version: 1, requestId })).toBeNull();
    expect(parseNotificationResponse([requestId, intentToken])).toBeNull();
    expect(parseNotificationResponse(null)).toBeNull();
    expect(parseNotificationResponse("pair")).toBeNull();
  });

  it("buffers early callbacks and deduplicates launchInfo replay", () => {
    const intake = createResponseIntake();
    const received: unknown[] = [];
    intake.push(pair);
    intake.push(pair);
    intake.bind((value) => received.push(value));
    intake.push(pair);
    expect(received).toEqual([{ requestId: pair.requestId, intentToken: pair.intentToken }]);
    intake.dispose();
    intake.push({ ...pair, requestId: "12345678-1234-4234-8234-123456789abd" });
    expect(received).toHaveLength(1);
  });

  it("retains sixteen early candidates and drains chronologically", () => {
    const intake = createResponseIntake();
    for (let i = 0; i < 20; i++) {
      intake.push({
        ...pair,
        requestId: `12345678-1234-4234-8234-${i.toString(16).padStart(12, "0")}`,
      });
    }
    const received: string[] = [];
    intake.bind((value) => received.push(value.requestId));
    expect(received).toHaveLength(16);
    expect(received[0]).toBe("12345678-1234-4234-8234-000000000004");
    expect(received.at(-1)).toBe("12345678-1234-4234-8234-000000000013");
  });

  it("keeps an older candidate when the newest may fail host validation", () => {
    const intake = createResponseIntake();
    const older = { ...pair, requestId: "12345678-1234-4234-8234-000000000001" };
    const newer = { ...pair, requestId: "12345678-1234-4234-8234-000000000002" };
    intake.push(older);
    intake.push(newer);
    const resolverQueue: string[] = [];
    intake.bind((value) => resolverQueue.unshift(value.requestId));
    expect(resolverQueue).toEqual([newer.requestId, older.requestId]);
    const validAtHost = (id: string) => id === older.requestId;
    expect(resolverQueue.find(validAtHost)).toBe(older.requestId);
  });
});
