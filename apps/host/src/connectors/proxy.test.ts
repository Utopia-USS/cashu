import { once } from "node:events";
import { connect } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { ConnectorEgressProxy, exactConnectHost, publicAddress } from "./proxy.js";

function request(port: number, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.on("connect", () => socket.write(`${line}\r\nHost: synthetic\r\n\r\n`));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("ascii")));
    socket.on("error", reject);
  });
}

describe("connector egress proxy", () => {
  it("allows only exact manifest host on TLS port", () => {
    const hosts = ["api.example.com"];
    expect(exactConnectHost("CONNECT api.example.com:443 HTTP/1.1", hosts)).toBe("api.example.com");
    for (const line of [
      "CONNECT api.example.com:80 HTTP/1.1",
      "CONNECT evil.example.com:443 HTTP/1.1",
      "CONNECT api.example.com.evil.test:443 HTTP/1.1",
      "CONNECT 127.0.0.1:443 HTTP/1.1",
      "GET https://api.example.com/ HTTP/1.1",
      "CONNECT api.example.com:443 HTTP/2",
    ])
      expect(exactConnectHost(line, hosts)).toBeNull();
  });

  it("rejects local, private, link-local, multicast and documentation addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.1.1",
      "192.168.1.1",
      "169.254.1.1",
      "224.1.1.1",
      "192.0.2.1",
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:127.0.0.1",
      "2001:db8::1",
    ])
      expect(publicAddress(address)).toBe(false);
    expect(publicAddress("8.8.8.8")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("refuses host/port and DNS rebinding before any upstream dial", async () => {
    let resolutions = 0;
    const proxy = new ConnectorEgressProxy(["api.example.com"], async () => {
      resolutions++;
      return [{ address: "8.8.8.8" }, { address: "127.0.0.1" }];
    });
    const port = await proxy.start();
    try {
      expect(await request(port, "CONNECT api.example.com:80 HTTP/1.1")).toContain("403 Forbidden");
      expect(await request(port, "CONNECT evil.example.com:443 HTTP/1.1")).toContain(
        "403 Forbidden",
      );
      expect(await request(port, "CONNECT api.example.com:443 HTTP/1.1")).toContain(
        "403 Forbidden",
      );
      expect(resolutions).toBe(1);
    } finally {
      await proxy.close();
    }
  });

  it("never dials after close while DNS was pending", async () => {
    let finishDns: ((addresses: { address: string }[]) => void) | undefined;
    let enteredDns: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredDns = resolve;
    });
    const pendingDns = new Promise<{ address: string }[]>((resolve) => {
      finishDns = resolve;
    });
    let dials = 0;
    const proxy = new ConnectorEgressProxy(
      ["api.example.com"],
      () => {
        enteredDns?.();
        return pendingDns;
      },
      () => {
        dials++;
        throw new Error("must not dial");
      },
    );
    const port = await proxy.start();
    const pending = request(port, "CONNECT api.example.com:443 HTTP/1.1");
    await entered;
    await proxy.close();
    finishDns?.([{ address: "8.8.8.8" }]);
    await pending;
    expect(dials).toBe(0);
  });

  it("caps concurrent client sockets", async () => {
    const proxy = new ConnectorEgressProxy(["api.example.com"]);
    const port = await proxy.start();
    const held = [];
    try {
      for (let i = 0; i < 4; i++) {
        const socket = connect({ host: "127.0.0.1", port });
        await once(socket, "connect");
        held.push(socket);
        await vi.waitFor(() => expect(proxy.activeClients).toBe(i + 1));
      }
      // Refused either way: macOS resets the fifth socket, Linux closes it with no answer.
      const answer = await request(port, "CONNECT api.example.com:443 HTTP/1.1").catch(() => "");
      expect(answer).not.toMatch(/ 200 /);
      expect(proxy.activeClients).toBe(4);
    } finally {
      for (const socket of held) socket.destroy();
      await proxy.close();
    }
  });
});
