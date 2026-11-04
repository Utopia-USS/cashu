import { expect, it } from "vitest";
import { connectorDecision } from "./connectorRuntime.js";

it("keeps the first empty fetch inert and records later empty fetches without daily proposals", () => {
  expect(connectorDecision(false, false, false)).toBe("nothing");
  expect(connectorDecision(false, false, true)).toBe("nothing");
  expect(connectorDecision(false, true, false)).toBe("commit");
  expect(connectorDecision(false, true, true)).toBe("commit");
  expect(connectorDecision(true, false, true)).toBe("proposal");
  expect(connectorDecision(true, true, false)).toBe("proposal");
  expect(connectorDecision(true, true, true)).toBe("commit");
});
