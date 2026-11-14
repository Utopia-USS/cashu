/** Process-local I/O identity; independent of store and runtime execution. */
export interface NativeAsyncIo {
  readonly vault: string;
  /** Process-local identity of an actual host capability, never serialized. */
  readonly binding: object;
  isCurrent(): boolean;
}
