import { PUSH_CHANNEL_ID } from "@/push-notifications/registration";

export type SoundSettingsTarget =
  | { kind: "channel"; action: string; extras: { key: string; value: string }[] }
  | { kind: "app-settings" };

/**
 * Where "Sound and alerts" leads. Android 8+ keeps sound per notification channel, so
 * open the push channel's page when it exists; otherwise, and on iOS, the app's
 * settings page.
 */
export function resolveSoundSettingsTarget(input: {
  platform: string;
  packageName: string | null;
  channelExists: boolean;
}): SoundSettingsTarget {
  if (input.platform !== "android" || !input.packageName || !input.channelExists) {
    return { kind: "app-settings" };
  }
  return {
    kind: "channel",
    action: "android.settings.CHANNEL_NOTIFICATION_SETTINGS",
    extras: [
      { key: "android.provider.extra.APP_PACKAGE", value: input.packageName },
      { key: "android.provider.extra.CHANNEL_ID", value: PUSH_CHANNEL_ID },
    ],
  };
}
