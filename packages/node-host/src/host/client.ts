// The client side of the host socket: find the socket (host.json, else the computed path), run the
// handshake (verify the host first, then prove ourselves), and hand back a connection bound to the
// role. Failures come back as `HostConnectError` with a kind that says what to do next:
//   unavailable  no host answers (no token, no socket, refused connect, closed early): start one
//   stopping     the host is shutting down: start a new one and retry
//   starting     a host is still opening its stores: wait for it (do not start another) and retry
//   unverified   the peer cannot prove it holds the token (a stale token file or a squatter): retry
//   timeout      no answer within the handshake deadline: retry
//   refused      another major, another data dir, a bad role or failed auth: fatal, do not retry
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import {
  answerChallenge,
  type CallError,
  type ClientFrame,
  formatNonce,
  HOST_PROTOCOL,
  type HostFrame,
  type HostInfo,
  hostFrameSchema,
  MAX_FRAME_BYTES,
  makeHello,
  type ProtocolVersion,
  type RefusalReason,
  type Role,
  readAuthReply,
} from "@cashu/host-protocol";
import { readDiscovery, readHostToken } from "./files.js";
import { FrameSocket } from "./frameSocket.js";
import { type HostPathEnv, hostRunPaths } from "./paths.js";

export type HostConnectErrorKind =
  | "unavailable"
  | "stopping"
  | "starting"
  | "unverified"
  | "timeout"
  | "refused";

export class HostConnectError extends Error {
  readonly kind: HostConnectErrorKind;
  readonly reason: RefusalReason | undefined;

  constructor(kind: HostConnectErrorKind, message: string, reason?: RefusalReason) {
    super(message);
    this.name = "HostConnectError";
    this.kind = kind;
    this.reason = reason;
  }

  /** Whether connect-or-start should start a host and try again. */
  get retryable(): boolean {
    return this.kind !== "refused";
  }
}

/** A request answered with an error by the host. */
export class HostCallError extends Error {
  readonly code: string;

  constructor(error: CallError) {
    super(error.message);
    this.name = "HostCallError";
    this.code = error.code;
  }
}

export interface ConnectHostOptions {
  readonly dataDir: string;
  readonly role: Role;
  /** The profile of an `mcp` session (required for it, refused for other roles). */
  readonly profile?: string;
  /** This client's build id. */
  readonly build: string;
  readonly pathEnv?: HostPathEnv;
  /** The whole handshake must finish within this (default 2 s). */
  readonly timeoutMs?: number;
  /** Tests only: speak another protocol version. */
  readonly protocol?: ProtocolVersion;
}

export interface HostConnection {
  readonly role: Role;
  readonly host: HostInfo;
  send(frame: ClientFrame): void;
  /**
   * Every frame from the host except `res` frames answering `call`. Frames that arrive before the
   * handler is set (the host may push right after `ready`, e.g. the store channel's own `ready`) are
   * kept and delivered when it is set.
   */
  onFrame(handler: (frame: HostFrame) => void): void;
  onClose(handler: () => void): void;
  /** One request / response; rejects with `HostCallError`, or when the connection closes. */
  call(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}

/** Connects to the data dir's running host. Never starts one (see `connectOrStart`). */
export function connectHost(options: ConnectHostOptions): Promise<HostConnection> {
  const paths = hostRunPaths(options.dataDir, options.pathEnv);
  const token = readHostToken(paths.tokenPath);
  if (token === undefined) {
    return Promise.reject(new HostConnectError("unavailable", "no host token: no host is running"));
  }
  const socketPath = readDiscovery(paths.discoveryPath)?.socket ?? paths.socketPath;
  const hello = makeHello({
    role: options.role,
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    dataDir: paths.dataDirId,
    build: options.build,
    nc: formatNonce(randomBytes(32)),
    protocol: options.protocol ?? HOST_PROTOCOL,
  });

  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const conn = new FrameSocket(socket, MAX_FRAME_BYTES);
    let settled = false;
    const fail = (error: HostConnectError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new HostConnectError("timeout", "the host did not finish the handshake")),
      options.timeoutMs ?? 2_000,
    );
    // ENOENT (no socket), ECONNREFUSED (a dead host's socket file), ECONNRESET, ...: no host answers.
    socket.on("error", (error: NodeJS.ErrnoException) =>
      fail(
        new HostConnectError(
          "unavailable",
          `cannot reach the host socket (${error.code ?? "error"})`,
        ),
      ),
    );
    conn.onClose(() =>
      fail(
        new HostConnectError("unavailable", "the host closed the connection during the handshake"),
      ),
    );
    socket.on("connect", () => conn.send(hello));

    let host: HostInfo | undefined;
    conn.onMessage((raw) => {
      if (host === undefined) {
        const step = answerChallenge(raw, hello, token);
        switch (step.kind) {
          case "auth":
            host = step.host;
            conn.send(step.reply);
            return;
          case "unverified":
            return fail(
              new HostConnectError(
                "unverified",
                "the socket's owner could not prove it is the host",
              ),
            );
          case "refused":
            return fail(refusedError(step.reason));
          case "invalid":
            return fail(new HostConnectError("unverified", "invalid handshake reply"));
        }
      }
      const reply = readAuthReply(raw);
      if (reply.kind === "refused") return fail(refusedError(reply.reason));
      if (reply.kind === "invalid") {
        return fail(new HostConnectError("unverified", "invalid handshake reply"));
      }
      settled = true;
      clearTimeout(timer);
      resolve(openConnection(conn, options.role, host));
    });
  });
}

function refusedError(reason: RefusalReason): HostConnectError {
  if (reason === "stopping")
    return new HostConnectError("stopping", "the host is stopping", reason);
  if (reason === "starting")
    return new HostConnectError("starting", "the host is still opening its stores", reason);
  return new HostConnectError("refused", `the host refused the connection (${reason})`, reason);
}

function openConnection(conn: FrameSocket, role: Role, host: HostInfo): HostConnection {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let handler: ((frame: HostFrame) => void) | undefined;
  const early: HostFrame[] = [];
  conn.onMessage((raw) => {
    const parsed = hostFrameSchema.safeParse(raw);
    if (!parsed.success) {
      conn.destroy();
      return;
    }
    const frame = parsed.data;
    if (frame.t === "res") {
      const call = pending.get(frame.id);
      if (call !== undefined) {
        pending.delete(frame.id);
        if (frame.outcome.ok) call.resolve(frame.outcome.result);
        else call.reject(new HostCallError(frame.outcome.error));
        return;
      }
    }
    if (handler === undefined) early.push(frame);
    else handler(frame);
  });
  conn.onClose(() => {
    for (const call of pending.values()) call.reject(new Error("the host connection closed"));
    pending.clear();
  });
  return {
    role,
    host,
    send: (frame) => conn.send(frame),
    onFrame: (h) => {
      handler = h;
      for (const frame of early.splice(0)) h(frame);
    },
    onClose: (h) => conn.onClose(() => h()),
    call(method, params = {}) {
      if (conn.closed) return Promise.reject(new Error("the host connection closed"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        conn.send({ t: "req", id, method, params });
      });
    },
    close: () => conn.end(),
  };
}
