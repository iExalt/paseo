import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { loadRootAfterPreferenceRecovery } from "./startup-order";

export function PreferencesMigrationStartup() {
  const [RootApp, setRootApp] = useState<React.ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retryRecovery = useCallback(() => {
    setError(null);
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { RootApp: App } = await loadRootAfterPreferenceRecovery({
          recover: async () => {
            const [{ default: AsyncStorage }, { recoverPreferencesMigration }] = await Promise.all([
              import("@react-native-async-storage/async-storage"),
              import("./journal"),
            ]);
            await recoverPreferencesMigration(AsyncStorage);
          },
          loadRoot: () => import("@/root-app"),
        });
        if (!cancelled) setRootApp(() => App);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (RootApp) return <RootApp />;
  if (error) {
    return (
      <View style={styles.errorContainer}>
        <Text>Preference transfer recovery could not finish.</Text>
        <Text>{error}</Text>
        <Pressable accessibilityRole="button" onPress={retryRecovery}>
          <Text>Retry recovery</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.loadingContainer}>
      <ActivityIndicator />
    </View>
  );
}

const styles = StyleSheet.create({
  errorContainer: { flex: 1, justifyContent: "center", padding: 24, gap: 12 },
  loadingContainer: { flex: 1, alignItems: "center", justifyContent: "center" },
});
