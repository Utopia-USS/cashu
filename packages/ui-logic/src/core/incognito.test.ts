import { describe, expect, it } from "vitest";
import {
  hideAmount,
  installIncognitoStore,
  isIncognito,
  onIncognitoChange,
  setIncognito,
} from "./incognito.js";

describe("incognito flag", () => {
  it("reads the installed store once, writes every change and tells subscribers", () => {
    const saved: boolean[] = [];
    let loads = 0;
    installIncognitoStore({
      load: () => {
        loads++;
        return true;
      },
      save: (on) => saved.push(on),
    });
    expect(isIncognito()).toBe(true);
    expect(isIncognito()).toBe(true);
    expect(loads).toBe(1);
    expect(hideAmount("-11 600,00 zł")).toBe("-••• zł");
    let calls = 0;
    const off = onIncognitoChange(() => calls++);
    setIncognito(false);
    off();
    setIncognito(true);
    expect(saved).toEqual([false, true]);
    expect(calls).toBe(1);
  });

  it("holds the flag in memory when the store fails", () => {
    installIncognitoStore({
      load: () => {
        throw new Error("storage blocked");
      },
      save: () => {
        throw new Error("storage blocked");
      },
    });
    expect(isIncognito()).toBe(false);
    setIncognito(true);
    expect(isIncognito()).toBe(true);
    expect(hideAmount("12 zł")).toBe("••• zł");
  });
});
