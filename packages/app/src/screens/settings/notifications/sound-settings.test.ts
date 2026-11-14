import { describe, expect, it } from "vitest";
import { resolveSoundSettingsTarget } from "./sound-settings";

describe("resolveSoundSettingsTarget", () => {
  it("opens the push channel's settings on Android when the channel exists", () => {
    expect(
      resolveSoundSettingsTarget({
        platform: "android",
        packageName: "sh.paseo",
        channelExists: true,
      }),
    ).toEqual({
      kind: "channel",
      action: "android.settings.CHANNEL_NOTIFICATION_SETTINGS",
      extras: [
        { key: "android.provider.extra.APP_PACKAGE", value: "sh.paseo" },
        { key: "android.provider.extra.CHANNEL_ID", value: "default" },
      ],
    });
  });

  it.each([
    { platform: "android", packageName: "sh.paseo", channelExists: false },
    { platform: "android", packageName: null, channelExists: true },
    { platform: "ios", packageName: "sh.paseo", channelExists: true },
  ])("falls back to app settings for %o", (input) => {
    expect(resolveSoundSettingsTarget(input)).toEqual({ kind: "app-settings" });
  });
});
