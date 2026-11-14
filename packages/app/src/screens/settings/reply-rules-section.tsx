import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ReplyRule } from "@getpaseo/protocol/messages";
import { StyleSheet } from "react-native-unistyles";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Alert as InlineAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import {
  createReplyRulesEditorState,
  isReplyRulesDraftDirty,
  reduceReplyRulesEditorState,
  type ReplyRulesEditorState,
} from "./reply-rules-model";

const MAX_REPLY_RULES = 8;

function replyRulesFromEvent(event: unknown): ReplyRule[] | null {
  if (!event || typeof event !== "object" || !("type" in event) || event.type !== "status") {
    return null;
  }
  const payload = "payload" in event ? event.payload : null;
  if (
    !payload ||
    typeof payload !== "object" ||
    !("status" in payload) ||
    payload.status !== "daemon_config_changed" ||
    !("config" in payload)
  ) {
    return null;
  }
  const config = payload.config;
  if (!config || typeof config !== "object" || !("replyRules" in config)) return null;
  const rules = config.replyRules;
  if (
    !Array.isArray(rules) ||
    !rules.every(
      (rule): rule is ReplyRule =>
        typeof rule === "object" &&
        rule !== null &&
        "source" in rule &&
        typeof rule.source === "string" &&
        "flags" in rule &&
        typeof rule.flags === "string",
    )
  ) {
    return null;
  }
  return rules;
}

interface ReplyRulesSectionProps {
  serverId: string;
  hostLabel: string;
}

export function ReplyRulesSection({ serverId, hostLabel }: ReplyRulesSectionProps) {
  const { t } = useTranslation();
  const runtimeSnapshot = useHostRuntimeSnapshot(serverId);
  const isConnected = runtimeSnapshot?.connectionStatus === "online";
  const client = isConnected ? (runtimeSnapshot?.client ?? null) : null;
  const supportsRules = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.replyRuleFiltering === true,
  );

  if (!client || !runtimeSnapshot) {
    return (
      <UnavailableReplyRulesSection
        hostLabel={hostLabel}
        message={t("settings.host.orchestration.replyRules.disconnected")}
        testID="reply-rules-disconnected"
      />
    );
  }

  if (!supportsRules) {
    return (
      <UnavailableReplyRulesSection
        hostLabel={hostLabel}
        message={t("settings.host.orchestration.replyRules.unsupported")}
        testID="reply-rules-unsupported"
      />
    );
  }

  return (
    <ReplyRulesEditor
      key={`${serverId}:${runtimeSnapshot.clientGeneration}:${runtimeSnapshot.connectionEpoch}`}
      client={client}
      hostLabel={hostLabel}
    />
  );
}

function UnavailableReplyRulesSection({
  hostLabel,
  message,
  testID,
}: {
  hostLabel: string;
  message: string;
  testID: string;
}) {
  const { t } = useTranslation();
  return (
    <SettingsSection
      title={t("settings.host.orchestration.replyRules.title")}
      testID="reply-rules-section"
    >
      <View style={settingsStyles.card} testID={testID}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.orchestration.replyRules.scope", { host: hostLabel })}
            </Text>
            <Text style={settingsStyles.rowHint}>{message}</Text>
          </View>
        </View>
      </View>
    </SettingsSection>
  );
}

