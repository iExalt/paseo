const { withMainActivity } = require("expo/config-plugins");

const ACTIVITY_CLASS = /class MainActivity\s*:\s*ReactActivity\(\)\s*\{/;
const HOOK = "sh.paseo.hardwarekeyboard.PaseoHardwareKeyboardModule.handleKeyEvent(this, event)";
const OVERRIDE = `
  // Hardware keyboard shortcuts: the module consumes keys bound in the published policy.
  override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
    if (${HOOK}) return true
    return super.dispatchKeyEvent(event)
  }
`;

function configureKeyDispatch(contents) {
  if (contents.includes(HOOK)) return contents;
  if (/fun dispatchKeyEvent\s*\(/.test(contents)) {
    throw new Error(
      "Could not route hardware keyboard shortcuts: MainActivity already overrides dispatchKeyEvent",
    );
  }
  const match = ACTIVITY_CLASS.exec(contents);
  if (!match) {
    throw new Error(
      "Could not route hardware keyboard shortcuts: MainActivity no longer extends ReactActivity",
    );
  }
  const insertAt = match.index + match[0].length;
  return `${contents.slice(0, insertAt)}${OVERRIDE}${contents.slice(insertAt)}`;
}

module.exports = (config) =>
  withMainActivity(config, (mod) => {
    if (mod.modResults.language !== "kt") {
      throw new Error("Could not route hardware keyboard shortcuts: MainActivity is not Kotlin");
    }
    mod.modResults.contents = configureKeyDispatch(mod.modResults.contents);
    return mod;
  });
module.exports.configureKeyDispatch = configureKeyDispatch;
