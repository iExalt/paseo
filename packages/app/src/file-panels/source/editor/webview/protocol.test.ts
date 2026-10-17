import { describe, expect, test } from "vitest";
import { documentChecksum, parseWebViewMessage, serializeHostMessage } from "./protocol";

describe("file editor WebView protocol", () => {
  test("injected messages survive content that would end the script or the source line", () => {
    const content = "a</script>b\u2028c\u2029d";
    const source = serializeHostMessage({ type: "setDocument", content, remoteRev: 2 });
    expect(source).not.toMatch(/<\/script|\u2028|\u2029/i);
    // oxlint-disable-next-line typescript/no-implied-eval -- evaluating the injected source is the point
    expect(new Function(`return ${source};`)()).toEqual({
      type: "setDocument",
      content,
      remoteRev: 2,
    });
  });

  test("only the WebView's own message types are accepted", () => {
    expect(parseWebViewMessage('{"type":"save","checksum":"1:0"}')).toEqual({
      type: "save",
      checksum: "1:0",
    });
    expect(parseWebViewMessage('{"type":"input"}')).toBeNull();
    expect(parseWebViewMessage("not json")).toBeNull();
    expect(parseWebViewMessage("null")).toBeNull();
  });

  test("the checksum tells documents of the same length apart", () => {
    expect(documentChecksum("abc")).toBe(documentChecksum("abc"));
    expect(documentChecksum("abc")).not.toBe(documentChecksum("abd"));
    expect(documentChecksum("abc").startsWith("3:")).toBe(true);
  });
});
