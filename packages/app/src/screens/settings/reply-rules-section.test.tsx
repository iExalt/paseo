/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplyRulesSection } from "./reply-rules-section";

interface TestRule {
  source: string;
  flags: string;
}

const mocks = vi.hoisted(() => ({
  snapshots: {} as Record<
    string,
    { client: unknown; connectionStatus: string; clientGeneration: number; connectionEpoch: number }
  >,
  features: {} as Record<string, boolean>,
  eventHandlers: new Map<object, Array<(message: unknown) => void>>(),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeSnapshot: (serverId: string) => mocks.snapshots[serverId] ?? null,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: Object.fromEntries(
        Object.entries(mocks.features).map(([serverId, replyRuleFiltering]) => [
          serverId,
          { serverInfo: { features: { replyRuleFiltering } } },
        ]),
      ),
    }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const strings: Record<string, string> = {
        "settings.host.orchestration.replyRules.help":
          "RE2 search matching. Up to 8 rules, 256 UTF-16 code units per pattern, and 16,384 per subject. Flags are unique i, m, or u.",
        "settings.host.orchestration.replyRules.scope": `Applies to every workspace on ${values?.host ?? ""}.`,
        "settings.host.orchestration.replyRules.readError": `Could not read saved rules: ${values?.error ?? ""}. This connection needs daemon.read.`,
        "settings.host.orchestration.replyRules.writeError": `Could not save rules: ${values?.error ?? ""}. This connection needs daemon.manage.`,
        "settings.host.orchestration.replyRules.awaitingAuthority":
          "Saved. Waiting for this host to confirm the updated rules...",
        "settings.host.orchestration.replyRules.conflict":
          "Reload saved rules to discard your draft, or keep it to intentionally overwrite the latest rules on your next save.",
      };
      return strings[key] ?? key;
    },
  }),
}));

vi.mock("react-native", () => ({
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? (factory as (t: unknown) => unknown)({
            spacing: { 1: 4, 3: 12, 4: 16, 6: 24 },
            colors: {
              foreground: "#fff",
              foregroundMuted: "#aaa",
              surface1: "#111",
              border: "#555",
              statusDanger: "#f00",
            },
            fontSize: { sm: 13, base: 15 },
            fontWeight: { normal: "400" },
            borderRadius: { lg: 8 },
          })
        : factory,
  },
}));

vi.mock("@/components/settings/headings/settings-section", () => ({
  SettingsSection: ({
    title,
    info,
    children,
    testID,
  }: {
    title: string;
    info?: React.ReactNode;
    children: React.ReactNode;
    testID?: string;
  }) =>
    React.createElement("section", { "data-testid": testID }, [
      React.createElement("h2", { key: "title" }, title),
      info ? React.createElement("p", { key: "info" }, info) : null,
      children,
    ]),
}));

