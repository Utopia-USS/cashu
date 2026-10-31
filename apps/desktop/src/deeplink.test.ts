import { describe, expect, it } from "vitest";
import { shouldRegisterProtocol } from "./deeplink.js";
import { trayItems } from "./tray.js";

describe("URL scheme registration is dev-safe", () => {
  it("never registers in a development run, even when asked", () => {
    expect(shouldRegisterProtocol({ isPackaged: false, env: {} })).toBe(false);
    expect(
      shouldRegisterProtocol({ isPackaged: false, env: { CASHU_DESKTOP_REGISTER_PROTOCOL: "1" } }),
    ).toBe(false);
  });

  it("registers only for a packaged app that was asked to", () => {
    expect(shouldRegisterProtocol({ isPackaged: true, env: {} })).toBe(false);
    expect(
      shouldRegisterProtocol({ isPackaged: true, env: { CASHU_DESKTOP_REGISTER_PROTOCOL: "1" } }),
    ).toBe(true);
  });
});

describe("tray menu", () => {
  it("offers open and quit in both languages", () => {
    const labels = (lang: "pl" | "en") =>
      trayItems(lang).flatMap((item) => ("label" in item ? [item.label] : []));
    expect(labels("pl")).toEqual(["Otwórz cashU", "Zakończ cashU"]);
    expect(labels("en")).toEqual(["Open cashU", "Quit cashU"]);
    expect(trayItems("en").map((i) => ("action" in i ? i.action : "-"))).toEqual([
      "open",
      "-",
      "quit",
    ]);
  });
});
