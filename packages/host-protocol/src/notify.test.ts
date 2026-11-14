import { describe, expect, it } from "vitest";
import {
  parseNotifyAck,
  parseNotifyFrame,
  serializeNotifyAck,
  serializeNotifyFrame,
} from "./notify.js";

const requestId = "12345678-1234-4234-8234-123456789abc";
const intentToken = "a".repeat(64);
const encoder = new TextEncoder();
const frame = { version: 1, requestId, locale: "pl", kind: "signal", intentToken } as const;

describe("notify-v1 canonical helper bytes", () => {
  it("round trips the fixed request and ACK order", () => {
    const request = serializeNotifyFrame(frame);
    expect(new TextDecoder().decode(request)).toBe(
      `{"version":1,"requestId":"${requestId}","locale":"pl","kind":"signal","intentToken":"${intentToken}"}\n`,
    );
    expect(parseNotifyFrame(request)).toEqual(frame);
    const ack = { version: 1, requestId, status: "accepted" } as const;
    expect(parseNotifyAck(serializeNotifyAck(ack))).toEqual(ack);
  });

  it.each([
    `{"version":1,"requestId":"${requestId}","requestId":"${requestId}","locale":"pl","kind":"signal","intentToken":"${intentToken}"}\n`,
    `{"requestId":"${requestId}","version":1,"locale":"pl","kind":"signal","intentToken":"${intentToken}"}\n`,
    `{"version":1, "requestId":"${requestId}","locale":"pl","kind":"signal","intentToken":"${intentToken}"}\n`,
    `{"version":1,"requestId":"${requestId}","locale":"pl","kind":"signal","intentToken":"${intentToken}","vault":"x"}\n`,
    `{"version":2,"requestId":"${requestId}","locale":"pl","kind":"signal","intentToken":"${intentToken}"}\n`,
    `{"version":1,"requestId":"${requestId}","locale":"pl","kind":"signal","intentToken":"${intentToken}"}\nX`,
  ])("refuses noncanonical request bytes", (raw) => {
    expect(() => parseNotifyFrame(encoder.encode(raw))).toThrow("invalid_notify_frame");
  });

  it("refuses invalid UTF-8 and an oversized frame", () => {
    expect(() => parseNotifyFrame(Uint8Array.from([0xff, 10]))).toThrow();
    expect(() => parseNotifyFrame(encoder.encode("x".repeat(4096) + "\n"))).toThrow();
  });

  it.each([`["${intentToken}"]`, "123", "{}", "null"])(
    "refuses non-string token %s",
    (tokenJson) => {
      expect(() =>
        parseNotifyFrame(
          encoder.encode(
            `{"version":1,"requestId":"${requestId}","locale":"pl","kind":"signal","intentToken":${tokenJson}}\n`,
          ),
        ),
      ).toThrow("invalid_notify_frame");
    },
  );

  it("refuses mismatched ACK form and does not encode unknown", () => {
    expect(() =>
      parseNotifyAck(
        encoder.encode(`{"version":1,"requestId":"${requestId}","status":"unknown"}\n`),
      ),
    ).toThrow();
    expect(() =>
      parseNotifyAck(
        encoder.encode(`{"version":1,"status":"accepted","requestId":"${requestId}"}\n`),
      ),
    ).toThrow();
  });
});
