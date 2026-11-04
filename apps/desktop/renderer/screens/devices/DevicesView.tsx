import { T } from "./Devices.strings.js";
import { LeaderAction } from "./LeaderAction.js";
import type { DevicesScreenState } from "./useDevicesScreen.js";

const control =
  "rounded-sm border border-border bg-surface px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent";
const button =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent";

export function DevicesView({ state }: { state: DevicesScreenState }) {
  if (state.list?.kind !== "ready") return <p>{T.unavailable}</p>;
  const list = state.list;
  const reviewBlocked =
    list.evidence.historyPending ||
    list.evidence.overflow ||
    list.evidence.authorityUncertain ||
    list.evidence.writeAdmission !== "ready" ||
    list.operations.some((operation) => operation.phase === "may_append");
  const deviceName = (id: string | null) =>
    id === null ? T.leaderNone : (list.devices.find((device) => device.id === id)?.name ?? id);
  const issuerName = (id: string) => (id === "0".repeat(32) ? T.issuerRecovery : deviceName(id));
  const origins = [...list.devices].sort(
    (a, b) =>
      a.pairedAt.seg - b.pairedAt.seg ||
      a.pairedAt.offset - b.pairedAt.offset ||
      a.id.localeCompare(b.id),
  );
  const orphanOrder = new Map(origins.map((device, index) => [device.id, index]));
  const originsById = new Map(origins.map((device) => [device.id, device]));
  const affected = [...(state.preview?.affected ?? [])].sort(
    (a, b) =>
      (orphanOrder.get(a.device) ?? Number.MAX_SAFE_INTEGER) -
        (orphanOrder.get(b.device) ?? Number.MAX_SAFE_INTEGER) || a.device.localeCompare(b.device),
  );
  const leaderStatus =
    list.leader.state === "auto"
      ? T.leaderAuto
      : list.leader.state === "leaderless"
        ? T.leaderNone
        : list.leader.state === "handover_pending"
          ? T.leaderPending
          : list.leader.state === "silent"
            ? T.leaderSilent
            : T.leaderOk;
  const provenanceStatus =
    list.keyProvenance.source === "own"
      ? T.provenanceOwn
      : list.keyProvenance.source === "wrap"
        ? T.provenanceWrap
        : list.keyProvenance.source === "pairing"
          ? T.provenancePairing
          : T.provenanceUnknown;
  return (
    <div className="grid gap-4">
      <section className="grid gap-1" aria-label={T.leaderTitle}>
        <h3>{T.leaderTitle}</h3>
        <p>{list.leader.mode === "auto" ? T.leaderAuto : deviceName(list.leader.device)}</p>
        <p role={list.leader.warn ? "alert" : "status"}>{leaderStatus}</p>
        {list.leader.pendingFrom && (
          <p>
            {T.leaderPending}: {deviceName(list.leader.pendingFrom)}
          </p>
        )}
      </section>
      {list.leader.warn && <LeaderAction list={list} />}
      <section className="grid gap-1" aria-label={T.provenanceTitle}>
        <h3>{T.provenanceTitle}</h3>
        <p>{provenanceStatus}</p>
        {list.keyProvenance.sender && (
          <p>
            {T.issuerBy}: {issuerName(list.keyProvenance.sender)}
          </p>
        )}
      </section>
      <section className="grid gap-1" aria-label={T.issuerTitle}>
        <h3>{T.issuerTitle}</h3>
        <ul>
          {origins.map((device) => (
            <li key={device.id}>
              {device.name}: {T.issuerBy} {issuerName(device.pairedBy)} (
              {T.issuerAt(device.pairedAt.seg, device.pairedAt.offset)})
              {device.forkAgreed && (
                <span>
                  . {T.forkAgreed}: {T.issuerAt(device.forkAgreed.seg, device.forkAgreed.offset)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
      {list.evidence.overflow ? (
        <p role="alert">{T.evidenceOverflow}</p>
      ) : list.evidence.historyPending || list.evidence.authorityUncertain ? (
        <p role="alert">{T.evidencePending}</p>
      ) : list.evidence.writeAdmission !== "ready" ? (
        <p role="alert">{T.writerPaused}</p>
      ) : null}
      {list.devices
        .filter((device) => device.forked)
        .map((device) => (
          <p role="alert" key={device.id}>
            {device.name}: {T.forked}
          </p>
        ))}
      {list.devices
        .filter((device) => device.behind && !device.forked)
        .map((device) => (
          <p role="status" key={device.id}>
            {device.name}: {T.behind}
          </p>
        ))}
      <label className="grid gap-2">
        <span>{T.choose}</span>
        <select
          className={control}
          value={state.target}
          onChange={(event) => state.setTarget(event.target.value)}
          disabled={!!state.preview || state.status === "busy"}
        >
          <option value="">{T.choose}</option>
          {list.devices
            .filter((device) => device.id !== list.ownDevice && device.trusted && !device.revoked)
            .map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
        </select>
      </label>
      {!state.preview && (
        <button
          className={button}
          type="button"
          disabled={!state.target || state.status === "busy" || reviewBlocked}
          onClick={() => void state.review()}
        >
          {T.preview}
        </button>
      )}
      {state.preview && (
        <div className="grid gap-4 rounded-lg border border-border bg-surface-raised p-4">
          <p role="alert">{T.warning}</p>
          <ul>
            {state.preview.targets.map((target) => (
              <li key={target.device}>
                {list.devices.find((device) => device.id === target.device)?.name ?? target.device}:{" "}
                {target.head === "trusted" ? T.headTrusted : T.headLocalStart}
              </li>
            ))}
          </ul>
          {state.preview.affected.length > 0 && (
            <fieldset className="grid gap-2">
              <legend>{T.orphanTitle}</legend>
              {affected.map((device) => {
                const origin = originsById.get(device.device);
                return (
                  <label key={device.device} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      disabled={state.status === "busy"}
                      checked={state.recertify.includes(device.device)}
                      onChange={(event) =>
                        state.toggleRecertify(device.device, event.target.checked)
                      }
                    />
                    {T.orphanChoice}: {device.name}
                    {origin && (
                      <span>
                        {" "}
                        ({T.issuerBy} {issuerName(origin.pairedBy)},{" "}
                        {T.issuerAt(origin.pairedAt.seg, origin.pairedAt.offset)})
                      </span>
                    )}
                  </label>
                );
              })}
            </fieldset>
          )}
          {state.selectionDirty && (
            <button
              className={button}
              type="button"
              disabled={state.status === "busy"}
              onClick={() => void state.review()}
            >
              {T.refreshSelection}
            </button>
          )}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              disabled={state.status === "busy"}
              checked={state.warningAck}
              onChange={(event) => state.setWarningAck(event.target.checked)}
            />
            {T.warningAck}
          </label>
          {state.preview.localStartConfirmationRequired && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                disabled={state.status === "busy"}
                checked={state.localAck}
                onChange={(event) => state.setLocalAck(event.target.checked)}
              />
              {T.localStart}
            </label>
          )}
          <label className="grid gap-2">
            <span>{T.recovery}</span>
            <span>{T.recoveryHelp}</span>
            <input
              className={control}
              disabled={state.status === "busy"}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={state.phrase}
              onChange={(event) => state.setPhrase(event.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button
              className={button}
              type="button"
              disabled={
                state.status === "busy" ||
                state.selectionDirty ||
                !state.warningAck ||
                !state.phrase ||
                (state.preview.localStartConfirmationRequired && !state.localAck)
              }
              onClick={() => void state.commit()}
            >
              {T.remove}
            </button>
            <button
              className={button}
              type="button"
              disabled={state.status === "busy"}
              onClick={() => void state.cancel()}
            >
              {T.cancel}
            </button>
          </div>
        </div>
      )}
      {state.status === "completed" && <p role="status">{T.completed}</p>}
      {state.status === "failed" && (
        <p role="alert">{state.refusal === "recertify_capacity" ? T.capacity : T.failed}</p>
      )}
      {state.status === "unknown" && <p role="alert">{T.unknown}</p>}
      {state.status === "unknown" && state.operationId && (
        <button className={button} type="button" onClick={() => void state.inspect()}>
          {T.inspect}
        </button>
      )}
    </div>
  );
}
