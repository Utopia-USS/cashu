import { lookup } from "node:dns/promises";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";

const MAX_HEADER = 4096;
const MAX_TRANSFER = 128 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_CLIENTS = 4;

function ipv4Public(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if ((a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)) return false;
  if ((a === 192 && (b === 168 || (b === 0 && c === 0))) || (a === 198 && b >= 18 && b <= 19))
    return false;
  if (
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  )
    return false;
  return true;
}

function ipv6Public(address: string): boolean {
  const value = address.split("%")[0]?.toLowerCase();
  if (!value || isIP(value) !== 6) return false;
  if (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb")
  )
    return false;
  if (value.startsWith("::ffff:")) return ipv4Public(value.slice(7));
  if (value.startsWith("2001:db8:") || value.startsWith("2001:db8::")) return false;
  // Only globally routed unicast (2000::/3) is accepted.
  const first = Number.parseInt(value.split(":")[0] ?? "", 16);
  const second = Number.parseInt(value.split(":")[1] || "0", 16);
  if (first === 0x2001 && second <= 0x01ff) return false; // IETF special-purpose space
  if (first === 0x2002 || first === 0x3fff) return false; // 6to4 and documentation
  return Number.isFinite(first) && first >= 0x2000 && first <= 0x3fff;
}

export function publicAddress(address: string): boolean {
  const version = isIP(address);
  return version === 4 ? ipv4Public(address) : version === 6 ? ipv6Public(address) : false;
}

export function exactConnectHost(requestLine: string, hosts: readonly string[]): string | null {
  const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.[01]$/.exec(requestLine);
  return match && hosts.includes(match[1] ?? "") ? (match[1] ?? null) : null;
}

function reject(client: Socket): void {
  if (!client.destroyed) client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
}

/** Exact-host CONNECT proxy. It resolves once and dials the checked address, never the host string. */
export class ConnectorEgressProxy {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly clients = new Set<Socket>();
  readonly deniedHosts: string[] = [];
  bytesUp = 0;
  bytesDown = 0;
  get activeClients(): number {
    return this.clients.size;
  }
  constructor(
    readonly hosts: readonly string[],
    private readonly resolveHost: (host: string) => Promise<{ address: string }[]> = (host) =>
      lookup(host, { all: true, verbatim: true }),
    private readonly dial: typeof connect = connect,
  ) {}

  async start(): Promise<number> {
    if (this.server) throw new Error("proxy already running");
    const server = createServer((client) => this.accept(client));
    this.server = server;
    try {
      await new Promise<void>((resolve, rejectStart) => {
        server.once("error", rejectStart);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", rejectStart);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("proxy address unavailable");
      return address.port;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private accept(client: Socket): void {
    if (this.clients.size >= MAX_CLIENTS) {
      client.destroy();
      return;
    }
    this.clients.add(client);
    this.sockets.add(client);
    client.once("close", () => {
      this.sockets.delete(client);
      this.clients.delete(client);
    });
    client.setTimeout(TIMEOUT_MS, () => client.destroy());
    let header = Buffer.alloc(0);
    const initial = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      if (header.length > MAX_HEADER) {
        client.off("data", initial);
        reject(client);
        return;
      }
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", initial);
      client.pause();
      const firstLine = header.subarray(0, header.indexOf("\r\n")).toString("ascii");
      const host = exactConnectHost(firstLine, this.hosts);
      if (!host) {
        if (this.deniedHosts.length < 20) this.deniedHosts.push("denied");
        reject(client);
        return;
      }
      void this.forward(client, host, header.subarray(end + 4));
    };
    client.on("data", initial);
    client.on("error", () => client.destroy());
  }

  private async forward(client: Socket, host: string, remainder: Buffer): Promise<void> {
    let addresses: { address: string }[];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([
        this.resolveHost(host),
        new Promise<never>((_, rejectTimeout) => {
          timer = setTimeout(() => rejectTimeout(new Error("resolution timeout")), 15_000);
        }),
      ]);
    } catch {
      reject(client);
      return;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!this.server || client.destroyed) return;
    if (addresses.length === 0 || addresses.some((item) => !publicAddress(item.address))) {
      reject(client);
      return;
    }
    if (!this.server || client.destroyed) return;
    const remote = this.dial({ host: addresses[0]?.address, port: 443 });
    this.sockets.add(remote);
    remote.once("close", () => this.sockets.delete(remote));
    remote.setTimeout(TIMEOUT_MS, () => remote.destroy());
    remote.once("connect", () => {
      if (client.destroyed) {
        remote.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (remainder.length) {
        this.bytesUp += remainder.length;
        if (this.bytesUp > MAX_TRANSFER) {
          client.destroy();
          remote.destroy();
          return;
        }
        remote.write(remainder);
      }
      client.resume();
      client.on("data", (chunk: Buffer) => {
        this.bytesUp += chunk.length;
        if (this.bytesUp > MAX_TRANSFER) {
          client.destroy();
          remote.destroy();
        }
      });
      remote.on("data", (chunk: Buffer) => {
        this.bytesDown += chunk.length;
        if (this.bytesDown > MAX_TRANSFER) {
          client.destroy();
          remote.destroy();
        }
      });
      client.pipe(remote);
      remote.pipe(client);
    });
    remote.on("error", () => {
      reject(client);
      remote.destroy();
    });
    client.once("close", () => remote.destroy());
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
