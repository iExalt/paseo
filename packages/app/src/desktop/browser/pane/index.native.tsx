import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, BackHandler, Linking, Pressable, Text, View } from "react-native";
import { WebView, type WebViewNavigation, type WebViewProps } from "react-native-webview";
import { ArrowLeft, ArrowRight, RotateCw, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { normalizeWorkspaceBrowserUrl, useBrowserStore } from "@/desktop/browser/store";
import {
  buildBrowserNavigationPatch,
  deriveBrowserFaviconUrl,
} from "@/desktop/browser/store/state";
import { subscribeBrowserDataCleared } from "@/desktop/browser/settings/browser-data-cleared";
import {
  decideNativeBrowserNavigation,
  getUnsafeNavigationMessage,
  isAbortedNativeLoadError,
} from "../navigation-policy";

interface BrowserPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  isInteractive?: boolean;
  onFocusPane?: () => void;
  /** Opens a popup (target=_blank, user-initiated window.open) as a new browser tab. */
  onOpenUrlInNewTab?: (url: string) => void;
}

type ShouldStartLoadRequest = Parameters<
  NonNullable<WebViewProps["onShouldStartLoadWithRequest"]>
>[0];
type WebViewErrorEvent = Parameters<NonNullable<WebViewProps["onError"]>>[0];
type WebViewHttpErrorEvent = Parameters<NonNullable<WebViewProps["onHttpError"]>>[0];
type WebViewOpenWindowEvent = Parameters<NonNullable<WebViewProps["onOpenWindow"]>>[0];

// Every scheme must reach onShouldStartLoadWithRequest: react-native-webview hands
// URLs that fail the whitelist straight to Linking.openURL, bypassing the guard.
const ORIGIN_WHITELIST = ["*"];

const UrlInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));
const ArrowLeftIcon = withUnistyles(ArrowLeft, mutedIconColorMapping);
const ArrowRightIcon = withUnistyles(ArrowRight, mutedIconColorMapping);
const ReloadIcon = withUnistyles(RotateCw, mutedIconColorMapping);
const StopIcon = withUnistyles(X, mutedIconColorMapping);
const LoadingIndicator = withUnistyles(ActivityIndicator, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

function safeSourceUrl(url: string): string {
  return decideNativeBrowserNavigation({ url, isTopFrame: true }) === "allow" ? url : "about:blank";
}

const TOOLBAR_HIT_SLOP = { top: 6, bottom: 6, left: 4, right: 4 };

function ToolbarButton({
  label,
  disabled,
  onPress,
  children,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const accessibilityState = useMemo(() => ({ disabled: Boolean(disabled) }), [disabled]);
  const style = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.iconButton,
      pressed && styles.iconButtonPressed,
      disabled && styles.iconButtonDisabled,
    ],
    [disabled],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      disabled={disabled}
      hitSlop={TOOLBAR_HIT_SLOP}
      onPress={onPress}
      style={style}
    >
      {children}
    </Pressable>
  );
}

/**
 * Native browser tab on react-native-webview. The tab model (URL, title, history
 * flags, favicon, error) lives in the shared browser store; this pane only reports
 * into it. The page has no channel back into the app: no onMessage, no injected
 * scripts. Hidden tabs stay mounted through RetainedPanel and keep running.
 */