function ReplyRulesEditor({ client, hostLabel }: { client: DaemonClient; hostLabel: string }) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(
    reduceReplyRulesEditorState,
    undefined,
    createReplyRulesEditorState,
  );
  const [loadAttempt, setLoadAttempt] = useState(0);
  const mutationInFlightRef = useRef(false);
  const authorityGenerationRef = useRef(0);

  useEffect(() => {
    let active = true;
    const observation = client.observeEvents(["status.daemon_config_changed"]);
    observation.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (!active) return;
        const replyRules = replyRulesFromEvent(message);
        if (!replyRules) return;
        authorityGenerationRef.current++;
        dispatch({ type: "authoritative", rules: replyRules });
      },
    });

    const requestedAtAuthorityGeneration = authorityGenerationRef.current;
    void client
      .getDaemonNotificationRules()
      .then(({ replyRules }) => {
        if (active && authorityGenerationRef.current === requestedAtAuthorityGeneration) {
          dispatch({ type: "authoritative", rules: replyRules });
        }
        return null;
      })
      .catch((error: unknown) => {
        if (!active || authorityGenerationRef.current !== requestedAtAuthorityGeneration) return;
        dispatch({
          type: "fail-load",
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      active = false;
      mutationInFlightRef.current = false;
      void observation.release().catch((error) => {
        console.warn("[ReplyRulesSection] Failed to release config subscription", error);
      });
    };
  }, [client, loadAttempt]);

  const handleEditRule = useCallback(
    (index: number, update: Partial<ReplyRule>) => {
      const next = state.draftRules.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, ...update } : rule,
      );
      dispatch({ type: "edit", rules: next });
    },
    [state.draftRules],
  );

  const handleAddRule = useCallback(() => {
    dispatch({
      type: "edit",
      rules: [...state.draftRules, { source: "", flags: "" }],
    });
  }, [state.draftRules]);

  const handleRetryLoad = useCallback(() => {
    dispatch({ type: "fail-load", error: "" });
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const handleReloadConflict = useCallback(() => {
    dispatch({ type: "resolve-conflict", resolution: "reload" });
  }, []);

  const handleKeepConflict = useCallback(() => {
    dispatch({ type: "resolve-conflict", resolution: "keep" });
  }, []);

  const handleRemoveRule = useCallback(
    (index: number) => {
      dispatch({
        type: "edit",
        rules: state.draftRules.filter((_, ruleIndex) => ruleIndex !== index),
      });
    },
    [state.draftRules],
  );

  const handleMutate = useCallback(
    async (operation: "save" | "clear") => {
      if (mutationInFlightRef.current || state.savedRules === null) return;
      const candidate = operation === "save" ? state.draftRules : [];
      const nextState = reduceReplyRulesEditorState(state, {
        type: "begin-mutation",
        operation,
        rules: candidate,
      });
      if (nextState === state) return;

      mutationInFlightRef.current = true;
      dispatch({ type: "begin-mutation", operation, rules: candidate });
      try {
        await client.setDaemonNotificationRules(candidate);
        dispatch({ type: "acknowledge-mutation" });
      } catch (error) {
        dispatch({
          type: "fail-mutation",
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        mutationInFlightRef.current = false;
      }
    },
    [client, state],
  );

  const handleSave = useCallback(() => {
    void handleMutate("save");
  }, [handleMutate]);

  const handleClear = useCallback(() => {
    void handleMutate("clear");
  }, [handleMutate]);

  const hasLoaded = state.savedRules !== null;
  const isPending = state.pending !== null;
  const isAwaitingAuthority = state.awaitingAuthorityRules !== null;
  const isDirty = isReplyRulesDraftDirty(state);
  const editsDisabled = !hasLoaded || isPending || isAwaitingAuthority || state.conflict;

  return (
    <SettingsSection
      title={t("settings.host.orchestration.replyRules.title")}
      info={t("settings.host.orchestration.replyRules.help")}
      testID="reply-rules-section"
    >
      <View style={settingsStyles.card} testID="reply-rules-editor">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.orchestration.replyRules.scope", { host: hostLabel })}
            </Text>
          </View>
        </View>

        <ReplyRulesAlerts
          state={state}
          mutationPending={isPending}
          onRetryLoad={handleRetryLoad}
          onReload={handleReloadConflict}
          onKeep={handleKeepConflict}
        />

        {isAwaitingAuthority ? (
          <View style={settingsStyles.row} testID="reply-rules-awaiting-authority">
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.orchestration.replyRules.awaitingAuthority")}
            </Text>
          </View>
        ) : null}

        {!hasLoaded && !state.error ? (
          <View style={settingsStyles.row} testID="reply-rules-loading">
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.orchestration.replyRules.loading")}
            </Text>
          </View>
        ) : null}

        {hasLoaded && state.draftRules.length === 0 ? (
          <View style={settingsStyles.row} testID="reply-rules-empty">
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.orchestration.replyRules.empty")}
            </Text>
          </View>
        ) : null}

        <ReplyRuleRows
          rules={state.draftRules}
          revision={state.draftRevision}
          disabled={editsDisabled}
          onEditRule={handleEditRule}
          onRemoveRule={handleRemoveRule}
        />

        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.orchestration.replyRules.help")}
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            disabled={editsDisabled || state.draftRules.length >= MAX_REPLY_RULES}
            onPress={handleAddRule}
            testID="reply-rules-add"
          >
            {t("settings.host.orchestration.replyRules.add")}
          </Button>
        </View>

        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <Button
            variant="outline"
            size="sm"
            disabled={editsDisabled || !isDirty}
            loading={state.pending?.operation === "save"}
            onPress={handleSave}
            testID="reply-rules-save"
          >
            {state.pending?.operation === "save"
              ? t("settings.host.orchestration.replyRules.saving")
              : t("settings.host.orchestration.replyRules.save")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={editsDisabled || (state.savedRules?.length === 0 && !isDirty)}
            loading={state.pending?.operation === "clear"}
            onPress={handleClear}
            testID="reply-rules-clear"
          >
            {t("settings.host.orchestration.replyRules.clear")}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

function ReplyRulesAlerts({
  state,
  mutationPending,
  onRetryLoad,
  onReload,
  onKeep,
}: {
  state: ReplyRulesEditorState;
  mutationPending: boolean;
  onRetryLoad: () => void;
  onReload: () => void;
  onKeep: () => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      {state.errorOperation === "read" && state.error ? (
        <InlineAlert
          size="sm"
          variant="error"
          title={t("settings.host.orchestration.replyRules.readError", {
            error: state.error,
          })}
          testID="reply-rules-read-error"
        >
          <Button variant="outline" size="sm" onPress={onRetryLoad} testID="reply-rules-retry">
            {t("settings.host.orchestration.replyRules.retry")}
          </Button>
        </InlineAlert>
      ) : null}

      {state.errorOperation === "write" && state.error ? (
        <InlineAlert
          size="sm"
          variant="error"
          title={t("settings.host.orchestration.replyRules.writeError", {
            error: state.error,
          })}
          testID="reply-rules-write-error"
        />
      ) : null}

      {state.conflict ? (
        <InlineAlert
          size="sm"
          variant="warning"
          description={t("settings.host.orchestration.replyRules.conflict")}
          testID="reply-rules-conflict"
        >
          <Button
            variant="outline"
            size="sm"
            disabled={mutationPending}
            onPress={onReload}
            testID="reply-rules-reload-saved"
          >
            {t("settings.host.orchestration.replyRules.reload")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={mutationPending}
            onPress={onKeep}
            testID="reply-rules-keep-draft"
          >
            {t("settings.host.orchestration.replyRules.keep")}
          </Button>
        </InlineAlert>
      ) : null}
    </>
  );
}

function ReplyRuleRows({
  rules,
  revision,
  disabled,
  onEditRule,
  onRemoveRule,
}: {
  rules: readonly ReplyRule[];
  revision: number;
  disabled: boolean;
  onEditRule: (index: number, update: Partial<ReplyRule>) => void;
  onRemoveRule: (index: number) => void;
}) {
  const { t } = useTranslation();
  const nextRowId = useRef(0);
  const rowIds = useRef<{ revision: number; values: number[] }>({ revision, values: [] });
  if (rowIds.current.revision !== revision) {
    rowIds.current = { revision, values: [] };
  }
  while (rowIds.current.values.length < rules.length) {
    rowIds.current.values.push(nextRowId.current++);
  }
  const handleRemoveRule = useCallback(
    (index: number) => {
      rowIds.current.values.splice(index, 1);
      onRemoveRule(index);
    },
    [onRemoveRule],
  );

  return rules.map((rule, index) => {
    return (
      <ReplyRuleRow
        key={`${revision}:${rowIds.current.values[index]}`}
        index={index}
        rule={rule}
        revision={revision}
        disabled={disabled}
        sourceLabel={t("settings.host.orchestration.replyRules.source")}
        flagsLabel={t("settings.host.orchestration.replyRules.flags")}
        removeLabel={t("settings.host.orchestration.replyRules.remove")}
        onEditRule={onEditRule}
        onRemoveRule={handleRemoveRule}
      />
    );
  });
}

function ReplyRuleRow({
  index,
  rule,
  revision,
  disabled,
  sourceLabel,
  flagsLabel,
  removeLabel,
  onEditRule,
  onRemoveRule,
}: {
  index: number;
  rule: ReplyRule;
  revision: number;
  disabled: boolean;
  sourceLabel: string;
  flagsLabel: string;
  removeLabel: string;
  onEditRule: (index: number, update: Partial<ReplyRule>) => void;
  onRemoveRule: (index: number) => void;
}) {
  const handleSourceChange = useCallback(
    (source: string) => onEditRule(index, { source }),
    [index, onEditRule],
  );
  const handleFlagsChange = useCallback(
    (flags: string) => onEditRule(index, { flags }),
    [index, onEditRule],
  );
  const handleRemove = useCallback(() => onRemoveRule(index), [index, onRemoveRule]);

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]} testID={`reply-rule-${index}`}>
      <View style={styles.ruleFields}>
        <Field label={sourceLabel}>
          <FormTextInput
            multiline
            initialValue={rule.source}
            resetKey={`${revision}:${index}:source`}
            onChangeText={handleSourceChange}
            editable={!disabled}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={sourceLabel}
            testID={`reply-rule-source-${index}`}
            style={styles.sourceInput}
          />
        </Field>
        <Field label={flagsLabel}>
          <FormTextInput
            initialValue={rule.flags}
            resetKey={`${revision}:${index}:flags`}
            onChangeText={handleFlagsChange}
            editable={!disabled}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={flagsLabel}
            testID={`reply-rule-flags-${index}`}
          />
        </Field>
      </View>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onPress={handleRemove}
        testID={`reply-rule-remove-${index}`}
      >
        {removeLabel}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  ruleFields: {
    flex: 1,
    gap: theme.spacing[3],
  },
  sourceInput: {
    minHeight: 72,
    textAlignVertical: "top",
  },
}));
