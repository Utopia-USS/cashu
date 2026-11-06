// Connector activity of one vault for Ustawienia > Konektory (ab24ab6 core/connectorsApi.ts `GET
// /connectors/<id>/runs`, the summary's `last_run` and the binding's sync fields): the newest runs per connector and
// each binding's leader-local fetch state. A device query, so a recorded run or a fetch-state change re-pushes it.
import { z } from "zod";
import { vaultId } from "../../events/v1/primitives.js";
import { defineQuery } from "../../query.js";

/** Old drawer `getConnectorRuns(id, 20)`: the runs listed per connector. */
export const CONNECTOR_RUNS_LISTED = 20;

/** A recorded run, owner view (the redacted stderr tail is hidden when the client asked for privacy). */
export interface ConnectorRunView {
  readonly id: number;
  readonly connectorId: string;
  /** The binding gid the run fetched for; null for a run of no binding (a restored Python run, an offline test). */
  readonly binding: string | null;
  readonly command: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: string;
  readonly errorKind: string | null;
  readonly records: number;
  readonly deniedHosts: readonly string[];
  readonly stderrTail: string | null;
}

/** One binding's leader-local sync state (Python binding `last_run_at`, `last_status`, `last_ok_at`, `backoff_until`). */
export interface ConnectorBindingSync {
  readonly binding: string;
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
  readonly lastOkAt: string | null;
  readonly backoffUntil: string | null;
}

export interface ConnectorActivity {
  /** Newest first, at most `CONNECTOR_RUNS_LISTED` per connector. */
  readonly runs: readonly ConnectorRunView[];
  readonly bindings: readonly ConnectorBindingSync[];
}

const deniedHosts = z.array(z.string().max(255)).max(64);

/** Rows are validated on write (a JSON string array); anything else, malformed JSON included, lists no hosts, so one
 * bad row never fails the whole query (Python tolerated it the same way). */
function hosts(json: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
  const parsed = deniedHosts.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** Exact selected-vault projection: runs of no profile or another vault never cross this query. */
export const connectorActivity = defineQuery({
  id: "device.settings.connectorActivity",
  scope: "device",
  run(read, args: { readonly vault: string; readonly privacy: boolean }): ConnectorActivity {
    if (!vaultId.safeParse(args.vault).success) return { runs: [], bindings: [] };
    const runs = read<{
      id: number;
      connectorId: string;
      binding: string | null;
      command: string;
      startedAt: string;
      durationMs: number;
      outcome: string;
      errorKind: string | null;
      records: number;
      deniedHostsJson: string;
      stderrTail: string | null;
    }>(
      `SELECT id, connectorId, binding, command, startedAt, durationMs, outcome, errorKind, records,
              deniedHostsJson, stderrTail
         FROM (SELECT id, connector_id AS connectorId, binding, command, started_at AS startedAt,
                      duration_ms AS durationMs, outcome, error_kind AS errorKind, records,
                      denied_hosts_json AS deniedHostsJson, stderr_tail AS stderrTail,
                      ROW_NUMBER() OVER (PARTITION BY connector_id ORDER BY id DESC) AS n
                 FROM connector_runs WHERE vault = ?)
        WHERE n <= ? ORDER BY id DESC`,
      args.vault,
      CONNECTOR_RUNS_LISTED,
    );
    const bindings = read<ConnectorBindingSync>(
      `SELECT binding, last_run_at AS lastRunAt, last_status AS lastStatus,
              last_ok_at AS lastOkAt, backoff_until AS backoffUntil
         FROM local_connector_fetch WHERE vault = ? ORDER BY binding LIMIT 500`,
      args.vault,
    );
    return {
      runs: runs.map(({ deniedHostsJson, stderrTail, ...row }) => ({
        ...row,
        deniedHosts: hosts(deniedHostsJson),
        stderrTail: args.privacy ? null : stderrTail,
      })),
      bindings,
    };
  },
});
