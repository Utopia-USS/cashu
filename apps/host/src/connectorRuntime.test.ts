import { expect, it } from "vitest";
import {
  connectorDecision,
  connectorFetchFinish,
  RATE_LIMIT_BACKOFF_MS,
} from "./connectorRuntime.js";
import { documentRecords } from "./connectors/document.js";

it("keeps the first empty fetch inert and records later empty fetches without daily proposals", () => {
  expect(connectorDecision(false, false, false)).toBe("nothing");
  expect(connectorDecision(false, false, true)).toBe("nothing");
  expect(connectorDecision(false, true, false)).toBe("commit");
  expect(connectorDecision(false, true, true)).toBe("commit");
  expect(connectorDecision(true, false, true)).toBe("proposal");
  expect(connectorDecision(true, true, false)).toBe("proposal");
  expect(connectorDecision(true, true, true)).toBe("commit");
});

it("moves a binding's fetch state like Python: status always, last ok on a commit, 48 h backoff on rate limit", () => {
  const at = "2026-11-04T12:00:00.000Z";
  const now = Date.parse(at) + 1000;
  expect(connectorFetchFinish("ok", null, true, at, now)).toEqual({
    lastStatus: "ok",
    lastOkAt: at,
  });
  expect(connectorFetchFinish("ok", null, false, at, now)).toEqual({ lastStatus: "ok" });
  expect(connectorFetchFinish("failed", "rate_limited", false, at, now)).toEqual({
    lastStatus: "failed",
    backoffUntil: new Date(now + RATE_LIMIT_BACKOFF_MS).toISOString(),
  });
  expect(RATE_LIMIT_BACKOFF_MS).toBe(48 * 3_600_000);
});

it("counts a document's records like Python document_records", () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  expect(documentRecords("budget", bytes({ transactions: [{}, {}], records: [{}] }))).toBe(2);
  expect(documentRecords("investments", bytes({ records: [{}, {}, {}] }))).toBe(3);
  expect(documentRecords("investments", bytes({ records: {} }))).toBe(0);
  expect(documentRecords("budget", bytes([1, 2]))).toBe(0);
  expect(documentRecords("budget", new TextEncoder().encode("{"))).toBe(0);
});
