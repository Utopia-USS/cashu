import { D, Money as MoneyValue } from "@cashu/domain";
import { Amount, DateText, Money, VirtualList } from "@cashu/ui";
import type { ReactNode } from "react";
import { MarkdownDocument } from "./MarkdownDocument.js";
import { S } from "./Strategies.strings.js";
import type { StrategiesScreenState } from "./useStrategiesScreen.js";

const card = "rounded-lg border border-border bg-surface-raised p-4";
const button =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent";
function Rows<T>({
  rows,
  rowKey,
  children,
  label,
}: {
  rows: readonly T[];
  rowKey(row: T): string;
  children(row: T, index: number): ReactNode;
  label: string;
}) {
  return (
    <VirtualList
      items={rows}
      getKey={rowKey}
      renderItem={children}
      label={label}
      estimateSize={48}
      rowClassName="border-b border-border py-2"
    />
  );
}
function SourceLines({ state, text }: { state: StrategiesScreenState; text: string }) {
  const lines = text
    .replace(/\n$/, "")
    .split("\n")
    .map((text, index) => ({ text, line: index + 1 }));
  return (
    <Rows rows={lines} rowKey={(row) => String(row.line)} label={S.source}>
      {(row) => {
        const issues =
          state.current?.document === "_main" && state.current.path === "strategy.yaml"
            ? state.lineIssues.filter((issue) => issue.line === row.line)
            : [];
        return (
          <div className="flex gap-3 font-mono text-sm">
            <span className="select-none text-text-muted">
              <Amount value={D(String(row.line))} fractionDigits={0} />
            </span>
            <div className="min-w-0">
              <pre className="whitespace-pre-wrap break-words">{row.text || " "}</pre>
              {issues.map((issue) => (
                <p
                  key={`${issue.path}:${issue.line}:${issue.column}:${issue.code}`}
                  className={issue.severity === "error" ? "text-negative" : "text-warning"}
                >
                  {issue.text}
                </p>
              ))}
            </div>
          </div>
        );
      }}
    </Rows>
  );
}
export function StrategySettingsView({ state }: { state: StrategiesScreenState }) {
  if (state.privacy)
    return (
      <aside className={card}>
        <p>{S.privacy}</p>
      </aside>
    );
  const { data } = state;
  const status = data.status === "current" ? data.strategy : null;
  const names = {
    valid: S.valid,
    invalid: S.invalid,
    partial: S.partialState,
    missing: S.missingState,
  };
  return (
    <aside className={`${card} space-y-4`} aria-label={S.validation}>
      <h2 className="text-title">{S.main}</h2>
      {status ? (
        <>
          <p>{names[status.state]}</p>
          <p>
            {S.errors} <Amount value={D(String(status.errors))} fractionDigits={0} /> - {S.warnings}{" "}
            <Amount value={D(String(status.warnings))} fractionDigits={0} />
          </p>
          {status.changed && <p className="text-warning">{S.changed}</p>}
          {status.state === "missing" && <p>{S.missing}</p>}
          {status.read_error && <p role="alert">{S.readFailed}</p>}
          {status.version !== null && (
            <p>
              {S.version} <Amount value={D(String(status.version))} fractionDigits={0} />{" "}
              {data.versions[0] && <DateText value={data.versions[0].createdAt.slice(0, 10)} />}
            </p>
          )}
          {status.facts && (
            <dl className="space-y-2">
              <dt>{S.buckets}</dt>
              <dd>
                <Amount value={D(String(status.facts.buckets.length))} fractionDigits={0} />
              </dd>
              <dt>{S.rules}</dt>
              <dd>
                <Amount value={D(String(status.facts.rules.length))} fractionDigits={0} />
              </dd>
              {status.facts.horizon_years !== null && (
                <>
                  <dt>{S.horizon}</dt>
                  <dd>
                    <Amount value={D(String(status.facts.horizon_years))} />
                  </dd>
                </>
              )}
              {status.facts.contributions && (
                <>
                  <dt>{S.contribution}</dt>
                  <dd>
                    <Money
                      value={
                        new MoneyValue(
                          status.facts.contributions.monthly_amount,
                          status.facts.base_currency,
                        )
                      }
                    />
                  </dd>
                </>
              )}
            </dl>
          )}
          {status.base_currency_note && <p>{status.base_currency_note}</p>}
          <h3>{S.validation}</h3>
          <Rows
            rows={state.issues}
            rowKey={(i) => `${i.path}:${i.line}:${i.code}:${i.message}`}
            label={S.validation}
          >
            {(issue) => (
              <p className={issue.severity === "error" ? "text-negative" : "text-warning"}>
                {issue.text}
              </p>
            )}
          </Rows>
          {state.inactiveRules.length > 0 && (
            <>
              <h3>{S.inactive}</h3>
              <Rows rows={state.inactiveRules} rowKey={(r) => String(r.index)} label={S.inactive}>
                {(rule) => (
                  <div>
                    <strong>
                      {rule.ruleId ?? rule.kind ?? (
                        <Amount value={D(String(rule.index))} fractionDigits={0} />
                      )}
                    </strong>
                    {rule.issues.map((issue) => (
                      <p key={`${issue.path}:${issue.line}:${issue.column}:${issue.code}`}>
                        {issue.text}
                      </p>
                    ))}
                  </div>
                )}
              </Rows>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              disabled={state.busy || !data.canReload}
              onClick={() => {
                void state.act("reload");
              }}
            >
              {S.reload}
            </button>
            {status.state === "missing" && (
              <button
                type="button"
                className={button}
                disabled={state.busy || !data.canInit}
                onClick={() => {
                  void state.act("init");
                }}
              >
                {S.init}
              </button>
            )}
          </div>
          {status.state === "missing" && !data.canInit && (
            <p className="text-text-muted">{S.actionUnavailable}</p>
          )}
          {data.paths && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={button}
                onClick={() => {
                  void state.copy(data.paths?.yaml ?? "");
                }}
              >
                {S.copyPath}
              </button>
              <button
                type="button"
                className={button}
                disabled={!status.files.md_exists}
                onClick={() => {
                  void state.copy(data.paths?.md ?? "");
                }}
              >
                MD
              </button>
            </div>
          )}
        </>
      ) : (
        <p>{S.unavailable}</p>
      )}
      <button
        type="button"
        className={button}
        onClick={() => {
          void state.copy("/investments-setup");
        }}
      >
        {S.copyCommand}
      </button>
      <h3>
        {S.pending} <Amount value={D(String(data.proposals.length))} fractionDigits={0} />
      </h3>
      <Rows rows={data.proposals} rowKey={(p) => p.gid} label={S.pending}>
        {(proposal) => (
          <div>
            <p>{proposal.summary}</p>
            <button
              type="button"
              className={button}
              disabled={!state.onProposalOpened}
              onClick={() => state.onProposalOpened?.(proposal.gid)}
            >
              {S.open}
            </button>
          </div>
        )}
      </Rows>
      {data.proposals.length > 0 && !state.onProposalOpened && <p>{S.proposalUnavailable}</p>}
      <button
        type="button"
        className={button}
        aria-expanded={state.history}
        onClick={() => state.setHistory(!state.history)}
      >
        {S.history} <Amount value={D(String(data.versions.length))} fractionDigits={0} />
      </button>
      {state.history && (
        <Rows rows={data.versions} rowKey={(v) => String(v.version)} label={S.history}>
          {(version) => (
            <p>
              {S.version} <Amount value={D(String(version.version))} fractionDigits={0} /> -{" "}
              {names[version.state as keyof typeof names]}{" "}
              <DateText value={version.createdAt.slice(0, 10)} /> - {S.issues}{" "}
              <Amount value={D(String(version.issues))} fractionDigits={0} />
            </p>
          )}
        </Rows>
      )}
    </aside>
  );
}
/** Read-only document workbench. All private prose is suppressed before any document child renders. */
export function StrategiesView({ state }: { state: StrategiesScreenState }) {
  if (state.privacy)
    return (
      <section className="p-6">
        <h1 className="text-headline">{S.title}</h1>
        <p>{S.privacy}</p>
      </section>
    );
  const { data } = state;
  const file = data.status === "current" ? data.selected : null;
  const current = state.current;
  const kind = state.doc?.files.find((f) => f.path === current?.path)?.kind;
  return (
    <main className="space-y-4 p-6" data-testid="native-strategies">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-headline">{S.title}</h1>
        <button
          type="button"
          className={button}
          disabled={state.busy}
          onClick={() => {
            void state.act("refresh");
          }}
        >
          {S.refresh}
        </button>
      </header>
      {state.notice && <p role="status">{state.notice}</p>}
      <div className="grid gap-4 lg:grid-cols-3">
        <nav className={card} aria-label={S.files}>
          <Rows rows={state.tree} rowKey={(r) => r.key} label={S.files}>
            {(row) => (
              <div className={["pl-0", "pl-3", "pl-6", "pl-9"][Math.min(row.depth, 3)]}>
                {row.kind === "dir" ? (
                  <p className="text-text-muted">{row.title}</p>
                ) : (
                  <button
                    type="button"
                    className={`${button} w-full text-left ${row.document === current?.document && row.path === current.path ? "bg-accent-muted text-accent" : ""}`}
                    aria-current={
                      row.document === current?.document && row.path === current.path
                        ? "page"
                        : undefined
                    }
                    disabled={row.path === null}
                    onClick={() => {
                      if (row.path) state.pick({ document: row.document, path: row.path });
                    }}
                  >
                    {row.title}
                  </button>
                )}
                {row.main ? (
                  <span>{S.executed}</span>
                ) : (
                  row.kind === "doc" && <span>{S.document}</span>
                )}
                {row.status && <p>{row.status}</p>}
                {row.description && <p>{row.description}</p>}
              </div>
            )}
          </Rows>
          {data.status === "current" && data.paths && (
            <button
              type="button"
              className={button}
              onClick={() => {
                void state.copy(data.paths?.folder ?? "");
              }}
            >
              {S.copyFolder}
            </button>
          )}
        </nav>
        <section className={`${card} min-w-0 space-y-4`} aria-label={S.preview}>
          {data.status !== "current" ? (
            <p>{S.unavailable}</p>
          ) : !current ? (
            <p>{S.noFiles}</p>
          ) : (
            <>
              <h2 className="break-words text-title">{current.path}</h2>
              {file?.status === "ready" && file.absolutePath && (
                <button
                  type="button"
                  className={button}
                  onClick={() => {
                    void state.copy(file.absolutePath ?? "");
                  }}
                >
                  {S.copyPath}
                </button>
              )}
              {kind === "yaml" && !state.doc?.executed && <p>{S.notExecuted}</p>}
              {kind === "md" && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={`${button} ${state.mode === "preview" ? "bg-accent-muted text-accent" : ""}`}
                    aria-pressed={state.mode === "preview"}
                    onClick={() => state.setMode("preview")}
                  >
                    {S.preview}
                  </button>
                  <button
                    type="button"
                    className={`${button} ${state.mode === "source" ? "bg-accent-muted text-accent" : ""}`}
                    aria-pressed={state.mode === "source"}
                    onClick={() => state.setMode("source")}
                  >
                    {S.source}
                  </button>
                </div>
              )}
              {file?.status === "ready" ? (
                file.text.trim() === "" ? (
                  <p>{S.empty}</p>
                ) : kind === "md" && state.mode === "preview" ? (
                  <MarkdownDocument text={file.text} />
                ) : (
                  <SourceLines
                    key={`${current.document}:${current.path}`}
                    state={state}
                    text={file.text}
                  />
                )
              ) : (
                <p>{S.readFailed}</p>
              )}
            </>
          )}
        </section>
        <StrategySettingsView state={state} />
      </div>
    </main>
  );
}