vi.mock("@/components/ui/form-field", () => ({
  Field: ({ label, children }: { label: string; children: React.ReactNode }) =>
    React.createElement("label", null, [label, children]),
  FormTextInput: ({
    initialValue,
    resetKey,
    onChangeText,
    testID,
    multiline,
    editable,
    accessibilityLabel,
  }: {
    initialValue: string;
    resetKey: string | number;
    onChangeText: (value: string) => void;
    testID: string;
    multiline?: boolean;
    editable?: boolean;
    accessibilityLabel: string;
  }) => {
    const [value, setValue] = React.useState(initialValue);
    React.useEffect(() => setValue(initialValue), [initialValue, resetKey]);
    const props = {
      "aria-label": accessibilityLabel,
      "data-testid": testID,
      disabled: editable === false,
      value,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        setValue(event.target.value);
        onChangeText(event.target.value);
      },
    };
    return multiline ? React.createElement("textarea", props) : React.createElement("input", props);
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    loading,
    testID,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    loading?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "data-testid": testID,
        disabled: disabled || loading,
        onClick: onPress,
      },
      children,
    ),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({
    title,
    description,
    children,
    testID,
  }: {
    title?: string;
    description?: React.ReactNode;
    children?: React.ReactNode;
    testID?: string;
  }) =>
    React.createElement("div", { role: "alert", "data-testid": testID }, [
      title,
      description,
      children,
    ]),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeClient(
  initialRead: Promise<{ replyRules: TestRule[] }> | { replyRules: TestRule[] } = {
    replyRules: [],
  },
) {
  const client = {
    observeEvents: vi.fn(() => {
      const listeners = mocks.eventHandlers.get(client) ?? [];
      mocks.eventHandlers.set(client, listeners);
      return {
        subscribe: (listener: { update: (message: unknown) => void }) => {
          listeners.push(listener.update);
        },
        release: vi.fn(async () => undefined),
      };
    }),
    getDaemonNotificationRules: vi.fn(() => Promise.resolve(initialRead)),
    setDaemonNotificationRules: vi.fn(async (_rules: TestRule[]) => ({ replyRules: _rules })),
  };
  return client;
}

function connectClient(serverId: string, client: ReturnType<typeof makeClient>, epoch = 1) {
  mocks.snapshots[serverId] = {
    client,
    connectionStatus: "online",
    clientGeneration: 1,
    connectionEpoch: epoch,
  };
  mocks.features[serverId] = true;
}

function emitRules(client: object, rules: TestRule[]) {
  const message = {
    type: "status",
    payload: { status: "daemon_config_changed", config: { replyRules: rules } },
  };
  act(() => {
    for (const listener of mocks.eventHandlers.get(client) ?? []) listener(message);
  });
}

function renderSection(serverId = "reply-rules-host", hostLabel = "Work Mac") {
  return render(<ReplyRulesSection serverId={serverId} hostLabel={hostLabel} />);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.eventHandlers.clear();
  mocks.snapshots = {};
  mocks.features = {};
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("reply rules settings editor", () => {
  it("renders the daemon-wide scope and loads authoritative rules", async () => {
    const client = makeClient({ replyRules: [{ source: "^No news\\.$", flags: "i" }] });
    connectClient("reply-rules-host", client);
    renderSection();

    await waitFor(() =>
      expect(screen.getByTestId("reply-rule-source-0")).toHaveProperty("value", "^No news\\.$"),
    );
    expect(screen.getByText("Applies to every workspace on Work Mac.")).toBeTruthy();
    expect(screen.getAllByText(/256 UTF-16 code units per pattern/)).toHaveLength(2);
    expect(client.observeEvents).toHaveBeenCalledWith(["status.daemon_config_changed"]);
    expect(client.getDaemonNotificationRules).toHaveBeenCalledTimes(1);
  });

  it("keeps a pushed authoritative update ahead of a late initial get", async () => {
    const read = deferred<{ replyRules: TestRule[] }>();
    const client = makeClient(read.promise);
    connectClient("reply-rules-host", client);
    renderSection();

    emitRules(client, [{ source: "^new$", flags: "m" }]);
    await act(async () => {
      read.resolve({ replyRules: [{ source: "^old$", flags: "" }] });
      await Promise.resolve();
    });

    expect(screen.getByTestId("reply-rule-source-0")).toHaveProperty("value", "^new$");
    expect(screen.getByTestId("reply-rule-flags-0")).toHaveProperty("value", "m");
  });

  it("does not show a late initial-read error after an authoritative event", async () => {
    const read = deferred<{ replyRules: TestRule[] }>();
    const client = makeClient(read.promise);
    connectClient("reply-rules-host", client);
    renderSection();

    emitRules(client, [{ source: "^current$", flags: "u" }]);
    await act(async () => {
      read.reject(new Error("stale read failed"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("reply-rule-source-0")).toHaveProperty("value", "^current$");
    expect(screen.queryByTestId("reply-rules-read-error")).toBeNull();
  });

  it("requires a conflict choice and never writes an ACK over newer authority", async () => {
    const client = makeClient({ replyRules: [{ source: "^saved$", flags: "" }] });
    const mutation = deferred<{ replyRules: TestRule[] }>();
    client.setDaemonNotificationRules.mockReturnValueOnce(mutation.promise);
    connectClient("reply-rules-host", client);
    renderSection();
    await screen.findByTestId("reply-rule-source-0");

    const sourceInput = screen.getByTestId("reply-rule-source-0");
    sourceInput.focus();
    fireEvent.change(sourceInput, { target: { value: "^draft$" } });
    expect(document.activeElement).toBe(sourceInput);
    fireEvent.click(screen.getByTestId("reply-rules-save"));
    expect(client.setDaemonNotificationRules).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("reply-rule-source-0")).toHaveProperty("disabled", true);

    emitRules(client, [{ source: "^remote$", flags: "i" }]);
    expect((screen.getByTestId("reply-rules-reload-saved") as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => {
      mutation.resolve({ replyRules: [{ source: "^draft$", flags: "" }] });
      await Promise.resolve();
    });

    expect(screen.getByTestId("reply-rules-conflict")).toBeTruthy();
    expect(screen.getByTestId("reply-rule-source-0")).toHaveProperty("value", "^draft$");
    expect((screen.getByTestId("reply-rules-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("reply-rules-keep-draft"));
    expect((screen.getByTestId("reply-rules-save") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("reply-rule-source-0")).toHaveProperty("value", "^draft$");
  });

  it("retains the draft after a failed write and clears it only after authoritative clear", async () => {
    const client = makeClient({ replyRules: [{ source: "^saved$", flags: "" }] });
    client.setDaemonNotificationRules
      .mockRejectedValueOnce(new Error("invalid flags"))
      .mockResolvedValueOnce({ replyRules: [] });
    connectClient("reply-rules-host", client);
    renderSection();
    await screen.findByTestId("reply-rule-source-0");

    fireEvent.change(screen.getByTestId("reply-rule-source-0"), { target: { value: "^draft$" } });
    fireEvent.click(screen.getByTestId("reply-rules-save"));
    await screen.findByTestId("reply-rules-write-error");
    expect(screen.getByTestId("reply-rule-source-0")).toHaveProperty("value", "^draft$");
    expect(screen.getByTestId("reply-rules-write-error").textContent).toContain("daemon.manage");

    fireEvent.click(screen.getByTestId("reply-rules-clear"));
    await waitFor(() => expect(client.setDaemonNotificationRules).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("reply-rules-awaiting-authority")).toBeTruthy();
    expect(screen.getByTestId("reply-rule-source-0")).toHaveProperty("value", "^draft$");
    emitRules(client, []);
    await waitFor(() => expect(screen.getByTestId("reply-rules-empty")).toBeTruthy());
    expect(screen.queryByTestId("reply-rule-source-0")).toBeNull();
  });

  it("gates unsupported hosts and discards old epoch reads when reconnecting", async () => {
    const unsupportedClient = makeClient();
    connectClient("unsupported-host", unsupportedClient);
    mocks.features["unsupported-host"] = false;
    const unsupported = renderSection("unsupported-host", "Old daemon");
    expect(screen.getByTestId("reply-rules-unsupported")).toBeTruthy();
    expect(unsupportedClient.getDaemonNotificationRules).not.toHaveBeenCalled();
    unsupported.unmount();

    const oldRead = deferred<{ replyRules: TestRule[] }>();
    const newRead = deferred<{ replyRules: TestRule[] }>();
    const client = makeClient(oldRead.promise);
    connectClient("reconnect-host", client, 1);
    const view = renderSection("reconnect-host", "Reconnect host");
    emitRules(client, [{ source: "^saved before disconnect$", flags: "" }]);
    fireEvent.change(screen.getByTestId("reply-rule-source-0"), {
      target: { value: "^unsaved draft$" },
    });

    mocks.snapshots["reconnect-host"] = {
      ...mocks.snapshots["reconnect-host"],
      connectionStatus: "disconnected",
    };
    view.rerender(<ReplyRulesSection serverId="reconnect-host" hostLabel="Reconnect host" />);
    expect(screen.getByTestId("reply-rules-disconnected")).toBeTruthy();
    expect(screen.queryByTestId("reply-rule-source-0")).toBeNull();

    client.getDaemonNotificationRules.mockReturnValueOnce(newRead.promise);
    mocks.snapshots["reconnect-host"] = {
      ...mocks.snapshots["reconnect-host"],
      connectionStatus: "online",
      connectionEpoch: 2,
    };
    view.rerender(<ReplyRulesSection serverId="reconnect-host" hostLabel="Reconnect host" />);
    await waitFor(() => expect(client.getDaemonNotificationRules).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("reply-rules-loading")).toBeTruthy();
    expect(screen.queryByDisplayValue("^unsaved draft$")).toBeNull();

    await act(async () => {
      newRead.resolve({ replyRules: [{ source: "^new epoch saved$", flags: "u" }] });
      await Promise.resolve();
    });
    expect(screen.getByTestId("reply-rule-source-0")).toHaveProperty("value", "^new epoch saved$");

    await act(async () => {
      oldRead.resolve({ replyRules: [{ source: "^stale host$", flags: "" }] });
      await Promise.resolve();
    });
    expect(screen.getByTestId("reply-rule-source-0")).toHaveProperty("value", "^new epoch saved$");
  });

  it("isolates the draft when switching selected hosts", async () => {
    const firstHost = makeClient({ replyRules: [{ source: "^first saved$", flags: "" }] });
    const secondHost = makeClient({ replyRules: [{ source: "^second saved$", flags: "m" }] });
    connectClient("first-host", firstHost);
    connectClient("second-host", secondHost);
    const view = renderSection("first-host", "First host");
    await screen.findByTestId("reply-rule-source-0");
    fireEvent.change(screen.getByTestId("reply-rule-source-0"), {
      target: { value: "^private first draft$" },
    });

    view.rerender(<ReplyRulesSection serverId="second-host" hostLabel="Second host" />);
    await waitFor(() =>
      expect(screen.getByTestId("reply-rule-source-0")).toHaveProperty("value", "^second saved$"),
    );
    expect(screen.getByText("Applies to every workspace on Second host.")).toBeTruthy();
    expect(screen.queryByDisplayValue("^private first draft$")).toBeNull();
  });
});
