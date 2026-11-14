import { describe, expect, it } from "vitest";
import {
  decideNativeBrowserNavigation,
  getUnsafeNavigationMessage,
  isAbortedNativeLoadError,
  isAllowedBrowserUrl,
} from "./navigation-policy";

const labels = {
  invalidUrl: "invalid",
  unsupportedProtocol: (protocol: string) => `unsupported ${protocol}`,
};

describe("browser navigation policy", () => {
  it("lets a tab load only web pages and about:blank", () => {
    expect(
      ["https://a.test", "http://localhost:3000", "about:blank"].map(isAllowedBrowserUrl),
    ).toEqual([true, true, true]);
    expect(
      ["about:srcdoc", "file:///etc/hosts", "javascript:alert(1)", "not a url"].map(
        isAllowedBrowserUrl,
      ),
    ).toEqual([false, false, false, false]);
    expect(getUnsafeNavigationMessage("file:///etc/hosts", labels)).toBe("unsupported file:");
    expect(getUnsafeNavigationMessage("not a url", labels)).toBe("invalid");
    expect(getUnsafeNavigationMessage("https://a.test", labels)).toBeNull();
  });

  it("hands mailto: and tel: to the OS and blocks every other scheme at the top level", () => {
    const decide = (url: string) => decideNativeBrowserNavigation({ url, isTopFrame: true });
    expect(decide("https://a.test/page")).toBe("allow");
    expect(decide("about:blank")).toBe("allow");
    expect(decide("mailto:someone@example.com")).toBe("open-externally");
    expect(decide("tel:+15550100")).toBe("open-externally");
    expect(
      [
        "intent://scan/#Intent;scheme=zxing;end",
        "file:///sdcard/secret.txt",
        "javascript:alert(1)",
        "data:text/html,<p>hi</p>",
        "myapp://open",
        "not a url",
      ].map(decide),
    ).toEqual(["block", "block", "block", "block", "block", "block"]);
  });

  it("lets subframes hold inline documents but never reach the OS", () => {
    const decide = (url: string) => decideNativeBrowserNavigation({ url, isTopFrame: false });
    expect(
      ["https://a.test/embed", "about:srcdoc", "data:text/html,x", "blob:https://a.test/1"].map(
        decide,
      ),
    ).toEqual(["allow", "allow", "allow", "allow"]);
    expect(["mailto:a@b.test", "intent://x", "javascript:alert(1)"].map(decide)).toEqual([
      "block",
      "block",
      "block",
    ]);
  });

  it("applies the top-level rule without the OS hand-off when the frame is unknown", () => {
    const decide = (url: string) => decideNativeBrowserNavigation({ url, isTopFrame: undefined });
    expect(["https://a.test", "mailto:a@b.test", "tel:1", "data:text/html,x"].map(decide)).toEqual([
      "allow",
      "block",
      "block",
      "block",
    ]);
  });
});

describe("isAbortedNativeLoadError", () => {
  it("ignores superseded loads but reports real failures", () => {
    expect(isAbortedNativeLoadError({ domain: "NSURLErrorDomain", code: -999 })).toBe(true);
    expect(isAbortedNativeLoadError({ domain: "WebKitErrorDomain", code: 102 })).toBe(true);
    expect(isAbortedNativeLoadError({ code: -1, description: "net::ERR_ABORTED" })).toBe(true);
    expect(isAbortedNativeLoadError({ domain: "NSURLErrorDomain", code: -1003 })).toBe(false);
    expect(isAbortedNativeLoadError({ code: -2, description: "net::ERR_NAME_NOT_RESOLVED" })).toBe(
      false,
    );
  });
});
