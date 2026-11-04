import { D, Money as MoneyValue } from "@cashu/domain";
import { Amount, Button, Card, DateText, Money, VirtualList } from "@cashu/ui";
import type { ReactNode } from "react";
import { MarkdownDocument } from "./MarkdownDocument.js";
import { S } from "./Strategies.strings.js";
import type { StrategiesScreenState } from "./useStrategiesScreen.js";

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
      <Card as="aside">
        <p>{S.privacy}</p>
      </Card>
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
    <Card as="aside" label={S.validation} className="space-y-4">
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
            <Button
              disabled={state.busy || !data.canReload}
              onPress={() => {
                void state.act("reload");
              }}
            >
              {S.reload}
            </Button>
            {status.state === "missing" && (
              <Button
                disabled={state.busy || !data.canInit}
                onPress={() => {
                  void state.act("init");
                }}
              >
                {S.init}
              </Button>
            )}
          </div>
          {status.state === "missing" && !data.canInit && (
            <p className="text-text-muted">{S.actionUnavailable}</p>
          )}
          {data.paths && (
            <div className="flex flex-wrap gap-2">
              <Button
                onPress={() => {
                  void state.copy(data.paths?.yaml ?? "");
                }}
              >
                {S.copyPath}
              </Button>
              <Button
                disabled={!status.files.md_exists}
                onPress={() => {
                  void state.copy(data.paths?.md ?? "");
                }}
              >
                MD
              </Button>
            </div>
          )}
        </>
      ) : (
        <p>{S.unavailable}</p>
      )}
      <Button
        onPress={() => {
          void state.copy("/investments-setup");
        }}
      >
        {S.copyCommand}
      </Button>
      <h3>
        {S.pending} <Amount value={D(String(data.proposals.length))} fractionDigits={0} />
      </h3>
      <Rows rows={data.proposals} rowKey={(p) => p.gid} label={S.pending}>
        {(proposal) => (
          <div>
            <p>{proposal.summary}</p>
            <Button
              disabled={!state.onProposalOpened}
              onPress={() => state.onProposalOpened?.(proposal.gid)}
            >
              {S.open}
            </Button>
          </div>
        )}
      </Rows>
      {data.proposals.length > 0 && !state.onProposalOpened && <p>{S.proposalUnavailable}</p>}
      <Button expanded={state.history} onPress={() => state.setHistory(!state.history)}>
        {S.history} <Amount value={D(String(data.versions.length))} fractionDigits={0} />
      </Button>
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
    </Card>
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
        <Button
          disabled={state.busy}
          onPress={() => {
            void state.act("refresh");
          }}
        >
          {S.refresh}
        </Button>
      </header>
      {state.notice && <p role="status">{state.notice}</p>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card as="nav" label={S.files}>
          <Rows rows={state.tree} rowKey={(r) => r.key} label={S.files}>
            {(row) => (
              <div className={["pl-0", "pl-3", "pl-6", "pl-9"][Math.min(row.depth, 3)]}>
                {row.kind === "dir" ? (
                  <p className="text-text-muted">{row.title}</p>
                ) : (
                  <Button
                    className={`w-full text-left ${row.document === current?.document && row.path === current.path ? "bg-accent-muted text-accent" : ""}`}
                    current={
                      row.document === current?.document && row.path === current.path
                        ? "page"
                        : undefined
                    }
                    disabled={row.path === null}
                    onPress={() => {
                      if (row.path) state.pick({ document: row.document, path: row.path });
                    }}
                  >
                    {row.title}
                  </Button>
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
            <Button
              onPress={() => {
                void state.copy(data.paths?.folder ?? "");
              }}
            >
              {S.copyFolder}
            </Button>
          )}
        </Card>
        <Card label={S.preview} className="min-w-0 space-y-4">
          {data.status !== "current" ? (
            <p>{S.unavailable}</p>
          ) : !current ? (
            <p>{S.noFiles}</p>
          ) : (
            <>
              <h2 className="break-words text-title">{current.path}</h2>
              {file?.status === "ready" && file.absolutePath && (
                <Button
                  onPress={() => {
                    void state.copy(file.absolutePath ?? "");
                  }}
                >
                  {S.copyPath}
                </Button>
              )}
              {kind === "yaml" && !state.doc?.executed && <p>{S.notExecuted}</p>}
              {kind === "md" && (
                <div className="flex gap-2">
                  <Button
                    className={`${state.mode === "preview" ? "bg-accent-muted text-accent" : ""}`}
                    pressed={state.mode === "preview"}
                    onPress={() => state.setMode("preview")}
                  >
                    {S.preview}
                  </Button>
                  <Button
                    className={`${state.mode === "source" ? "bg-accent-muted text-accent" : ""}`}
                    pressed={state.mode === "source"}
                    onPress={() => state.setMode("source")}
                  >
                    {S.source}
                  </Button>
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
        </Card>
        <StrategySettingsView state={state} />
      </div>
    </main>
  );
}
