// The host's socket side: take the machine lock, then (and only then) replace a stale socket, write a
// fresh token, listen on the Unix socket (never TCP), and publish host.json. Each connection must
// finish the mutual handshake within the hello deadline; an authenticated connection becomes a
// `HostSession` bound to the role (and profile) it named, and any frame its role may not send, or
// that is not a valid session frame, closes it. What a session does is the host app's business
// (`onSession`); this module only guarantees who is on the other end.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import {
  answerHello,
  type ClientFrame,
  checkAuth,
  clientFrameSchema,
  formatNonce,
  HOST_PROTOCOL,
  type HostFrame,
  MAX_FRAME_BYTES,
  type PendingAuth,
  type ProtocolVersion,
  type Role,
  roleAllows,
} from "@cashu/host-protocol";
import { readDiscovery, writeDiscovery, writeHostToken } from "./files.js";
import { FrameSocket } from "./frameSocket.js";
import { acquireHostLock, type HostLock } from "./lock.js";
import {
  assertSocketPath,
  ensurePrivateDir,
  type HostPathEnv,
  type HostRunPaths,
  hostRunPaths,
} from "./paths.js";
import { assertHostAdmission } from "./updateAdmission.js";

/** Exit code of a host that found another host holding the lock (spawn races end this way). */
export const HOST_BUSY_EXIT = 3;

export class HostBusyError extends Error {
  readonly exitCode = HOST_BUSY_EXIT;

  constructor() {
    super("another host owns this data dir");
    this.name = "HostBusyError";
  }
}

/** An authenticated connection. */
export interface HostSession {
  readonly id: number;
  readonly role: Role;
  /** The one profile of an `mcp` session; undefined for the other roles. */
  readonly profile: string | undefined;
  /** The client's build and protocol (minor versions may differ). */
  readonly build: string;
  readonly protocol: ProtocolVersion;
  send(frame: HostFrame): void;
  /** Frames the session's role may send, already validated. */
  onFrame(handler: (frame: ClientFrame) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface StartHostOptions {
  readonly dataDir: string;
  /** This host's build id (shown to clients and in host.json). */
  readonly build: string;
  readonly features?: readonly string[];
  readonly pathEnv?: HostPathEnv;
  /** Unauthenticated connections are closed after this long (default 2 s). */
  readonly helloDeadlineMs?: number;
  readonly maxFrameBytes?: number;
  readonly onSession: (session: HostSession) => void;
  readonly now?: () => Date;
  /**
   * Start in the starting phase: the socket is bound (clients find this host and do not start
   * another), but every hello is refused as `starting` until `ready()`. A host that opens its stores
   * after taking the lock uses it, so a client waits instead of getting a session nothing serves.
   */
  readonly starting?: boolean;
}

export interface RunningHost {
  readonly paths: HostRunPaths;
  readonly lock: HostLock;
  readonly startedAt: Date;
  /** Open sessions per role. */
  sessionCounts(): Record<Role, number>;
  readonly stopping: boolean;
  /** True from a `starting` start until `ready()`. */
  readonly starting: boolean;
  /** Ends the starting phase: hellos are answered from now on (idempotent). */
  ready(): void;
  /** New hellos are refused as `stopping` (clients retry and start a new host); sessions stay. */
  beginStop(): void;
  /** Stops accepting, closes every connection, removes socket / token / host.json, then releases
   * the lock (in that order, so a successor never has its files removed). */
  close(): Promise<void>;
}

const listen = (server: Server, path: string) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });

/**
 * Starts the data dir's host socket. Throws `HostBusyError` when another host holds the lock; any
 * other failure after the lock was taken releases it again.
 */
