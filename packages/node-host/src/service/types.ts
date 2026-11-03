/** Registration is separate from whether a host process is currently connected. */
export type ServiceState = "off" | "enabled" | "requires_approval" | "unavailable" | "error";

export interface ServiceStatus {
  readonly state: ServiceState;
  /** Fixed daily local calendar wake, when supported by the platform adapter. */
  readonly nextWake?: Date;
  /** Stable diagnostic code only. Never a command, path, or OS error message. */
  readonly reason?: string;
}

export type StartOutcome =
  | { readonly kind: "started" }
  | { readonly kind: "unavailable"; readonly reason?: string }
  | { readonly kind: "failed"; readonly reason?: string };

export interface HostService {
  status(): Promise<ServiceStatus>;
  enable(): Promise<ServiceStatus>;
  disable(): Promise<ServiceStatus>;
  /** One bounded start request for the fixed registered service. */
  start(): Promise<StartOutcome>;
}
