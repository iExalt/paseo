import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

// Android: `adb shell am start -n <package>/.MainActivity --es paseo.<key> <value>` extras, held
// by modules/paseo-agent-switches until taken.
interface PaseoAgentSwitchesModule {
  takePendingSwitches(): Record<string, string>;
  addListener(eventName: "onSwitches", handler: () => void): EventSubscription;
}

const nativeModule = requireOptionalNativeModule<PaseoAgentSwitchesModule>("PaseoAgentSwitches");

export function takeLaunchSwitches(): Record<string, string> {
  return nativeModule?.takePendingSwitches() ?? {};
}

export function addSwitchesListener(listener: (switches: Record<string, string>) => void): void {
  nativeModule?.addListener("onSwitches", () => listener(takeLaunchSwitches()));
}
