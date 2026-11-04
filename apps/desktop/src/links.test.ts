import { describe, expect, it } from "vitest";
import { LinkRouter, type LinkWindow, linkFromArgv, linkToHash } from "./links.js";

describe("cashu:// links (notify.link_to_hash)", () => {
  it("maps the known shapes to dashboard routes", () => {
    expect(linkToHash("cashu://open")).toBe("");
    expect(linkToHash("cashu://signal/demo-anna/42")).toBe(
      "#/demo-anna/investments.portfolio/?signal=42",
    );
    expect(linkToHash("cashu://signal/demo-anna/007")).toBe(
      "#/demo-anna/investments.portfolio/?signal=7",
    );
    expect(linkToHash("cashu://review/demo-anna")).toBe(
      "#/demo-anna/investments.portfolio/?review=1",
    );
    expect(linkToHash("cashu://investments/demo-piotr")).toBe("#/demo-piotr/investments.portfolio");
  });

  it("rejects everything else", () => {
    for (const bad of [
      "finanse://investments/demo-piotr",
      "cashu://signal/demo-anna/abc",
      "cashu://signal/Demo/1",
      "cashu://signal/../1",
      "cashu://signal/demo-anna/1/2",
      "cashu://review/demo-anna?x=1",
      "cashu://review/demo-anna#x",
      "cashu://unknown/demo-anna",
      "cashu://open/extra",
      "https://example.com/",
      "cashu://signal/demo/1234567890123",
      `cashu://open/${"a".repeat(600)}`,
      "",
      42,
      null,
    ]) {
      expect(linkToHash(bad)).toBeNull();
    }
  });

  it("finds a link in a command line", () => {
    expect(linkFromArgv(["electron", ".", "cashu://review/demo-anna"])).toBe(
      "cashu://review/demo-anna",
    );
    expect(linkFromArgv(["--open-link=cashu://open"])).toBe("cashu://open");
    expect(linkFromArgv(["electron", "--flag", "https://example.com"])).toBeNull();
  });
});

class FakeWindow implements LinkWindow {
  url = "";
  calls: string[] = [];
  currentUrl() {
    return this.url;
  }
  async loadUrl(url: string) {
    this.calls.push(`load ${url}`);
    this.url = url;
  }
  async setHash(hash: string) {
    this.calls.push(`hash ${hash}`);
  }
  show() {
    this.calls.push("show");
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("LinkRouter", () => {
  it("keeps a link until the window loads the dashboard and folds it into the first URL", () => {
    const router = new LinkRouter();
    expect(router.open("cashu://review/demo-anna")).toBe(true);
    expect(router.open("cashu://signal/demo-anna/3")).toBe(true); // the latest wins
    const first = router.ready(new FakeWindow(), "http://127.0.0.1:8500/");
    expect(first).toBe("http://127.0.0.1:8500/#/demo-anna/investments.portfolio/?signal=3");
    expect(router.ready(new FakeWindow(), "http://127.0.0.1:8500/")).toBe("http://127.0.0.1:8500/");
  });

  it("changes the hash in place afterwards and fronts the window", async () => {
    const router = new LinkRouter();
    const window = new FakeWindow();
    window.url = router.ready(window, "http://127.0.0.1:8500/");
    router.open("cashu://investments/demo-anna");
    await tick();
    expect(window.calls).toEqual(["hash #/demo-anna/investments.portfolio", "show"]);
  });

  it("loads the route when the window shows something else, and only fronts for cashu://open", async () => {
    const router = new LinkRouter();
    const window = new FakeWindow();
    router.ready(window, "http://127.0.0.1:8500/");
    window.url = "data:text/html,error";
    router.open("cashu://review/demo-anna");
    await tick();
    expect(window.calls).toEqual([
      "load http://127.0.0.1:8500/#/demo-anna/investments.portfolio/?review=1",
      "show",
    ]);
    window.calls = [];
    router.open("cashu://open");
    await tick();
    expect(window.calls).toEqual(["show"]);
  });

  it("ignores links the app does not open", () => {
    const router = new LinkRouter();
    expect(router.open("https://example.com")).toBe(false);
  });
});
