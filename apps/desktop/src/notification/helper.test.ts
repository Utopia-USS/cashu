import { Readable, Writable } from "node:stream";
import { type NotifyFrame, serializeNotifyFrame } from "@cashu/host-protocol";
import { describe, expect, it, vi } from "vitest";
import { processNotificationFrame, runNotificationHelperWith } from "./helper.js";
import type { NativeNotificationCenter, PermissionStatus, PostStatus } from "./native.js";

const request: NotifyFrame = {
  version: 1,
  requestId: "12345678-1234-4234-8234-123456789abc",
  locale: "pl",
  kind: "signal",
  intentToken: "a".repeat(64),
};

function center(
  permission: PermissionStatus,
  post: PostStatus = "accepted",
): NativeNotificationCenter {
  return {
    identity: vi.fn(() => ({
      bundleIdentifier: "io.utopiasoft.cashu.next",
      bundleURL: "/fixture/cashU.app",
      executableName: "cashU",
      executableURL: "/fixture/cashU.app/Contents/MacOS/cashU",
      verified: true,
    })),
    permissionStatus: vi.fn(async () => permission),
    post: vi.fn(async () => post),
    requestPermission: vi.fn(async (): Promise<PermissionStatus> => "allowed"),
    installResponseHandler: vi.fn(() => true),
    releaseResponseHandler: vi.fn(),
  };
}

function capture(): { stream: Writable; output: () => string } {
  const chunks: Buffer[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
    output: () => Buffer.concat(chunks).toString("utf8"),
  };
}

describe("notification helper", () => {
  it.each(["denied", "pending", "unavailable"] as const)(
    "never posts or prompts for %s",
    async (permission) => {
      const fake = center(permission);
      const ack = await processNotificationFrame(serializeNotifyFrame(request), fake);
      expect(ack?.status).toBe(permission);
      expect(fake.post).not.toHaveBeenCalled();
      expect(fake.requestPermission).not.toHaveBeenCalled();
    },
  );

  it("keeps add uncertainty silent, including completion error", async () => {
    const fake = center("allowed", "unknown");
    const output = capture();
    const code = await runNotificationHelperWith(
      Readable.from([serializeNotifyFrame(request)]),
      output.stream,
      fake,
    );
    expect(code).toBe(2);
    expect(output.output()).toBe("");
    expect(fake.post).toHaveBeenCalledOnce();
  });

  it("acknowledges only a native pre-add rejection", async () => {
    const ack = await processNotificationFrame(
      serializeNotifyFrame(request),
      center("allowed", "rejected"),
    );
    expect(ack?.status).toBe("rejected");
  });

  it("refuses a bundle identity that does not match the running executable", async () => {
    const fake = center("allowed");
    vi.mocked(fake.identity).mockReturnValueOnce({ ...fake.identity(), verified: false });
    const ack = await processNotificationFrame(serializeNotifyFrame(request), fake);
    expect(ack).toBeNull();
    expect(fake.post).not.toHaveBeenCalled();
  });

  it("keeps a native exception after posting ambiguous", async () => {
    const fake = center("allowed");
    vi.mocked(fake.post).mockRejectedValueOnce(new Error("synthetic platform detail"));
    const output = capture();
    expect(
      await runNotificationHelperWith(
        Readable.from([serializeNotifyFrame(request)]),
        output.stream,
        fake,
      ),
    ).toBe(2);
    expect(output.output()).toBe("");
  });

  it("emits one exact ACK for acceptance and no sensitive fields", async () => {
    const output = capture();
    const code = await runNotificationHelperWith(
      Readable.from([serializeNotifyFrame(request)]),
      output.stream,
      center("allowed"),
    );
    expect(code).toBe(0);
    expect(output.output()).toBe(
      `{"version":1,"requestId":"${request.requestId}","status":"accepted"}\n`,
    );
    expect(output.output()).not.toContain(request.intentToken);
  });

  it("refuses noncanonical input before native calls", async () => {
    const fake = center("allowed");
    const output = capture();
    const duplicate = Buffer.from(
      `{"version":1,"version":1,"requestId":"${request.requestId}","locale":"pl","kind":"signal","intentToken":"${request.intentToken}"}\n`,
    );
    const code = await runNotificationHelperWith(Readable.from([duplicate]), output.stream, fake);
    expect(code).toBe(2);
    expect(fake.identity).not.toHaveBeenCalled();
    expect(output.output()).toBe("");
  });

  it("refuses extra bytes and invalid UTF-8", async () => {
    for (const bytes of [
      Buffer.concat([serializeNotifyFrame(request), Buffer.from("x")]),
      Buffer.from([0xff, 0x0a]),
    ]) {
      const fake = center("allowed");
      const output = capture();
      expect(await runNotificationHelperWith(Readable.from([bytes]), output.stream, fake)).toBe(2);
      expect(fake.identity).not.toHaveBeenCalled();
    }
  });
});
