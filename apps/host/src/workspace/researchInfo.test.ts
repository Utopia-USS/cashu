import { expect, it } from "vitest";
import type { OpenVault } from "../stores.js";
import type { WorkspaceProvider, WorkspaceStatus } from "./index.js";
import { createResearchWorkspaceInfo } from "./researchInfo.js";

const A = "a".repeat(32);
const B = "b".repeat(32);
const ready = (exists: boolean): WorkspaceStatus => ({
  availability: "ready",
  path: "/synthetic/workspace",
  defaultPath: "/synthetic/workspace",
  configured: false,
  custom: false,
  exists,
  folderExists: exists,
  conflict: null,
  managedVersion: null,
  currentVersion: "synthetic",
  updatedAt: null,
  upToDate: exists,
  mcpCommandStale: false,
  outdated: [],
  skills: exists
    ? [{ name: "market-research", module: "investments", version: "one", state: "ok" }]
    : [],
  skillsSource: true,
  claudeCommand: "synthetic command",
  routineCommand: "synthetic routine",
  routinePermissions: true,
});

function fixture() {
  let slug = "synthetic";
  let current = true;
  let status = ready(false);
  const inspections: ((value: WorkspaceStatus) => void)[] = [];
  let inspectCount = 0;
  let fail = false;
  let delay = false;
  const listeners = new Set<(id: string) => void>();
  const vault = {
    id: A,
    mode: "native",
    store: {
      read(sql: string) {
        if (sql.includes("FROM profiles"))
          return [{ slug, baseCurrency: "PLN", privacy: "strict" }];
        if (sql.includes("FROM profile_modules")) return [{ module_id: "investments" }];
        return [];
      },
    },
  } as unknown as OpenVault;
  const vaults = new Map([[A, vault]]);
  const provider: WorkspaceProvider = {
    changes: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    bind(id) {
      if (id !== A) return null;
      return {
        generation: "synthetic-generation",
        isCurrent: () => current,
        inspect: async () => {
          inspectCount++;
          if (fail) throw new Error("synthetic inspection detail");
          return delay
            ? new Promise<WorkspaceStatus>((resolve) => inspections.push(resolve))
            : status;
        },
        apply: async () => ({ kind: "refused", code: "unused" }),
      };
    },
  };
  const source = createResearchWorkspaceInfo({
    provider,
    vaults,
    isCurrent: (candidate) => current && vaults.get(candidate.id) === candidate,
  });
  const read = ((sql: string) => (sql === "SELECT gid FROM profiles" ? [{ gid: A }] : [])) as never;
  return {
    source,
    read,
    vault,
    vaults,
    inspectionCount: () => inspectCount,
    failInspection() {
      fail = true;
    },
    setSlug(value: string) {
      slug = value;
    },
    setStatus(value: WorkspaceStatus) {
      status = value;
    },
    notify() {
      for (const listener of [...listeners]) listener(A);
    },
    delay() {
      delay = true;
    },
    release(value: WorkspaceStatus) {
      inspections.shift()?.(value);
    },
    revoke() {
      current = false;
    },
  };
}

it("publishes an inspected absent workspace, then refreshes after provider change", async () => {
  const f = fixture();
  let changes = 0;
  const stop = f.source.source.changes.subscribe(() => changes++);
  try {
    expect(f.source.source.current(f.read)).toMatchObject({ status: "unavailable" });
    await f.source.refresh(A);
    expect(f.source.source.current(f.read)).toMatchObject({
      status: "current",
      value: { value: { path: "/synthetic/workspace", exists: false, skillInstalled: false } },
    });
    f.setStatus(ready(true));
    f.notify();
    expect(f.source.source.current(f.read)).toMatchObject({ status: "unavailable" });
    await f.source.refresh(A);
    expect(f.source.source.current(f.read)).toMatchObject({
      status: "current",
      value: {
        value: {
          exists: true,
          skillInstalled: true,
          command: "synthetic command",
          routine: "synthetic routine",
        },
      },
    });
    expect(changes).toBeGreaterThan(1);
  } finally {
    stop();
    f.source.close();
  }
});

