import { expect, it, vi } from "vitest";
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("expo-notifications", () => ({}));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: {} }));
vi.mock("expo-task-manager", () => {
  throw new Error("F-Droid must never evaluate the absent TaskManager module");
});
import { prepareLifecycle, removeLifecycleHost } from "./background-lifecycle.native";
it("loads and retains legacy delivery when the F-Droid/older binary has no native lifecycle module", async () => {
  expect(await prepareLifecycle({} as never, "host")).toBeUndefined();
  await expect(removeLifecycleHost("host")).resolves.toBeUndefined();
});