export function BrowserPane({
  browserId,
  isInteractive,
  onFocusPane,
  onOpenUrlInNewTab,
}: BrowserPaneProps) {
  const { t } = useTranslation();
  const browser = useBrowserStore((state) => state.browsersById[browserId] ?? null);
  const updateBrowser = useBrowserStore((state) => state.updateBrowser);
  const isPresented = useRetainedPanelActive();
  const webViewRef = useRef<WebView>(null);
  const urlInputRef = useRef<EditingTextInputHandle | null>(null);
  const browserRef = useRef(browser);
  browserRef.current = browser;
  const currentUrl = browser?.url ?? "https://example.com";
  const draftUrlRef = useRef(currentUrl);

  // The WebView loads `request.url` and follows its own navigation from there.
  // Only an address-bar submit or a crash recovery changes it, so ordinary
  // navigation never feeds back into `source` and reloads the page. `epoch` remounts
  // the WebView when its source can't express the request.
  const [request, setRequest] = useState(() => ({ url: safeSourceUrl(currentUrl), epoch: 0 }));
  const source = useMemo(() => ({ uri: request.url }), [request.url]);

  const errorLabels = useMemo(
    () => ({
      failedToLoad: t("workspace.browser.errors.failedToLoad"),
      invalidUrl: t("workspace.browser.errors.invalidUrl"),
      unsupportedProtocol: (protocol: string) =>
        t("workspace.browser.errors.unsupportedProtocol", { protocol }),
    }),
    [t],
  );

  useEffect(() => {
    if (urlInputRef.current?.isFocused()) {
      return;
    }
    draftUrlRef.current = currentUrl;
    urlInputRef.current?.replaceText(currentUrl);
  }, [currentUrl]);

  // Android does not ask onShouldStartLoadWithRequest about the source URL itself,
  // so a stored or plugin-supplied URL is vetted here, as the Electron pane does.
  useEffect(() => {
    const message = getUnsafeNavigationMessage(currentUrl, errorLabels);
    if (message) {
      updateBrowser(browserId, { isLoading: false, lastError: message });
    }
    // Only the URL the pane mounted with; later navigation goes through the guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDraftChange = useCallback((text: string) => {
    draftUrlRef.current = text;
  }, []);

  const navigate = useCallback(
    (rawUrl: string) => {
      const url = normalizeWorkspaceBrowserUrl(rawUrl);
      const decision = decideNativeBrowserNavigation({ url, isTopFrame: true });
      if (decision === "open-externally") {
        void Linking.openURL(url).catch(() => undefined);
        return;
      }
      if (decision === "block") {
        updateBrowser(browserId, {
          isLoading: false,
          lastError: getUnsafeNavigationMessage(url, errorLabels) ?? errorLabels.invalidUrl,
        });
        return;
      }
      const pageUrl = browserRef.current?.url;
      updateBrowser(browserId, {
        url,
        isLoading: true,
        lastError: null,
        ...(url !== pageUrl ? { faviconUrl: deriveBrowserFaviconUrl(url) } : {}),
      });
      if (url === pageUrl) {
        webViewRef.current?.reload();
        return;
      }
      setRequest((current) =>
        current.url === url
          ? // The page moved on from the last request, and an unchanged source would
            // be ignored; remount to load it again.
            { url, epoch: current.epoch + 1 }
          : { url, epoch: current.epoch },
      );
    },
    [browserId, errorLabels, updateBrowser],
  );

  const handleSubmit = useCallback(() => {
    urlInputRef.current?.blur();
    navigate(draftUrlRef.current);
  }, [navigate]);

  const remountAtCurrentUrl = useCallback(() => {
    const url = safeSourceUrl(browserRef.current?.url ?? currentUrl);
    setRequest((current) => ({ url, epoch: current.epoch + 1 }));
  }, [currentUrl]);

  useEffect(() => subscribeBrowserDataCleared(() => webViewRef.current?.reload()), []);

  // Android Back walks the page history first, but only for the visible, focused
  // tab, and never swallows Back on the first page.
  useEffect(() => {
    if (!isInteractive || !isPresented) {
      return;
    }
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!browserRef.current?.canGoBack) {
        return false;
      }
      webViewRef.current?.goBack();
      return true;
    });
    return () => subscription.remove();
  }, [isInteractive, isPresented]);

  const handleBack = useCallback(() => webViewRef.current?.goBack(), []);
  const handleForward = useCallback(() => webViewRef.current?.goForward(), []);
  const handleReloadOrStop = useCallback(() => {
    if (browserRef.current?.isLoading) {
      webViewRef.current?.stopLoading();
      updateBrowser(browserId, { isLoading: false });
      return;
    }
    webViewRef.current?.reload();
  }, [browserId, updateBrowser]);

  const handleNavigationStateChange = useCallback(
    (navigation: WebViewNavigation) => {
      updateBrowser(browserId, buildBrowserNavigationPatch(browserRef.current, navigation));
    },
    [browserId, updateBrowser],
  );

  const handleLoadStart = useCallback(() => {
    updateBrowser(browserId, { isLoading: true, lastError: null });
  }, [browserId, updateBrowser]);

  const handleLoadEnd = useCallback(() => {
    updateBrowser(browserId, { isLoading: false });
  }, [browserId, updateBrowser]);

  const handleError = useCallback(
    ({ nativeEvent }: WebViewErrorEvent) => {
      if (isAbortedNativeLoadError(nativeEvent)) {
        return;
      }
      const description = nativeEvent.description?.trim() || errorLabels.failedToLoad;
      updateBrowser(browserId, {
        isLoading: false,
        lastError: nativeEvent.url ? `${description}: ${nativeEvent.url}` : description,
      });
    },
    [browserId, errorLabels.failedToLoad, updateBrowser],
  );

  const handleHttpError = useCallback(
    ({ nativeEvent }: WebViewHttpErrorEvent) => {
      const description = nativeEvent.description?.trim();
      const status = description
        ? `${nativeEvent.statusCode} ${description}`
        : `${nativeEvent.statusCode}`;
      updateBrowser(browserId, {
        lastError: `${errorLabels.failedToLoad} (${status}): ${nativeEvent.url}`,
      });
    },
    [browserId, errorLabels.failedToLoad, updateBrowser],
  );

  const handleShouldStartLoad = useCallback(
    ({ url, isTopFrame }: ShouldStartLoadRequest) => {
      const decision = decideNativeBrowserNavigation({ url, isTopFrame });
      if (decision === "allow") {
        return true;
      }
      if (decision === "open-externally") {
        void Linking.openURL(url).catch(() => undefined);
      } else if (isTopFrame) {
        updateBrowser(browserId, {
          lastError: getUnsafeNavigationMessage(url, errorLabels) ?? errorLabels.invalidUrl,
        });
      }
      return false;
    },
    [browserId, errorLabels, updateBrowser],
  );

  // javaScriptCanOpenWindowsAutomatically stays off, so only user-initiated popups
  // get here. Each becomes a browser tab; the opener relationship is not kept.
  const handleOpenWindow = useCallback(
    ({ nativeEvent }: WebViewOpenWindowEvent) => {
      const url = nativeEvent.targetUrl;
      const decision = decideNativeBrowserNavigation({ url, isTopFrame: true });
      if (decision === "open-externally") {
        void Linking.openURL(url).catch(() => undefined);
        return;
      }
      if (decision === "allow" && url !== "about:blank") {
        onOpenUrlInNewTab?.(url);
      }
    },
    [onOpenUrlInNewTab],
  );

  // The error row above says what failed; this only replaces the library's default
  // error page, which would repeat it in English.
  const renderError = useCallback(() => <View style={styles.errorState} />, []);

  const isLoading = Boolean(browser?.isLoading);

  return (
    <View style={styles.container} onTouchStart={onFocusPane}>
      <View style={styles.chromeRow}>
        <ToolbarButton
          label={t("workspace.browser.controls.back")}
          disabled={!browser?.canGoBack}
          onPress={handleBack}
        >
          <ArrowLeftIcon size={16} />
        </ToolbarButton>
        <ToolbarButton
          label={t("workspace.browser.controls.forward")}
          disabled={!browser?.canGoForward}
          onPress={handleForward}
        >
          <ArrowRightIcon size={16} />
        </ToolbarButton>
        <ToolbarButton
          label={
            isLoading
              ? t("workspace.browser.controls.stopLoading")
              : t("workspace.browser.controls.refresh")
          }
          onPress={handleReloadOrStop}
        >
          {isLoading ? <StopIcon size={16} /> : <ReloadIcon size={16} />}
        </ToolbarButton>
        <View style={styles.urlBarWrap}>
          <UrlInput
            ref={urlInputRef}
            accessibilityLabel={t("workspace.browser.controls.browserUrl")}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            selectTextOnFocus
            initialValue={currentUrl}
            onChangeText={handleDraftChange}
            onSubmitEditing={handleSubmit}
            placeholder={t("workspace.browser.controls.enterUrl")}
            style={styles.urlInput}
          />
          {isLoading ? <LoadingIndicator size="small" /> : null}
        </View>
      </View>
      {browser?.lastError ? (
        <View style={styles.errorRow}>
          <Text numberOfLines={2} style={styles.errorText}>
            {browser.lastError}
          </Text>
        </View>
      ) : null}
      <View style={styles.webViewWrap}>
        <WebView
          key={request.epoch}
          ref={webViewRef}
          testID={`browser-webview-${browserId}`}
          style={styles.webView}
          source={source}
          originWhitelist={ORIGIN_WHITELIST}
          onShouldStartLoadWithRequest={handleShouldStartLoad}
          onNavigationStateChange={handleNavigationStateChange}
          onLoadStart={handleLoadStart}
          onLoadEnd={handleLoadEnd}
          onError={handleError}
          onHttpError={handleHttpError}
          renderError={renderError}
          setSupportMultipleWindows
          onOpenWindow={handleOpenWindow}
          javaScriptCanOpenWindowsAutomatically={false}
          // Mirrors the Electron browser profile, which leaves Chromium's default of
          // allowing third-party cookies (embedded sign-ins depend on it).
          thirdPartyCookiesEnabled
          mixedContentMode="never"
          allowFileAccess={false}
          allowsBackForwardNavigationGestures
          onRenderProcessGone={remountAtCurrentUrl}
          onContentProcessDidTerminate={remountAtCurrentUrl}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  chromeRow: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  iconButtonDisabled: {
    opacity: 0.45,
  },
  urlBarWrap: {
    flex: 1,
    minWidth: 0,
    height: 28,
    marginLeft: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  urlInput: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  errorRow: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[500],
  },
  webViewWrap: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  webView: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  errorState: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.surface0,
  },
}));
