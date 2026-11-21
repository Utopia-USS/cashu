import type { ErrorInfo } from "@cashu/host-protocol/store";

/** An unexpected failure on the host's side of the store channel, rethrown here (to the error boundary). */
export class RemoteStoreError extends Error {
  constructor(info: ErrorInfo) {
    super(info.message);
    this.name = info.name;
  }
}
