import { requireOptionalNativeModule } from "expo-modules-core";
import { notifyBrowserDataCleared } from "./browser-data-cleared";

interface PaseoWebviewDataModule {
  clearData(): Promise<void>;
}

// Optional so Expo Go and builds without the module show an error instead of crashing.
const webviewData = requireOptionalNativeModule<PaseoWebviewDataModule>("PaseoWebviewData");

// The OS keeps one cookie jar and web storage for every web view in the app, so the
// hint says clearing reaches beyond browser tabs.
export const BROWSER_DATA_DESCRIPTION_KEY = "nativeBrowser.dataDescription";

export async function clearBrowserData(_browserIds: string[]): Promise<void> {
  if (!webviewData) {
    throw new Error("PaseoWebviewData native module is unavailable");
  }
  await webviewData.clearData();
  notifyBrowserDataCleared();
}