export async function startHost(options: StartHostOptions): Promise<RunningHost> {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const paths = hostRunPaths(options.dataDir, options.pathEnv);
  assertSocketPath(paths);
  ensurePrivateDir(paths.runDir);
  const lock = acquireHostLock(paths.lockPath);
  if (lock === undefined) throw new HostBusyError();

  const token = new Uint8Array(randomBytes(32));
  const startedAt = (options.now ?? (() => new Date()))();
  const deadline = options.helloDeadlineMs ?? 2_000;
  const maxFrame = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  const sockets = new Set<Socket>();
  const sessions = new Set<HostSession>();
  let stopping = false;
  let starting = options.starting === true;
  let nextSession = 1;

  const identity = () => ({
    token,
    dataDir: paths.dataDirId,
    protocol: HOST_PROTOCOL,
    build: options.build,
    features: options.features ?? [],
    stopping,
    starting,
  });

  const accept = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const conn = new FrameSocket(socket, maxFrame);
    const timer = setTimeout(() => conn.destroy(), deadline);
    conn.onClose(() => clearTimeout(timer));
    let pending: PendingAuth | undefined;
    conn.onMessage((raw) => {
      if (pending === undefined) {
        const outcome = answerHello(raw, identity(), formatNonce(randomBytes(32)));
        if (!outcome.ok) return conn.end(outcome.reply);
        pending = outcome.pending;
        conn.send(outcome.reply);
        return;
      }
      const auth = checkAuth(raw, pending, token);
      if (!auth.ok) return conn.end(auth.reply);
      clearTimeout(timer);
      conn.send({ t: "ready" });
      open(conn, auth.session);
    });
  };

  const open = (conn: FrameSocket, binding: Parameters<typeof makeSession>[2]) => {
    const session = makeSession(conn, nextSession++, binding);
    sessions.add(session);
    session.onClose(() => sessions.delete(session));
    options.onSession(session);
  };

  const server = createServer(accept);
  try {
    assertHostAdmission(lock, options.dataDir, options.pathEnv);
    if (paths.socketDir !== paths.runDir) ensurePrivateDir(paths.socketDir);
    // Safe only because we hold the lock: a stale socket of a dead host, or a squatter's.
    rmSync(paths.socketPath, { force: true });
    writeHostToken(paths.tokenPath, token);
    await listen(server, paths.socketPath);
    chmodSync(paths.socketPath, 0o600);
    writeDiscovery(paths.discoveryPath, {
      format: 1,
      pid: process.pid,
      socket: paths.socketPath,
      protocol: HOST_PROTOCOL,
      build: options.build,
      startedAt: startedAt.toISOString(),
      dataDir: paths.dataDirId,
    });
  } catch (error) {
    server.close();
    rmSync(paths.socketPath, { force: true });
    lock.release();
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    paths,
    lock,
    startedAt,
    get stopping() {
      return stopping;
    },
    get starting() {
      return starting;
    },
    ready() {
      starting = false;
    },
    sessionCounts() {
      const counts: Record<Role, number> = { ui: 0, mcp: 0, cli: 0, admin: 0 };
      for (const s of sessions) counts[s.role] += 1;
      return counts;
    },
    beginStop() {
      stopping = true;
    },
    close() {
      closing ??= (async () => {
        stopping = true;
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const socket of sockets) socket.destroy();
        await closed;
        if (readDiscovery(paths.discoveryPath)?.pid === process.pid) {
          rmSync(paths.discoveryPath, { force: true });
        }
        rmSync(paths.tokenPath, { force: true });
        rmSync(paths.socketPath, { force: true });
        lock.release();
      })();
      return closing;
    },
  };
}

function makeSession(
  conn: FrameSocket,
  id: number,
  binding: { role: Role; profile: string | undefined; build: string; protocol: ProtocolVersion },
): HostSession {
  let handler: ((frame: ClientFrame) => void) | undefined;
  conn.onMessage((raw) => {
    const parsed = clientFrameSchema.safeParse(raw);
    if (!parsed.success || !roleAllows(binding.role, parsed.data)) {
      conn.destroy();
      return;
    }
    handler?.(parsed.data);
  });
  return {
    id,
    ...binding,
    send: (frame) => conn.send(frame),
    onFrame: (h) => {
      handler = h;
    },
    onClose: (h) => conn.onClose(() => h()),
    close: () => conn.end(),
  };
}
