import { describe, expect, it } from "vitest";
import { type NativeNotification, Notifier, requestFromPayload } from "./notify.js";

describe("notification requests (NativeRequest.from_payload)", () => {
  it("normalizes whitespace, caps lengths and keeps an openable link", () => {
    const request = requestFromPayload(
      {
        title: "  Signal \n  fired ",
        subtitle: "x".repeat(300),
        message: "a   b",
        group: "signals.demo-anna",
        url: "cashu://signal/demo-anna/1",
      },
      () => "id",
    );
    expect(request).toEqual({
      identifier: "signals.demo-anna",
      title: "Signal fired",
      subtitle: "x".repeat(120),
      message: "a b",
      url: "cashu://signal/demo-anna/1",
    });
  });

  it("drops a link the app would not open and generates an identifier", () => {
    const request = requestFromPayload(
      { title: "t", message: "m", url: "https://example.com" },
      () => "abc",
    );
    expect(request.url).toBeNull();
    expect(request.identifier).toBe("cashu-abc");
  });

  it("rejects malformed payloads", () => {
    expect(() => requestFromPayload("x")).toThrow(TypeError);
    expect(() => requestFromPayload([])).toThrow(TypeError);
    expect(() => requestFromPayload({ message: "m" })).toThrow(/title/);
    expect(() => requestFromPayload({ title: "  ", message: "m" })).toThrow(/title/);
    expect(() => requestFromPayload({ title: "t", message: 4 })).toThrow(/message/);
    expect(() => requestFromPayload({ title: "t", message: "m", group: "bad group" })).toThrow(
      /group/,
    );
  });
});

class FakeNotification implements NativeNotification {
  closed = false;
  shown = false;
  click: (() => void) | null = null;
  show() {
    this.shown = true;
  }
  close() {
    this.closed = true;
  }
  on(_event: "click", listener: () => void) {
    this.click = listener;
  }
}

describe("Notifier", () => {
  it("posts, routes a click to its link and replaces a notification of the same group", () => {
    const created: FakeNotification[] = [];
    const clicks: (string | null)[] = [];
    const notifier = new Notifier({
      supported: () => true,
      create: () => {
        const n = new FakeNotification();
        created.push(n);
        return n;
      },
      onClick: (url) => clicks.push(url),
    });
    const request = requestFromPayload({
      title: "t",
      message: "m",
      group: "g",
      url: "cashu://open",
    });
    expect(notifier.post(request)).toEqual({ status: "posted" });
    expect(created[0]?.shown).toBe(true);
    created[0]?.click?.();
    expect(clicks).toEqual(["cashu://open"]);
    notifier.post(request);
    expect(created[0]?.closed).toBe(true);
    expect(created).toHaveLength(2);
  });

  it("reports an unsupported system instead of failing", () => {
    const notifier = new Notifier({
      supported: () => false,
      create: () => {
        throw new Error("must not be called");
      },
      onClick: () => {},
    });
    expect(notifier.post(requestFromPayload({ title: "t", message: "m" }))).toEqual({
      status: "unsupported",
    });
  });
});
