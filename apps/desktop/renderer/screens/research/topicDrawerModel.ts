// The topic drawer (ab24ab6 v2/research/TopicDrawer.tsx TopicDetail, `topics/<key>` over the Home): a topic's
// Teza (edited in place, the agent's draft to confirm, its market view Ocena teraz / Perspektywa), its
// Instrumenty and Notatki; a macro key (`macro_risk`) shows the regime's state instead (no thesis, no members).
// Every string and list the pure TopicDrawerView renders.
import { C } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/investments/v2/research/TopicDrawer.strings";
import type { InstTileProps, MacroMetric, MacroTone } from "@cashu/ui";
import { dm } from "@cashu/ui-logic/investments/labels";
import { type InstLike, instMono } from "@cashu/ui-logic/investments/v2/logic";
import { isExpired, isRestorable } from "@cashu/ui-logic/investments/v2/research/logic";
import {
  explainText,
  isMacroKey,
  macroHeadline,
  macroKeyOf,
  macroLabel,
  sinceMonth,
} from "@cashu/ui-logic/investments/v2/research/macro";
import {
  canonKey,
  segmentDisplay,
  segmentLabel,
  thesisDraft,
  topicMembers,
  topicView,
} from "@cashu/ui-logic/investments/v2/research/segments";
import type {
  MacroRegimes,
  ResearchNote,
  SegmentAttribution,
  TopicThesis,
} from "@cashu/ui-logic/investments/v2/research/types";
import {
  type NoteRowModel,
  noteRowModel,
  richParts,
} from "../investments/asset/assetResearchModel.js";
import { macroStates } from "../investments/home/research/macroStripModel.js";

const THESIS_MAX = 600;
const INVALIDATION_MAX = 400;
const VIEW_MAX = 400;

/** The thesis form's fields while editing (old TopicThesisWidget `Edit`). */
export interface TopicEdit {
  thesis: string;
  invalidation: string;
  assessment: string;
  outlook: string;
}

/** The drawer's key: a macro note key as it is, a legacy segment key canonical. */
export const topicKeyOf = (topic: string): string =>
  isMacroKey(topic) ? topic : (canonKey(topic) ?? topic);

/** Crumb of the drawer: `Tematy › <topic>`, `Makro › <regime>` for a macro note key. */
const topicCrumb = (key: string): { section: string; name: string } =>
  isMacroKey(key)
    ? { section: S.macro, name: macroLabel(key) }
    : { section: S.topics, name: segmentLabel(key) };

interface Known {
  name: string;
  symbol: string | null;
  inst: InstLike;
}

export interface TopicDrawerInput {
  key: string;
  today: string;
  now: number;
  /** Every note the read holds (dismissed and expired included). */
  notes: readonly ResearchNote[];
  segments: SegmentAttribution | null;
  macro: MacroRegimes | null;
  thesis: TopicThesis | null;
  symOf(id: number): string | null;
  instOf(id: number): Known | null;
  /** The tile of a known instrument (plan coin, health ring). */
  tileOf(
    inst: InstLike,
  ): Pick<InstTileProps, "monogram" | "plan" | "strength" | "freshness" | "health" | "faded">;
  /** Topic key -> the watched (not held) symbols. */
  watchedTopics: Map<string, string[]>;
}

export interface TopicDrawerUi {
  edit: TopicEdit | null;
  busy: boolean;
  err: string | null;
  openNote: number | null;
  onToggleNote(id: number): void;
  onDismiss(n: ResearchNote): void;
  onRestore(n: ResearchNote): void;
  onOpenAsset(id: number): void;
}

type Parts = ReturnType<typeof richParts>;

export interface ThesisModel {
  draftTag: { text: string; title: string } | null;
  /** `Potwierdź` (an agent draft) and `Edytuj` / `Dodaj`; null while editing. */
  controls: { confirm: string | null; edit: string } | null;
  form: {
    fields: { key: keyof TopicEdit; label: string; rows: number; max: number; value: string }[];
    cancel: string;
    save: string;
  } | null;
  view:
    | {
        kind: "thesis";
        thesis: string;
        invalidation: { label: string; text: string } | null;
        market: {
          assessment: { label: string; parts: Parts } | null;
          outlook: { label: string; parts: Parts } | null;
          sources: { href: string | null; text: string; title: string }[];
          at: string | null;
        } | null;
      }
    | { kind: "empty"; text: string }
    | null;
  err: string | null;
  busy: boolean;
}

export interface RegimeModel {
  states: { text: string; tone: MacroTone }[];
  since: string | null;
  headline: string;
  why: string | null;
  supports: { label: string; items: readonly string[] } | null;
  risks: { label: string; items: readonly string[] } | null;
  explain: string | null;
  metrics: MacroMetric[];
  researchOn: string | null;
}

