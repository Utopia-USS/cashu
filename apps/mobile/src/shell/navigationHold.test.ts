// The navigation hold: held while any hold is taken, free after the last release, listeners hear both
// changes, and `whenNavigationFree` waits for the last release.
import {
  holdNavigation,
  isNavigationHeld,
  subscribeNavigationHold,
  whenNavigationFree,
} from "./navigationHold";

const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
});
const hold = () => {
  const release = holdNavigation("lock");
  releases.push(release);
  return release;
};

it("is free with no hold and held while one is taken", () => {
  expect(isNavigationHeld()).toBe(false);
  const release = hold();
  expect(isNavigationHeld()).toBe(true);
  release();
  expect(isNavigationHeld()).toBe(false);
});

it("stays held until every hold is released; a release twice does nothing", () => {
  const first = hold();
  const second = hold();
  first();
  first();
  expect(isNavigationHeld()).toBe(true);
  second();
  expect(isNavigationHeld()).toBe(false);
});

it("tells its listeners when navigation becomes held and free, not on a second hold", () => {
  const heard: boolean[] = [];
  const unsubscribe = subscribeNavigationHold(() => heard.push(isNavigationHeld()));
  const first = hold();
  const second = hold();
  second();
  first();
  unsubscribe();
  hold();
  expect(heard).toEqual([true, false]);
});

it("whenNavigationFree resolves at once when free and after the last release when held", async () => {
  await expect(whenNavigationFree()).resolves.toBeUndefined();
  const release = hold();
  let free = false;
  const waiting = whenNavigationFree().then(() => {
    free = true;
  });
  await Promise.resolve();
  expect(free).toBe(false);
  release();
  await waiting;
  expect(free).toBe(true);
});

it("a navigation attempt while held waits and runs only after the release", async () => {
  const navigated: string[] = [];
  const release = hold();
  const attempt = whenNavigationFree().then(() => navigated.push("/sheet/profile"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(navigated).toEqual([]);
  release();
  await attempt;
  expect(navigated).toEqual(["/sheet/profile"]);
});
