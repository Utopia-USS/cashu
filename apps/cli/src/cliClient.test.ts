// The caller facts `cli.exec` sends: the home folder the host expands `~` against, per platform.
import { userInfo } from "node:os";
import { expect, it } from "vitest";
import { callerHome } from "./cliClient.js";

it("sends HOME on macOS and Linux and USERPROFILE on Windows as the caller's home", () => {
  const env = { HOME: "/home/a", USERPROFILE: "C:\\Users\\a" };
  expect(callerHome(env, "darwin")).toBe("/home/a");
  expect(callerHome(env, "linux")).toBe("/home/a");
  expect(callerHome(env, "win32")).toBe("C:\\Users\\a");
  expect(callerHome({ USERPROFILE: "C:\\Users\\a" }, "darwin")).toBe(userInfo().homedir);
  expect(callerHome({ HOME: "/home/a" }, "win32")).toBe(userInfo().homedir);
});
