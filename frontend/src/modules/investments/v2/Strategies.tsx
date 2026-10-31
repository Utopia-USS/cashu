// The Strategie tab (docs/agents/strategies.md, stage 1): an IDE-shaped, read-only view of the profile's strategies.
// The file tree on the left (the executed main strategy first, then the documents in strategies/), the selected
// file in the middle (Markdown rendered, YAML / text as numbered source; the main strategy.yaml with its validation
// issues on their lines), and for the main strategy the status card of Settings on the right (validation,
// proposals, versions, reload). Editing stays with the agent: changes arrive as proposals the owner approves.
import { useMemo, useState } from "react";
import { Markdown } from "../../../components/Markdown";
import { useSlug } from "../../../core/context";
import { describeIssue, errorText } from "../../../core/messages";
import { useAsync } from "../../../hooks";
import { copyText, Empty, Seg, Skeleton, Tag, useToast } from "../../../ui";
import { getStrategies, getStrategy, getStrategyFile, postStrategyInit, postStrategyReload, type StrategyDoc, type StrategyIssue } from "../api";
import { strategyTag } from "../Header";
import { dropInv, invKey } from "./api";
import { InvestmentsStrategySettings } from "./StrategySettings";
import { absolutePath, issuesByLine, MAIN_ID, pickSelection, treeRows, type Selection } from "./strategiesLogic";
import { S } from "./Strategies.strings.ts";
import "./strategies.css";

const docTitle = (d: StrategyDoc) => d.title ?? (d.main ? S.mainTitle : d.id);

function DocTags({ doc }: { doc: StrategyDoc }) {
  if (doc.main) {
    return <>{strategyTag(doc.brief ?? null)}{doc.files.length > 0 && <Tag title={S.executedTitle}>{S.executed}</Tag>}</>;
  }
  return <>{doc.status && <Tag tone="info">{doc.status}</Tag>}<Tag title={S.documentTitle}>{S.document}</Tag></>;
}

