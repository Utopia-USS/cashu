import { strategyDigest } from "@cashu/domain/investments/strategy";
import { type ProposalDetail, proposalDetail } from "@cashu/store/core/desktop-proposals";
import type { CurrentStrategyImage } from "@cashu/store/investments/screen-sources";
import { mergeProposalRule } from "@cashu/store/investments/services";
import type { ChangeSource } from "@cashu/store/query";
import { defineQuery } from "@cashu/store/query";
import { proposalUnifiedDiff } from "./proposalDiff.js";

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
const sourceTruthy = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
};

export function projectProposalDetail(
  detail: ProposalDetail,
  image: CurrentStrategyImage | null,
  privacy = false,
): ProposalDetail {
  const payload = detail.payload;
  const base = {
    diffAvailability: "unavailable" as const,
    yamlDiff: null,
    mdDiff: null,
    baseChanged: null,
    ruleYaml: str(payload.rule_yaml),
    backtest: record(payload.backtest),
    preview: record(payload.preview),
    account: str(payload.account),
    accountLabel: str(payload.account_label),
    connectorName: str(payload.connector_name),
    fileName: str(payload.file_name),
    since: str(payload.since),
    fromConnector: payload.source === "connector" || detail.source === "connector",
    converterUnsupported:
      payload.converter_unsupported === true ||
      str(payload.converter_script) !== null ||
      sourceTruthy(payload.converter),
    detailError: null,
  };
  if (privacy || (detail.kind !== "strategy" && detail.kind !== "custom_rule"))
    return { ...detail, display: base };
  if (!image || image.files.readError !== null)
    return { ...detail, display: { ...base, detailError: image?.files.readError ?? null } };
  const current = image.files;
  if (detail.kind === "strategy") {
    const yaml = str(payload.yaml);
    if (yaml === null)
      return { ...detail, display: { ...base, detailError: "proposal_yaml_missing" } };
    const yamlDiff = proposalUnifiedDiff(current.yaml, yaml, "strategy.yaml");
    const mdDiff =
      typeof payload.md === "string"
        ? proposalUnifiedDiff(current.md, payload.md, "strategy.md")
        : null;
    if (yamlDiff === null || (typeof payload.md === "string" && mdDiff === null))
      return { ...detail, display: { ...base, detailError: "diff_too_large" } };
    return {
      ...detail,
      display: {
        ...base,
        diffAvailability: "ready",
        yamlDiff,
        mdDiff,
        baseChanged: strategyDigest(current.yaml ?? "", current.md) !== str(payload.base_sha256),
      },
    };
  }
  const rule = record(payload.rule);
  if (current.yaml === null || rule === null)
    return { ...detail, display: { ...base, detailError: "strategy_or_rule_missing" } };
  try {
    const merged = mergeProposalRule(current.yaml, rule);
    const yamlDiff = proposalUnifiedDiff(current.yaml, merged, "strategy.yaml");
    if (yamlDiff === null)
      return { ...detail, display: { ...base, detailError: "diff_too_large" } };
    return {
      ...detail,
      display: {
        ...base,
        diffAvailability: "ready",
        yamlDiff,
      },
    };
  } catch {
    return { ...detail, display: { ...base, detailError: "rule_diff_unavailable" } };
  }
}

/** Same query id as the public descriptor; the private image never comes from renderer args. */
export function proposalDetailWithImages(source: {
  readonly changes: ChangeSource;
  image(vault: string): CurrentStrategyImage | null;
}) {
  return defineQuery({
    id: proposalDetail.id,
    changes: source.changes,
    run(read, args: { readonly gid: string; readonly privacy: boolean }) {
      const detail = proposalDetail.run(read, args);
      if (!detail) return null;
      const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
      const projected = projectProposalDetail(
        detail,
        vault ? source.image(vault) : null,
        args.privacy,
      );
      // An account removal names the account by gid; the drawer shows the account's own name.
      if (detail.kind !== "account_removal" || args.privacy || !projected.display) return projected;
      const account = str(detail.payload.account);
      const name = account
        ? read<{ name: string }>("SELECT name FROM accounts WHERE gid = ?", account)[0]?.name
        : undefined;
      return { ...projected, display: { ...projected.display, accountLabel: name ?? null } };
    },
  });
}
