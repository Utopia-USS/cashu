import type { Channel } from "./types.js";

/** The part of a DOM (or Node global) MessagePort the channel uses. */
export interface MessagePortLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  start(): void;
}

/** A DOM-style MessagePort (the desktop renderer's store port, relayed by main to the host) as a `Channel`. */
export function messagePortChannel(port: MessagePortLike): Channel {
  return {
    post: (message) => port.postMessage(message),
    listen(handler) {
      const listener = (event: MessageEvent) => handler(event.data);
      port.addEventListener("message", listener);
      port.start();
      return () => port.removeEventListener("message", listener);
    },
  };
}
