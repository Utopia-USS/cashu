/** Code-only one-shot import errors; no source paths or financial fields leave this boundary. */
export type MigrationRefusal =
  | "source_unsafe"
  | "source_changed"
  | "snapshot_unverified"
  | "unsupported_schema"
  | "semantic_difference"
  | "mapping_invalid"
  | "identity_invalid"
  | "replay_mismatch";

export class MigrationError extends Error {
  readonly code: MigrationRefusal;
  constructor(code: MigrationRefusal) {
    super(code);
    this.code = code;
    this.name = "MigrationError";
  }
}
