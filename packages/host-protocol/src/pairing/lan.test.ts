import { describe, expect, it } from "vitest";
import { decodeLanDescriptor, encodeLanDescriptor } from "./lan.js";

const spki = "c".repeat(64);
const canonical = encodeLanDescriptor({ v: 1, ip: "192.168.1.20", port: 8517, spki });

describe("LAN descriptor decoding", () => {
  it("round trips the canonical descriptor", () => {
    expect(decodeLanDescriptor(canonical)).toEqual({ v: 1, ip: "192.168.1.20", port: 8517, spki });
  });

  it.each([
    ["not JSON", "{"],
    ["an array", `[1,"192.168.1.20",8517,"${spki}"]`],
    ["null", "null"],
    ["a wrong version", canonical.replace('"v":1', '"v":2')],
    ["a string port", canonical.replace("8517", '"8517"')],
    ["a fractional port", canonical.replace("8517", "8517.5")],
    ["port zero", canonical.replace("8517", "0")],
    ["port above 65535", canonical.replace("8517", "65536")],
    ["an uppercase SPKI", canonical.replace(spki, "C".repeat(64))],
    ["a public IP", canonical.replace("192.168.1.20", "8.8.8.8")],
    ["a numeric IP", canonical.replace('"192.168.1.20"', "3232235796")],
    ["an extra key", canonical.replace("}", ',"x":1}')],
    ["a missing key", JSON.stringify({ v: 1, ip: "192.168.1.20", port: 8517 })],
    ["reordered keys", JSON.stringify({ ip: "192.168.1.20", v: 1, port: 8517, spki })],
    ["whitespace", canonical.replace(",", ", ")],
  ])("refuses %s", (_label, text) => {
    expect(decodeLanDescriptor(text)).toBeUndefined();
  });

  it("admits loopback only when allowed", () => {
    const loopback = encodeLanDescriptor({ v: 1, ip: "127.0.0.1", port: 8517, spki }, true);
    expect(decodeLanDescriptor(loopback)).toBeUndefined();
    expect(decodeLanDescriptor(loopback, true)).toMatchObject({ ip: "127.0.0.1" });
  });
});
