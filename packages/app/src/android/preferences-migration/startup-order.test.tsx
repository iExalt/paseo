/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const migrationStorage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  rootImported: false,
}));
const journalKey = "@paseo:preferences-migration-journal:v1";

vi.mock("react-native", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  return {
    ActivityIndicator: () => ReactModule.createElement("span", null, "busy"),
    Pressable: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("button", { type: "button" }, children),
    StyleSheet: { create: (styles: unknown) => styles },
    Text: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("span", null, children),
    View: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
  };
});
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => migrationStorage.values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      migrationStorage.values.set(key, value);
    },
    removeItem: async (key: string) => {
      migrationStorage.values.delete(key);
    },
  },
}));
vi.mock("@/root-app", () => {
  if (migrationStorage.values.has(journalKey)) {
    throw new Error("Root module loaded before pending preference recovery finished.");
  }
  migrationStorage.rootImported = true;
  return { RootApp: () => null };
});

import { PreferencesMigrationStartup } from "./startup";

describe("migration startup import boundary", () => {
  beforeEach(() => {
    migrationStorage.values.clear();
    migrationStorage.rootImported = false;
    migrationStorage.values.set("@paseo:app-settings", '{"theme":"light"}');
    migrationStorage.values.set(
      journalKey,
      JSON.stringify({
        schemaVersion: 1,
        phase: "prepared",
        before: [{ key: "@paseo:app-settings", value: '{"theme":"dark"}' }],
        after: [{ key: "@paseo:app-settings", value: '{"theme":"light"}' }],
      }),
    );
  });

  afterEach(() => cleanup());

  it("runs actual journal recovery before importing the fork root module", async () => {
    render(React.createElement(PreferencesMigrationStartup));

    expect(migrationStorage.rootImported).toBe(false);
    await waitFor(() => expect(migrationStorage.rootImported).toBe(true));
    expect(migrationStorage.values.get("@paseo:app-settings")).toBe('{"theme":"dark"}');
    expect(migrationStorage.values.has(journalKey)).toBe(false);
  });
});
