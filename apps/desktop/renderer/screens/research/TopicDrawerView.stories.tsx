import { TopicDrawerView } from "./TopicDrawerView.js";
import type { TopicDrawerModel } from "./topicDrawerModel.js";

const a = {
  onClose() {},
  onCrumb() {},
  onEdit() {},
  onCancel() {},
  onField() {},
  onSave() {},
  onConfirm() {},
};
const m: TopicDrawerModel = {
  key: "tech",
  crumb: { section: "Topics", name: "Technology" },
  left: {
    kind: "topic",
    thesis: {
      draftTag: null,
      controls: { confirm: null, edit: "Edit" },
      form: null,
      view: {
        kind: "thesis",
        thesis: "A synthetic topic thesis.",
        invalidation: null,
        market: null,
      },
      err: null,
      busy: false,
    },
    members: {
      count: 1,
      items: [
        {
          symbol: "SYN",
          name: "Synthetic Corp",
          tile: { monogram: "SYN" },
          sub: undefined,
          onOpen() {},
        },
      ],
    },
  },
  notes: { count: undefined, rows: [] },
};

export default {
  title: "Desktop/Research/TopicDrawer",
  component: TopicDrawerView,
  args: { m, a },
};
export const Topic = {};
export const Macro = {
  args: {
    m: {
      ...m,
      key: "macro_risk",
      crumb: { section: "Macro", name: "Risk appetite" },
      left: { kind: "regime", regime: null },
    } satisfies TopicDrawerModel,
    a,
  },
};
