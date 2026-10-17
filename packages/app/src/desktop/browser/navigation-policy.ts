// Which URLs a workspace browser tab may load. Shared by the Electron pane (its
// guard for typed URLs and restored tabs), the desktop new-tab bridge and the
// native WebView pane, so every platform agrees on what a browser tab is allowed
// to become.

const ALLOWED_BROWSER_PROTOCOLS = new Set(["http:", "https:"]);
// Schemes the native pane hands to the OS instead of loading. Everything else that
// is not a web page (intent:, file:, javascript:, data:, custom app schemes) is
// refused, so a page cannot launch other apps or read local files.
const EXTERNAL_BROWSER_PROTOCOLS = new Set(["mailto:", "tel:"]);
// Documents a subframe may legitimately hold beyond plain web pages.
const ALLOWED_SUBFRAME_PROTOCOLS = new Set(["http:", "https:", "about:", "data:", "blob:"]);

export type BrowserNavigationBlockReason =
  | { kind: "invalid-url" }
  | { kind: "unsupported-protocol"; protocol: string };

export type NativeBrowserNavigationDecision = "allow" | "open-externally" | "block";

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Why a browser tab must not load `url` at the top level, or null when it may. */
export function getBrowserNavigationBlockReason(url: string): BrowserNavigationBlockReason | null {
  const parsed = parseUrl(url);
  if (!parsed) {
    return { kind: "invalid-url" };
  }
  if (ALLOWED_BROWSER_PROTOCOLS.has(parsed.protocol) || parsed.href === "about:blank") {
    return null;
  }
  return { kind: "unsupported-protocol", protocol: parsed.protocol };
}

/** True when a browser tab may load `url` at the top level (http, https, about:blank). */
export function isAllowedBrowserUrl(url: string): boolean {
  return getBrowserNavigationBlockReason(url) === null;
}

export function getUnsafeNavigationMessage(
  url: string,
  labels: { invalidUrl: string; unsupportedProtocol: (protocol: string) => string },
): string | null {
  const reason = getBrowserNavigationBlockReason(url);
  if (!reason) {
    return null;
  }
  return reason.kind === "invalid-url"
    ? labels.invalidUrl
    : labels.unsupportedProtocol(reason.protocol);
}

/**
 * The native pane's onShouldStartLoadWithRequest decision. Top-level loads follow
 * the browser tab rule, with mailto: and tel: passed to the OS; subframes may also
 * hold about:, data: and blob: documents but never reach the OS.
 */
export function decideNativeBrowserNavigation(input: {
  url: string;
  isTopFrame: boolean;
}): NativeBrowserNavigationDecision {
  const parsed = parseUrl(input.url);
  if (!parsed) {
    return "block";
  }
  if (!input.isTopFrame) {
    return ALLOWED_SUBFRAME_PROTOCOLS.has(parsed.protocol) ? "allow" : "block";
  }
  if (isAllowedBrowserUrl(input.url)) {
    return "allow";
  }
  return EXTERNAL_BROWSER_PROTOCOLS.has(parsed.protocol) ? "open-externally" : "block";
}

/**
 * Load failures that are not real errors: a load superseded by a newer navigation
 * or a redirect (iOS reports NSURLErrorCancelled and WebKit "frame load
 * interrupted"; Chromium reports ERR_ABORTED), or one this pane refused.
 */
export function isAbortedNativeLoadError(error: {
  code: number;
  domain?: string;
  description?: string;
}): boolean {
  if (error.domain === "NSURLErrorDomain" && error.code === -999) {
    return true;
  }
  if (error.domain === "WebKitErrorDomain" && (error.code === 101 || error.code === 102)) {
    return true;
  }
  const description = error.description ?? "";
  return description.includes("ERR_ABORTED") || description.includes("ERR_BLOCKED_BY_CLIENT");
}
