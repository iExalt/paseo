import { useCallback, useEffect, type ComponentType } from "react";
import { CircleAlert, CircleArrowUp, LoaderCircle } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { handleNixUpdatePress } from "@/desktop/updates/nix-update-flow";
import {
  useNixUpdatePhase,
  useNixUpdateStore,
  type NixUpdateBusy,
  type NixUpdatePhase,
} from "@/desktop/updates/nix-updates";
import { forkUpdater, useForkUpdate } from "@/android/fork-updates/updater";

interface SidebarUpdateButtonProps {
  onPress: () => void;
  testID: string;
  label: string;
  icon: ComponentType<{ size: number; color: string }>;
  iconColor?: "accent" | "destructive";
}

interface SidebarUpdateControlProps {
  Button: ComponentType<SidebarUpdateButtonProps>;
}

export function SidebarUpdateButton({ Button }: SidebarUpdateControlProps) {
  const { t } = useTranslation();
  const phase = useNixUpdatePhase();
  const busy = useNixUpdateStore((state) => state.busy);
  const failed = useNixUpdateStore((state) => state.failed);
  const flowActive = useNixUpdateStore((state) => state.flowActive);
  const onPress = useCallback(() => {
    if (!busy && !flowActive) void handleNixUpdatePress();
  }, [busy, flowActive]);

  if (phase.kind !== "available" && phase.kind !== "ready" && phase.kind !== "restart" && !failed) {
    return null;
  }
  const version =
    phase.kind === "unknown" || phase.kind === "current" ? null : phase.release.version;
  const label = resolveUpdateButtonLabel({ t, phase: phase.kind, busy, failed, version });
  return (
    <Button
      onPress={onPress}
      testID="sidebar-update"
      label={label}
      icon={resolveUpdateButtonIcon(failed, busy)}
      iconColor={failed ? "destructive" : "accent"}
    />
  );
}

export function SidebarForkUpdateButton({ Button }: SidebarUpdateControlProps) {
  const { t } = useTranslation();
  const pending = useForkUpdate((view) => view.icon !== null);
  const busy = useForkUpdate((view) => view.icon?.busy ?? false);
  const message = useForkUpdate((view) => view.message);
  const version = useForkUpdate((view) => view.icon?.version ?? null);
  const onPress = useCallback(() => void forkUpdater.send({ type: "press", via: "icon" }), []);
  if (!pending) return null;
  const formattedVersion = formatVersionWithPrefix(version);
  return (
    <Button
      onPress={onPress}
      testID="sidebar-fork-update"
      label={
        busy
          ? t(message.key, message.params)
          : t("desktop.updates.nix.updateTooltip", { version: formattedVersion })
      }
      icon={busy ? SpinningLoaderIcon : CircleArrowUp}
      iconColor="accent"
    />
  );
}

function resolveUpdateButtonIcon(failed: boolean, busy: NixUpdateBusy | null) {
  if (failed) return CircleAlert;
  return busy ? SpinningLoaderIcon : CircleArrowUp;
}

function SpinningLoaderIcon({ size, color }: { size: number; color: string }) {
  const rotation = useSharedValue(0);
  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(360, { duration: 1000, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(rotation);
  }, [rotation]);
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  return (
    <Animated.View style={spin}>
      <LoaderCircle size={size} color={color} />
    </Animated.View>
  );
}

function resolveUpdateButtonLabel(input: {
  t: ReturnType<typeof useTranslation>["t"];
  phase: NixUpdatePhase["kind"];
  busy: NixUpdateBusy | null;
  failed: boolean;
  version: string | null;
}): string {
  const version = formatVersionWithPrefix(input.version);
  if (input.failed) return input.t("desktop.updates.nix.failedTooltip");
  if (input.busy === "downloading") return input.t("desktop.updates.nix.downloading", { version });
  if (input.busy === "applying") return input.t("desktop.updates.nix.applying", { version });
  if (input.busy === "restarting") return input.t("desktop.updates.nix.restarting");
  if (input.phase === "restart") return input.t("desktop.updates.nix.restartTooltip", { version });
  return input.t("desktop.updates.nix.updateTooltip", { version });
}
