// Investments research services over this vault's store (S21b; Python `research/{service,views,
// segment_service,topic_theses}.py`): queries and views (runs, notes, unread marks, summary, review
// digest block, topic theses), commands emitting `researchRun.*`, `note.*`, `topicThesis.*` and the
// research `signal.*` events.
export * from "./candidates.js";
export * from "./commands.js";
export * from "./queries.js";
export {
  dayStart,
  eventInstant,
  instantEvent,
  iso,
  type ResearchNote,
  type ResearchRun,
  type TopicThesis,
  viewInstant,
} from "./rows.js";
export * from "./segments.js";
export { NO_SYNC, type SyncResult } from "./sync.js";
export * from "./topics.js";
export * from "./views.js";