function Tree({ list, sel, onSelect }: { list: StrategyDoc[]; sel: Selection | null; onSelect: (s: Selection) => void }) {
  return (
    <nav className="strat-tree" aria-label={S.listLabel}>
      {list.map((d) => (
        <div key={d.id} className="strat-group">
          <button className={`strat-doc ${sel?.id === d.id ? "on" : ""}`} onClick={() => onSelect({ id: d.id, path: d.main_file ?? d.files[0]?.path ?? null })}>
            <span className="strat-name">{docTitle(d)}</span>
            <span className="strat-tags"><DocTags doc={d} /></span>
            {d.description && <span className="strat-desc">{d.description}</span>}
          </button>
          {d.files.length === 0 ? <div className="strat-file muted" style={{ paddingLeft: 22 }}>{S.noFiles}</div> : treeRows(d).map((r) => (
            r.kind === "dir"
              ? <div key={r.key} className="strat-dir" style={{ paddingLeft: 22 + r.depth * 12 }}>{r.name}/</div>
              : <button key={r.key} className={`strat-file ${sel?.id === d.id && sel.path === r.path ? "on" : ""}`}
                  style={{ paddingLeft: 22 + r.depth * 12 }} onClick={() => onSelect({ id: d.id, path: r.path })}>
                  <span className={`strat-ext ${r.fileKind}`}>{r.fileKind === "md" ? "MD" : r.fileKind === "yaml" ? "YML" : "TXT"}</span>{r.name}
                </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

function Source({ text, issues }: { text: string; issues?: Map<number, StrategyIssue[]> }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <pre className="strat-src"><code>
      {lines.map((l, k) => {
        const here = issues?.get(k + 1);
        const error = here?.some((i) => i.severity === "error");
        return (
          <span key={k} className={`strat-line ${here ? (error ? "err" : "warn") : ""}`} title={here?.map((i) => describeIssue(i).text).join("\n")}>
            <span className="strat-ln">{k + 1}</span>{l || " "}
            {here && <span className="strat-issue">{here.map((i) => describeIssue(i).text).join("; ")}</span>}
          </span>
        );
      })}
    </code></pre>
  );
}

function FileView({ slug, doc, path }: { slug: string; doc: StrategyDoc; path: string }) {
  const toast = useToast();
  const kind = doc.files.find((f) => f.path === path)?.kind ?? "text";
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const file = useAsync(() => getStrategyFile(slug, doc.id, path), [slug, doc.id, path], { key: invKey(slug, "strategy-file", doc.id, path) });
  const mainYaml = doc.main && path === "strategy.yaml";
  const status = useAsync(() => (mainYaml ? getStrategy(slug) : Promise.resolve(null)), [slug, mainYaml],
    { key: mainYaml ? invKey(slug, "strategy") : undefined });
  const issues = useMemo(() => (status.data ? issuesByLine(status.data.issues) : undefined), [status.data]);
  const name = path.split("/").pop() ?? path;
  const text = file.data?.text ?? null;
  return (
    <section className="strat-main card">
      <header className="strat-head">
        <div className="strat-crumb"><strong>{docTitle(doc)}</strong><span className="muted"> / {path}</span></div>
        <span className="spacer" />
        {kind === "md" && <Seg quiet label={S.viewMode} items={[[S.preview, "preview"], [S.source, "source"]]} value={mode} onChange={setMode} />}
        <button className="btn" onClick={() => copyText(absolutePath(doc, path)).then(() => toast(S.pathCopied(name), 2000))}>{S.copyPath}</button>
      </header>
      {kind === "yaml" && !doc.executed && <div className="strat-note">{S.notExecuted}</div>}
      {mainYaml && issues && issues.size > 0 && <div className="strat-note warn">{S.issuesHere(status.data!.issues.filter((i) => i.line).length)}</div>}
      <div className="strat-body">
        {file.error ? <div className="muted">{S.loadFailed(file.error)}</div>
          : text == null ? <Skeleton h={120} />
          : text.trim() === "" ? <div className="muted">{S.emptyFile}</div>
          : kind === "md" && mode === "preview" ? <Markdown text={text} />
          : <Source text={text} issues={mainYaml ? issues : undefined} />}
      </div>
    </section>
  );
}

function NoStrategy({ slug, main, onDone }: { slug: string; main: boolean; onDone: () => void }) {
  const toast = useToast();
  return (
    <section className="strat-main card">
      <Empty title={main ? S.mainTitle : S.noneTitle} hint={main ? S.mainMissing : S.noneHint} action={<>
        <button className="btn primary" onClick={() => {
          void postStrategyInit(slug).then(() => postStrategyReload(slug).catch(() => null))
            .then(() => { toast(S.created, 3000); onDone(); })
            .catch((e: unknown) => toast(S.createFailed(errorText(e)), 4000));
        }}>{S.fromTemplate}</button>
        <button className="btn" onClick={() => copyText("/investments-setup").then(() => toast(S.commandCopied, 2000))}>{S.copyCommand}</button>
      </>} />
    </section>
  );
}

export function InvestmentsStrategies() {
  const slug = useSlug();
  const toast = useToast();
  const q = useAsync(() => getStrategies(slug), [slug], { key: invKey(slug, "strategies") });
  const list = q.data?.strategies ?? null;
  const [picked, setPicked] = useState<Selection | null>(null);
  const sel = list ? pickSelection(list, picked) : null;
  const doc = list?.find((d) => d.id === sel?.id) ?? null;
  const anyFiles = !!list?.some((d) => d.files.length > 0);
  const afterWrite = () => { dropInv(slug); q.reload(); };

  if (q.error && !list) return <div className="card muted" style={{ padding: 16 }}>{S.listFailed(q.error)}</div>;
  if (!list) return <div className="strat"><Skeleton h={320} /><Skeleton h={320} /></div>;
  return (
    <div className={`strat ${doc?.id === MAIN_ID && doc.files.length > 0 ? "with-side" : ""}`}>
      <aside className="strat-left card">
        <Tree list={list} sel={sel} onSelect={setPicked} />
        <div className="strat-folder muted">
          {S.folderHint}{" "}
          <button className="lnk" onClick={() => copyText(q.data!.folder).then(() => toast(S.pathCopied("strategies"), 2000))}>{S.copyFolder}</button>
        </div>
      </aside>
      {!anyFiles || !doc ? <NoStrategy slug={slug} main={false} onDone={afterWrite} />
        : doc.files.length === 0 || !sel?.path ? <NoStrategy slug={slug} main={doc.main} onDone={afterWrite} />
        : <FileView slug={slug} doc={doc} path={sel.path} />}
      {doc?.id === MAIN_ID && doc.files.length > 0 && <aside className="strat-side"><InvestmentsStrategySettings /></aside>}
    </div>
  );
}
