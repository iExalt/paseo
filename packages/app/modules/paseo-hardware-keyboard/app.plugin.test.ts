import { describe, expect, it } from "vitest";

const { configureKeyDispatch } = require("./app.plugin");

// Trimmed from the MainActivity.kt that Expo SDK 57 prebuild generates.
const TEMPLATE = `package sh.paseo.debug

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun getMainComponentName(): String = "main"
}
`;

describe("Android hardware keyboard key dispatch", () => {
  it("routes MainActivity key events through the module before React Native", () => {
    const result = configureKeyDispatch(TEMPLATE);
    expect(result).toContain(
      "class MainActivity : ReactActivity() {\n" +
        "  // Hardware keyboard shortcuts: the module consumes keys bound in the published policy.\n" +
        "  override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {\n" +
        "    if (sh.paseo.hardwarekeyboard.PaseoHardwareKeyboardModule.handleKeyEvent(this, event)) return true\n" +
        "    return super.dispatchKeyEvent(event)\n" +
        "  }\n",
    );
    expect(result).toContain('override fun getMainComponentName(): String = "main"');
    expect(configureKeyDispatch(result)).toBe(result);
  });

  it("fails prebuild when the template no longer supports the override", () => {
    expect(() => configureKeyDispatch("class MainActivity : AppCompatActivity() {}")).toThrow(
      "no longer extends ReactActivity",
    );
    expect(() =>
      configureKeyDispatch(`${TEMPLATE}\nfun dispatchKeyEvent(event: KeyEvent): Boolean = false`),
    ).toThrow("already overrides dispatchKeyEvent");
  });
});
