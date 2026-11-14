// Deep links and the navigation hold: a free app opens a warm link as it is, a held app keeps it and
// opens nothing, a cold start keeps any link and opens the start, the start itself and the development
// client's launch URL pass through, and the kept link is taken once.
import {
  linkPath,
  pendingLink,
  redirectSystemLink,
  subscribePendingLink,
  takePendingLink,
} from "./heldLinks";
import { holdNavigation } from "./navigationHold";

const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  takePendingLink();
});
const lock = () => releases.push(holdNavigation("lock"));

describe("linkPath", () => {
  it.each([
    ["cashu:///sheet/profile", "/sheet/profile"],
    ["cashu://sheet/profile", "/sheet/profile"],
    ["cashu://modal/triage?from=x", "/modal/triage?from=x"],
    ["/sheet/payment/g1", "/sheet/payment/g1"],
    ["cashu:///", "/"],
  ])("%s -> %s", (url, path) => {
    expect(linkPath(url)).toBe(path);
  });
});

describe("redirectSystemLink", () => {
  it("opens a warm link as it is while navigation is free", () => {
    expect(redirectSystemLink({ path: "cashu:///sheet/profile", initial: false })).toBe(
      "cashu:///sheet/profile",
    );
    expect(pendingLink()).toBeNull();
  });

  it("keeps a warm link while held and opens nothing", () => {
    lock();
    expect(redirectSystemLink({ path: "cashu:///sheet/profile", initial: false })).toBeNull();
    expect(pendingLink()).toBe("/sheet/profile");
  });

  it("keeps a cold start's link and opens the start, held or not", () => {
    expect(redirectSystemLink({ path: "cashu:///modal/triage", initial: true })).toBe("/");
    expect(pendingLink()).toBe("/modal/triage");
  });

  it("lets the start and the development client's launch pass", () => {
    lock();
    expect(redirectSystemLink({ path: "cashu:///", initial: true })).toBe("cashu:///");
    const devClient = "exp+cashu-mobile://expo-development-client/?url=http%3A%2F%2Fx";
    expect(redirectSystemLink({ path: devClient, initial: true })).toBe(devClient);
    expect(pendingLink()).toBeNull();
  });

  it("replays only the latest kept link, once", () => {
    lock();
    const heard: (string | null)[] = [];
    const unsubscribe = subscribePendingLink(() => heard.push(pendingLink()));
    redirectSystemLink({ path: "cashu:///sheet/profile", initial: false });
    redirectSystemLink({ path: "cashu:///modal/triage", initial: false });
    expect(takePendingLink()).toBe("/modal/triage");
    expect(takePendingLink()).toBeNull();
    unsubscribe();
    expect(heard).toEqual(["/sheet/profile", "/modal/triage", null]);
  });
});
