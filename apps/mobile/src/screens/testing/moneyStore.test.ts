// The money kit's services close like the app's: every store, the price cache and the device store
// are closed by `services.close()`, and a second close does nothing.
import { moneyStore } from "./moneyStore";

it("closes every database of the services once", () => {
  const fixture = moneyStore();
  const { services } = fixture;
  expect(services.storage).toEqual({ cipherVersion: null });
  services.close();
  expect(() => fixture.a.store.read("SELECT 1")).toThrow();
  expect(() => fixture.b.store.read("SELECT 1")).toThrow();
  expect(() => services.device.read("SELECT 1")).toThrow();
  expect(() => services.prices.version()).toThrow();
  expect(() => services.close()).not.toThrow();
  expect(() => fixture.close()).not.toThrow();
});
