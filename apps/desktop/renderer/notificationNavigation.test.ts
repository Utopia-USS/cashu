import { expect, it } from "vitest";
import {
  notificationDestination,
  PendingNotificationNavigation,
} from "./notificationNavigation.js";

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const profiles = [
  { vault: A, slug: "same" },
  { vault: B, slug: "same" },
  { vault: C, slug: "third" },
];

it("routes a host-admitted target by exact open vault despite duplicate profile slugs", () => {
  expect(
    notificationDestination(
      { kind: "target", vaultId: B, target: "signal", signalId: "signal-synthetic" },
      profiles,
      [A, B, C],
    ),
  ).toEqual({
    kind: "target",
    vault: B,
    slug: "same",
    page: "signals",
    signalId: "signal-synthetic",
  });
  expect(
    notificationDestination({ kind: "target", vaultId: B, target: "reviewDigest" }, profiles, [
      A,
      B,
      C,
    ]),
  ).toMatchObject({ page: "review", vault: B });
  expect(
    notificationDestination({ kind: "target", vaultId: B, target: "generic" }, profiles, [A, B, C]),
  ).toMatchObject({ page: "overview", vault: B });
});

it("uses the live admitted inventory and current identity, including a newly opened vault", () => {
  const target = { kind: "target", vaultId: C, target: "signalsSummary" } as const;
  expect(notificationDestination(target, profiles, [A, B])).toEqual({ kind: "unavailable" });
  expect(notificationDestination(target, profiles, [A, B, C])).toMatchObject({
    kind: "target",
    vault: C,
    slug: "third",
    page: "signals",
  });
  expect(notificationDestination(target, profiles.slice(0, 2), [A, B, C])).toEqual({
    kind: "unavailable",
  });
  expect(
    notificationDestination(target, [...profiles, { vault: C, slug: "third" }], [A, B, C]),
  ).toEqual({
    kind: "unavailable",
  });
});

it("lets a later third-vault choice or manual route beat a delayed cross-vault click", () => {
  const pending = new PendingNotificationNavigation();
  pending.begin(`/same/overview?vault=${A}`, A);
  pending.observe(`/third/overview?vault=${C}`, C);
  expect(pending.consume()).toBe(false);
  pending.begin(`/same/overview?vault=${A}`, A);
  pending.observe(`/same/settings?vault=${A}`, A);
  expect(pending.consume()).toBe(false);
});

it("replaces an older pending response with the latest click", () => {
  const pending = new PendingNotificationNavigation();
  pending.begin(`/same/overview?vault=${A}`, A);
  pending.observe(`/third/overview?vault=${C}`, C);
  pending.begin(`/third/overview?vault=${C}`, C);
  expect(pending.consume()).toBe(true);
  expect(pending.consume()).toBe(false);
});
