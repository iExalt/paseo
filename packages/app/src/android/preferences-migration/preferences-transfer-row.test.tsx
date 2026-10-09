/**
 * @vitest-environment jsdom
 */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  picker: vi.fn(),
  reconcile: vi.fn(),
  buildWrites: vi.fn(),
  apply: vi.fn(),
  fileSize: 20,
  fileText: vi.fn(),
  shared: vi.fn(),
  deleted: 0,
  deleteFailure: false,
}));

vi.mock("react-native", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  return {
    ActivityIndicator: () => ReactModule.createElement("span", { "data-testid": "busy" }),
    Pressable: ({
      children,
      onPress,
      disabled,
      testID,
      accessibilityRole,
      accessibilityState,
    }: {
      children: React.ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      testID?: string;
      accessibilityRole?: string;
      accessibilityState?: { checked?: boolean };
    }) =>
      ReactModule.createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          disabled,
          "data-testid": testID,
          role: accessibilityRole === "checkbox" ? "checkbox" : "button",
          "aria-checked": accessibilityState?.checked,
        },
        children,
      ),
    Text: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("span", null, children),
    View: ({ children, testID }: { children: React.ReactNode; testID?: string }) =>
      ReactModule.createElement("div", { "data-testid": testID }, children),
  };
});
vi.mock("expo-document-picker", () => ({ getDocumentAsync: harness.picker }));
vi.mock("expo-file-system", () => ({
  Paths: { cache: { uri: "file:///cache" } },
  File: class {
    uri: string;
    constructor(uri: string | { uri: string }, name?: string) {
      this.uri = typeof uri === "string" ? uri : `${uri.uri}/${name}`;
    }
    get size() {
      return harness.fileSize;
    }
    get exists() {
      return true;
    }
    write() {}
    delete() {
      harness.deleted += 1;
      if (harness.deleteFailure) throw new Error("cache cleanup failed");
    }
    async text() {
      harness.fileText();
      return "{}";
    }
  },
}));
vi.mock("expo-sharing", () => ({ isAvailableAsync: async () => true, shareAsync: harness.shared }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  useUnistyles: () => ({
    theme: {
      spacing: { 1: 4, 2: 8, 3: 12 },
      fontSize: { xs: 11, sm: 13 },
      fontWeight: { medium: "500" },
      borderRadius: { md: 8 },
      colors: {
        foreground: "#fff",
        foregroundMuted: "#aaa",
        accent: "#0af",
        statusDanger: "#f00",
        statusWarning: "#fa0",
        border: "#555",
      },
    },
  }),
}));
vi.mock("./transfer", () => ({
  createPreferencesTransfer: vi.fn(),
  parseTransferForPreview: vi.fn(() => ({ sourceLabel: "source device" })),
  createPreferencesImportPreview: vi.fn(() => ({
    matchedDaemonIds: ["daemon-a"],
    unmatchedDaemonIds: ["daemon-missing"],
    personalPathCount: 1,
    availableSections: ["appearance", "defaults"],
  })),
  buildSelectedPreferencesImport: harness.buildWrites,
}));
vi.mock("./reconcile", () => ({ reconcileImportedPreferences: harness.reconcile }));
vi.mock("./journal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./journal")>();
  return { ...actual, applyPreferencesMigration: harness.apply };
});

import { PreferencesTransferRow } from "./preferences-transfer-row";

describe("preferences transfer row", () => {
  beforeEach(() => {
    harness.picker.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///transfer.json", size: 20 }],
    });
    harness.buildWrites.mockResolvedValue([{ key: "@paseo:app-settings", value: "{}" }]);
    harness.apply.mockImplementation(async ({ reconcile }: { reconcile: () => Promise<void> }) =>
      reconcile(),
    );
    harness.reconcile.mockResolvedValue(undefined);
    harness.fileSize = 20;
    harness.fileText.mockClear();
    harness.shared.mockResolvedValue(undefined);
    harness.deleted = 0;
    harness.deleteFailure = false;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("previews daemon matches, lets the user select sections, and requires explicit confirmation", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <PreferencesTransferRow mode="receiver" daemonIds={["daemon-a"]} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("preferences-import"));
    await screen.findByTestId("preferences-import-preview");
    expect(
      screen.getByText('settings.about.preferenceTransfer.daemonMatch {"matched":1,"skipped":1}'),
    ).toBeTruthy();
    expect(
      screen.getByText('settings.about.preferenceTransfer.personalPaths {"count":1}'),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("preferences-section-appearance"));
    fireEvent.click(screen.getByTestId("preferences-confirm-import"));
    await waitFor(() => expect(harness.buildWrites).toHaveBeenCalledOnce());
    expect(harness.buildWrites.mock.calls[0]?.[0].selected).toEqual(["defaults"]);
    expect(harness.apply).toHaveBeenCalledOnce();
    expect(harness.reconcile).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByTestId("preferences-import-preview")).toBeNull());
  });

  it("warns before bridge export and keeps the bridge export-only", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <PreferencesTransferRow mode="bridge" daemonIds={["daemon-a"]} />
      </QueryClientProvider>,
    );

    expect(screen.getByText("settings.about.preferenceTransfer.exportDisclosure")).toBeTruthy();
    expect(screen.queryByTestId("preferences-import")).toBeNull();
    fireEvent.click(screen.getByTestId("preferences-export"));
    await waitFor(() => expect(harness.shared).toHaveBeenCalledOnce());
    expect(harness.deleted).toBe(1);
  });

  it("shows a cache cleanup failure without leaving export busy", async () => {
    harness.deleteFailure = true;
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <PreferencesTransferRow mode="bridge" daemonIds={[]} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("preferences-export"));
    await screen.findByText("cache cleanup failed");
    expect((screen.getByTestId("preferences-export") as HTMLButtonElement).disabled).toBe(false);
  });

  it("rejects an import whose copied file size is unknown before reading its contents", async () => {
    harness.fileSize = undefined as unknown as number;
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <PreferencesTransferRow mode="receiver" daemonIds={[]} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("preferences-import"));
    await screen.findByText("settings.about.preferenceTransfer.tooLarge");
    expect(harness.fileText).not.toHaveBeenCalled();
  });
});