export interface TopicDrawerModel {
  key: string;
  /** Privacy mode: the hidden line in place of the thesis, the members and the notes. */
  hidden?: string | null;
  crumb: { section: string; name: string };
  left:
    | { kind: "regime"; regime: RegimeModel | null }
    | {
        kind: "topic";
        thesis: ThesisModel;
        members: {
          count: number | undefined;
          items: {
            symbol: string;
            name: string;
            tile: Pick<
              InstTileProps,
              "monogram" | "plan" | "strength" | "freshness" | "health" | "faded"
            >;
            sub: string | undefined;
            onOpen: (() => void) | undefined;
          }[];
        };
      };
  notes: {
    count: number | undefined;
    rows: (NoteRowModel & { onToggle(): void; onDismiss(): void; onRestore(): void })[];
  };
}

function thesisModel(t: TopicThesis | null, ui: TopicDrawerUi): ThesisModel {
  const e = ui.edit;
  const draft = thesisDraft(t);
  const view = topicView(t);
  const field = (key: keyof TopicEdit, label: string, rows: number, max: number) => ({
    key,
    label,
    rows,
    max,
    value: e?.[key] ?? "",
  });
  return {
    draftTag: draft && !e ? { text: S.toConfirm, title: S.agentDraft } : null,
    controls: e ? null : { confirm: draft ? S.confirm : null, edit: t ? C.edit : C.add },
    form: e
      ? {
          fields: [
            field("thesis", S.thesis, 4, THESIS_MAX),
            field("invalidation", S.invalidation, 2, INVALIDATION_MAX),
            ...(t || e.assessment || e.outlook
              ? [
                  field("assessment", S.assessmentNow, 3, VIEW_MAX),
                  field("outlook", S.outlook, 3, VIEW_MAX),
                ]
              : []),
          ],
          cancel: C.cancel,
          save: ui.busy ? S.saving : C.save,
        }
      : null,
    view: e
      ? null
      : t
        ? {
            kind: "thesis",
            thesis: t.thesis,
            invalidation: t.invalidation ? { label: S.invalidation, text: t.invalidation } : null,
            market: view
              ? {
                  assessment: view.assessment
                    ? { label: S.assessmentNow, parts: richParts(view.assessment) }
                    : null,
                  outlook: view.outlook
                    ? { label: S.outlook, parts: richParts(view.outlook) }
                    : null,
                  sources: view.sources.map((l) => ({
                    href: l.href,
                    text: l.text,
                    title: l.title,
                  })),
                  at: view.at ? dm(view.at) : null,
                }
              : null,
          }
        : { kind: "empty", text: S.noThesis },
    err: ui.err,
    busy: ui.busy,
  };
}

function regimeModel(key: string, macro: MacroRegimes | null): RegimeModel | null {
  const r = macro?.regimes.find((x) => x.key === macroKeyOf(key));
  if (!r) return null;
  const b = r.missing ? null : (r.brief ?? null);
  return {
    states: macroStates(r),
    since: sinceMonth(r),
    headline: macroHeadline(r),
    why: b?.why ?? null,
    supports: b?.supports.length ? { label: S.supports, items: b.supports } : null,
    risks: b?.risks.length ? { label: S.risks, items: b.risks } : null,
    explain: explainText(r),
    metrics: r.missing
      ? []
      : r.metrics.slice(0, 3).map((m) => ({ label: m.label, text: m.text, stale: !!m.stale })),
    researchOn: b?.observed_at ? S.researchOn(dm(b.observed_at)) : null,
  };
}

export function topicDrawerModel(p: TopicDrawerInput, ui: TopicDrawerUi): TopicDrawerModel {
  const key = p.key;
  const list = p.notes
    .filter((n) => n.segment === key && (!n.dismissed_at || isRestorable(n, p.now)))
    .sort((a, b) => b.observed_at.localeCompare(a.observed_at));
  const notes = {
    count: list.length || undefined,
    rows: list.map((n) => ({
      ...noteRowModel(n, {
        today: p.today,
        open: ui.openNote === n.id,
        highlight: false,
        restorable: isRestorable(n, p.now),
        dismissable: !isExpired(n, p.today),
      }),
      onToggle: () => ui.onToggleNote(n.id),
      onDismiss: () => ui.onDismiss(n),
      onRestore: () => ui.onRestore(n),
    })),
  };
  if (isMacroKey(key))
    return {
      key,
      crumb: topicCrumb(key),
      left: { kind: "regime", regime: regimeModel(key, p.macro) },
      notes,
    };
  const row = p.segments?.segments.find((s) => s.segment === key);
  const members = row
    ? topicMembers(segmentDisplay(row), p.symOf, p.watchedTopics)
    : (p.watchedTopics.get(key) ?? []).map((symbol) => ({ symbol, id: null, held: false }));
  return {
    key,
    crumb: topicCrumb(key),
    left: {
      kind: "topic",
      thesis: thesisModel(p.thesis, ui),
      members: {
        count: members.length || undefined,
        items: members.map((m) => {
          const known = m.id != null ? p.instOf(m.id) : null;
          const id = m.id;
          return {
            symbol: m.symbol,
            name: known?.name ?? m.symbol,
            tile: known
              ? p.tileOf(known.inst)
              : { monogram: instMono({ label: m.symbol, name: null, symbol: m.symbol }) },
            sub: m.held ? undefined : S.watched,
            onOpen: id != null ? () => ui.onOpenAsset(id) : undefined,
          };
        }),
      },
    },
    notes,
  };
}
