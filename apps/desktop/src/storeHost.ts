/// <reference types="node" />
// The main process side of the store process (layers.md "Which process runs what"): fork it, hand
// each renderer that asks a MessagePort into it, stop it on quit. Main never reads store data; it
// only routes ports. Electron's `utilityProcess` and `MessageChannelMain` come in as functions so the
// lifecycle is testable without Electron.
//
// TRANSITIONAL(desktop-renderer): started only behind CASHU_DESKTOP_STORE=1 (config.ts) until the first
// TS screen reads the store; the Python sidecar keeps serving the legacy SPA meanwhile (strangler).
import { STOP_TIMEOUT_MS } from "./config.js";
import { type FromStoreProcess, isFromStoreProcess, type ToStoreProcess } from "./storeControl.js";

/** The part of Electron's `UtilityProcess` used here. */
export interface UtilityLike {
  postMessage(message: ToStoreProcess, transfer?: unknown[]): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}

export interface StoreProcessOptions<Port> {
  fork(): UtilityLike;
  /** A new pair of entangled ports (`new MessageChannelMain()`). */
  createChannel(): { port1: Port; port2: Port };
  log(line: string): void;
  stopTimeoutMs?: number;
}

export class StoreProcess<Port> {
  private child: UtilityLike | null = null;
  private exited: Promise<number> | null = null;
  private ready: Promise<void> | null = null;

  constructor(private readonly options: StoreProcessOptions<Port>) {}

  /** Fork the store process; resolves when it opened its stores, rejects when it exits first. */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    const child = this.options.fork();
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.on("exit", (code) => {
        this.child = null;
        this.options.log(`store process exited (${code})`);
        resolve(code);
      });
    });
    this.ready = new Promise((resolve, reject) => {
      child.on("message", (message) => {
        if (!isFromStoreProcess(message)) {
          this.options.log("store process: unknown message ignored");
          return;
        }
        this.onMessage(message, resolve);
      });
      void this.exited?.then((code) => reject(new Error(`store process exited (${code})`)));
    });
    return this.ready;
  }

  private onMessage(message: FromStoreProcess, resolve: () => void): void {
    if (message.t === "ready") {
      this.options.log(`store process ready (${message.vaults} vaults)`);
      resolve();
    } else if (message.t === "log") {
      this.options.log(message.line);
    }
  }

  /** Give a renderer its own port into the store process; false when the process is not running. */
  connect(deliver: (port: Port) => void): boolean {
    if (this.child === null) return false;
    const { port1, port2 } = this.options.createChannel();
    this.child.postMessage({ t: "connect" }, [port1]);
    deliver(port2);
    return true;
  }

  /** Ask the store process to close its stores and exit; killed after the timeout. */
  async stop(): Promise<void> {
    const child = this.child;
    if (child === null || this.exited === null) return;
    child.postMessage({ t: "stop" });
    const timeout = this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeout);
    });
    const outcome = await Promise.race([this.exited, timedOut]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      this.options.log("store process did not stop in time: killed");
      child.kill();
      await this.exited;
    }
  }
}
