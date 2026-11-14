import { getDesktopHost } from "@/desktop/host";
import {
  loadAppSettingsFromStorage,
  persistAppSettings,
  type ServiceUrlBehavior,
} from "@/hooks/use-settings";
import { i18n } from "@/i18n/i18next";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openExternalUrl } from "@/utils/open-external-url";

type ServiceUrlChoice = Exclude<ServiceUrlBehavior, "ask">;

export interface OpenServiceUrlEnvironment {
  openExternal: (url: string) => Promise<void>;
  loadBehavior: () => Promise<ServiceUrlBehavior>;
  persistBehavior: (behavior: ServiceUrlChoice) => Promise<void>;
  /** Asks where to open `url`; `remember` is true when the user chose not to be asked again. */
  ask: (url: string) => Promise<{ choice: ServiceUrlChoice; remember: boolean }>;
}

export interface OpenServiceUrlOptions {
  /** Opens the URL in a browser tab. Supplied only where browser tabs exist. */
  openInApp?: (url: string) => void;
  environment?: OpenServiceUrlEnvironment;
}

export async function openServiceUrl(url: string, options?: OpenServiceUrlOptions): Promise<void> {
  const environment = options?.environment ?? defaultEnvironment;
  const openInApp = options?.openInApp;
  if (!openInApp) {
    await environment.openExternal(url);
    return;
  }

  const behavior = await resolveBehavior(url, environment);
  if (behavior === "in-app") {
    openInApp(url);
    return;
  }
  await environment.openExternal(url);
}

async function resolveBehavior(
  url: string,
  environment: OpenServiceUrlEnvironment,
): Promise<ServiceUrlChoice> {
  const behavior = await environment.loadBehavior();
  if (behavior !== "ask") {
    return behavior;
  }
  const answer = await environment.ask(url);
  if (answer.remember) {
    await environment.persistBehavior(answer.choice);
  }
  return answer.choice;
}

async function askWhereToOpen(
  url: string,
): Promise<{ choice: ServiceUrlChoice; remember: boolean }> {
  const labels = {
    title: i18n.t("serviceUrl.title"),
    okLabel: i18n.t("serviceUrl.inPaseo"),
    cancelLabel: i18n.t("serviceUrl.externalBrowser"),
  };
  const message = i18n.t("serviceUrl.message", { url });
  const askWithCheckbox = getDesktopHost()?.dialog?.askWithCheckbox;
  if (typeof askWithCheckbox === "function") {
    const result = await askWithCheckbox(message, {
      ...labels,
      checkboxLabel: i18n.t("serviceUrl.dontAskAgain"),
    });
    return { choice: result.confirmed ? "in-app" : "external", remember: result.dontAskAgain };
  }
  // Native has no checkbox dialog, so the answer applies to this link only.
  const confirmed = await confirmDialog({
    title: labels.title,
    message,
    confirmLabel: labels.okLabel,
    cancelLabel: labels.cancelLabel,
  });
  return { choice: confirmed ? "in-app" : "external", remember: false };
}

const defaultEnvironment: OpenServiceUrlEnvironment = {
  openExternal: openExternalUrl,
  loadBehavior: async () => (await loadAppSettingsFromStorage()).serviceUrlBehavior,
  persistBehavior: async (serviceUrlBehavior) => {
    await persistAppSettings({ serviceUrlBehavior });
  },
  ask: askWhereToOpen,
};