it("coalesces repeated reads and reruns once after in-flight invalidation", async () => {
  const f = fixture();
  try {
    f.delay();
    const work = f.source.refresh(A);
    for (let i = 0; i < 30; i++)
      expect(f.source.source.current(f.read)).toMatchObject({ status: "unavailable" });
    expect(f.inspectionCount()).toBe(1);
    f.notify();
    f.notify();
    f.release(ready(false));
    await new Promise(setImmediate);
    expect(f.inspectionCount()).toBe(2);
    for (let i = 0; i < 30; i++)
      expect(f.source.source.current(f.read)).toMatchObject({ status: "unavailable" });
    expect(f.inspectionCount()).toBe(2);
    f.release(ready(true));
    await work;
    expect(f.source.source.current(f.read)).toMatchObject({
      status: "current",
      value: { value: { exists: true } },
    });
    expect(f.inspectionCount()).toBe(2);
  } finally {
    f.source.close();
  }
});

it("reruns a stale initial inspection for a changed profile and vault", async () => {
  const f = fixture();
  try {
    f.delay();
    const pending = f.source.refresh(A);
    f.setSlug("replacement");
    f.release(ready(true));
    await new Promise(setImmediate);
    expect(f.inspectionCount()).toBe(2);
    f.release(ready(false));
    await pending;
    expect(f.source.source.current(f.read)).toMatchObject({
      status: "current",
      value: { value: { exists: false } },
    });
  } finally {
    f.source.close();
  }
  const replacement = fixture();
  try {
    replacement.delay();
    const pending = replacement.source.refresh(A);
    replacement.vaults.set(A, { ...replacement.vault });
    replacement.release(ready(true));
    await new Promise(setImmediate);
    expect(replacement.inspectionCount()).toBe(2);
    replacement.release(ready(false));
    await pending;
    expect(replacement.source.source.current(replacement.read)).toMatchObject({
      status: "current",
      value: { value: { exists: false } },
    });
  } finally {
    replacement.source.close();
  }
});

it("coalesces a profile switch during the first scheduled read", async () => {
  const f = fixture();
  try {
    f.delay();
    expect(f.source.source.current(f.read)).toMatchObject({ status: "unavailable" });
    await new Promise(setImmediate);
    expect(f.inspectionCount()).toBe(1);
    f.setSlug("replacement");
    for (let i = 0; i < 20; i++)
      expect(f.source.source.current(f.read)).toMatchObject({ status: "unavailable" });
    f.release(ready(true));
    await new Promise(setImmediate);
    expect(f.inspectionCount()).toBe(2);
    f.release(ready(false));
    await new Promise(setImmediate);
    expect(f.source.source.current(f.read)).toMatchObject({
      status: "current",
      value: { value: { exists: false } },
    });
    expect(f.inspectionCount()).toBe(2);
  } finally {
    f.source.close();
  }
});

it("never exposes an image after capability revocation or for another vault", async () => {
  const f = fixture();
  try {
    await f.source.refresh(A);
    const otherRead = ((sql: string) =>
      sql === "SELECT gid FROM profiles" ? [{ gid: B }] : []) as never;
    expect(f.source.source.current(otherRead)).toMatchObject({ status: "unavailable" });
    f.revoke();
    expect(f.source.source.current(f.read)).toMatchObject({ status: "unavailable" });
  } finally {
    f.source.close();
  }
});

it("reports a fixed unavailable code after inspection failure", async () => {
  const f = fixture();
  try {
    f.failInspection();
    await f.source.refresh(A);
    expect(f.source.source.current(f.read)).toEqual({
      status: "unavailable",
      reason: "workspace_inspect_failed",
    });
  } finally {
    f.source.close();
  }
});
