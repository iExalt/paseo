package sh.paseo.hardwarekeyboard

import android.app.Activity
import android.content.ComponentCallbacks
import android.content.Context
import android.content.res.Configuration
import android.os.Bundle
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.webkit.WebView
import android.widget.TextView
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject

private const val SHORTCUT_KEY_EVENT = "onShortcutKey"
private const val SUBMIT_EVENT = "onHardwareKeyboardSubmit"
private const val KEYBOARD_CHANGE_EVENT = "onHardwareKeyboardChange"

/**
 * Routes hardware keys that Paseo binds to JS. MainActivity calls [handleKeyEvent] from
 * dispatchKeyEvent (see app.plugin.js), so the decision is synchronous and made before
 * the focused view sees the key. JS publishes which combos can match; see
 * src/keyboard/native-shortcut-policy.ts for the policy and the JS matcher this mirrors.
 */
class PaseoHardwareKeyboardModule : Module() {
  private var lastKeyboardPresent: Boolean? = null
  private var callbacksContext: Context? = null

  private val configurationCallbacks = object : ComponentCallbacks {
    override fun onConfigurationChanged(newConfig: Configuration) {
      val present = hasHardwareKeyboard(newConfig)
      if (present == lastKeyboardPresent) return
      lastKeyboardPresent = present
      sendEvent(KEYBOARD_CHANGE_EVENT, Bundle().apply { putBoolean("present", present) })
    }

    override fun onLowMemory() {}
  }

  override fun definition() = ModuleDefinition {
    Name("PaseoHardwareKeyboard")

    Events(SHORTCUT_KEY_EVENT, SUBMIT_EVENT, KEYBOARD_CHANGE_EVENT)

    OnCreate {
      activeModule = this@PaseoHardwareKeyboardModule
      val context = appContext.reactContext?.applicationContext
      context?.registerComponentCallbacks(configurationCallbacks)
      callbacksContext = context
    }

    OnDestroy {
      callbacksContext?.unregisterComponentCallbacks(configurationCallbacks)
      callbacksContext = null
      if (activeModule === this@PaseoHardwareKeyboardModule) {
        activeModule = null
        policy = ShortcutPolicy.EMPTY
        submitEnabled = false
      }
    }

    Function("setShortcutPolicy") { policyJson: String ->
      policy = ShortcutPolicy.parse(policyJson)
    }

    Function("setHardwareKeyboardSubmitEnabled") { enabled: Boolean ->
      submitEnabled = enabled
    }

    Function("hasHardwareKeyboard") {
      val configuration = appContext.reactContext?.resources?.configuration
      val present = configuration != null && hasHardwareKeyboard(configuration)
      lastKeyboardPresent = present
      present
    }
  }

  companion object {
    @Volatile private var activeModule: PaseoHardwareKeyboardModule? = null
    @Volatile private var policy: ShortcutPolicy = ShortcutPolicy.EMPTY
    @Volatile private var submitEnabled = false

    /** Key codes whose down event was consumed, so their up event is consumed too. */
    private val consumedKeyCodes = mutableSetOf<Int>()

    private fun hasHardwareKeyboard(configuration: Configuration): Boolean =
      configuration.keyboard == Configuration.KEYBOARD_QWERTY &&
        configuration.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO

    /** Called on the UI thread from MainActivity.dispatchKeyEvent. Returns true when consumed. */
    @JvmStatic
    fun handleKeyEvent(activity: Activity, event: KeyEvent): Boolean {
      if (event.action == KeyEvent.ACTION_UP) {
        return consumedKeyCodes.remove(event.keyCode)
      }
      if (event.action != KeyEvent.ACTION_DOWN) return false
      if (!isFromHardwareKeyboard(event)) return false
      val module = activeModule ?: return false

      val focus = activity.currentFocus
      val typing = focus != null && (focus is WebView || focus.onCheckIsTextEditor())

      if (isSubmit(event, focus, typing)) {
        consumedKeyCodes.add(event.keyCode)
        module.sendEvent(SUBMIT_EVENT, Bundle())
        return true
      }

      val code = DomKeys.code(event.keyCode) ?: return false
      val key = DomKeys.key(event)
      val combo = policy.match(code, key, event, typing) ?: return false
      module.sendEvent(
        SHORTCUT_KEY_EVENT,
        Bundle().apply {
          putString("key", key)
          putString("code", code)
          putBoolean("altKey", event.isAltPressed)
          putBoolean("ctrlKey", event.isCtrlPressed)
          putBoolean("metaKey", event.isMetaPressed)
          putBoolean("shiftKey", event.isShiftPressed)
          putBoolean("repeat", event.repeatCount > 0)
          putBoolean("typing", typing)
        },
      )
      if (!combo.consume) return false
      consumedKeyCodes.add(event.keyCode)
      return true
    }

    /**
     * Soft keyboards deliver some keys as key events too: Gboard sends Enter in a multiline
     * field as KEYCODE_ENTER rather than committing a newline. Those must reach the field
     * untouched, or the on-screen Return key sends the message instead of breaking the line.
     */
    private fun isFromHardwareKeyboard(event: KeyEvent): Boolean {
      if ((event.flags and KeyEvent.FLAG_SOFT_KEYBOARD) != 0) return false
      if (event.deviceId == KeyCharacterMap.VIRTUAL_KEYBOARD) return false
      val device = event.device ?: return false
      return !device.isVirtual
    }

    /** Plain Enter in a focused text field submits the composer, unless an IME is composing. */
    private fun isSubmit(event: KeyEvent, focus: View?, typing: Boolean): Boolean {
      if (!submitEnabled || !typing) return false
      if (event.keyCode != KeyEvent.KEYCODE_ENTER && event.keyCode != KeyEvent.KEYCODE_NUMPAD_ENTER) {
        return false
      }
      if (event.repeatCount > 0) return false
      if (event.isAltPressed || event.isCtrlPressed || event.isMetaPressed || event.isShiftPressed) {
        return false
      }
      val text = (focus as? TextView)?.editableText ?: return false
      return BaseInputConnection.getComposingSpanStart(text) == -1
    }
  }
}

internal class ShortcutCombo(
  val code: String,
  val key: String?,
  val shiftedKey: String?,
  val codeFallback: Boolean,
  val alt: Boolean,
  val ctrl: Boolean,
  val meta: Boolean,
  val shift: Boolean,
  val repeatAllowed: Boolean,
  val consume: Boolean,
) {
  /** Mirrors matchesCombo in src/keyboard/keyboard-shortcuts.ts after modifier resolution. */
  fun matches(eventCode: String, eventKey: String, event: KeyEvent): Boolean {
    if (alt != event.isAltPressed || ctrl != event.isCtrlPressed) return false
    if (meta != event.isMetaPressed || shift != event.isShiftPressed) return false
    if (!repeatAllowed && event.repeatCount > 0) return false
    if (code == "Digit") return DIGIT_CODE.matches(eventCode)
    if (key == null) return eventCode == code
    val lowerKey = eventKey.lowercase()
    if (lowerKey == key) return true
    if (shift && shiftedKey != null && lowerKey == shiftedKey) return true
    if (alt && eventCode == code) return true
    return codeFallback && eventCode == code
  }

  companion object {
    private val DIGIT_CODE = Regex("^(Digit|Numpad)[1-9]$")

    fun parse(json: JSONObject) = ShortcutCombo(
      code = json.getString("code"),
      key = json.optString("key").ifEmpty { null },
      shiftedKey = json.optString("shiftedKey").ifEmpty { null },
      codeFallback = json.optBoolean("codeFallback", false),
      alt = json.optBoolean("alt", false),
      ctrl = json.optBoolean("ctrl", false),
      meta = json.optBoolean("meta", false),
      shift = json.optBoolean("shift", false),
      repeatAllowed = json.optBoolean("repeat", true),
      consume = json.optBoolean("consume", true),
    )
  }
}

internal class ShortcutPolicy(
  private val always: List<ShortcutCombo>,
  private val whenNotTyping: List<ShortcutCombo>,
) {
  fun match(code: String, key: String, event: KeyEvent, typing: Boolean): ShortcutCombo? {
    val candidates = if (typing) always else always + whenNotTyping
    return candidates.firstOrNull { it.matches(code, key, event) }
  }

  companion object {
    val EMPTY = ShortcutPolicy(emptyList(), emptyList())

    fun parse(policyJson: String): ShortcutPolicy {
      val json = JSONObject(policyJson)
      return ShortcutPolicy(
        combos(json.optJSONArray("always")),
        combos(json.optJSONArray("whenNotTyping")),
      )
    }

    private fun combos(array: JSONArray?): List<ShortcutCombo> {
      if (array == null) return emptyList()
      return (0 until array.length()).map { ShortcutCombo.parse(array.getJSONObject(it)) }
    }
  }
}

/** Maps Android key codes to the DOM KeyboardEvent `code` and `key` values web shortcuts use. */
internal object DomKeys {
  private val CODES: Map<Int, String> = buildMap {
    for (offset in 0..25) {
      put(KeyEvent.KEYCODE_A + offset, "Key${'A' + offset}")
    }
    for (digit in 0..9) {
      put(KeyEvent.KEYCODE_0 + digit, "Digit$digit")
      put(KeyEvent.KEYCODE_NUMPAD_0 + digit, "Numpad$digit")
    }
    for (index in 1..12) {
      put(KeyEvent.KEYCODE_F1 + index - 1, "F$index")
    }
    put(KeyEvent.KEYCODE_SPACE, "Space")
    put(KeyEvent.KEYCODE_ENTER, "Enter")
    put(KeyEvent.KEYCODE_NUMPAD_ENTER, "NumpadEnter")
    put(KeyEvent.KEYCODE_ESCAPE, "Escape")
    put(KeyEvent.KEYCODE_TAB, "Tab")
    put(KeyEvent.KEYCODE_DEL, "Backspace")
    put(KeyEvent.KEYCODE_FORWARD_DEL, "Delete")
    put(KeyEvent.KEYCODE_INSERT, "Insert")
    put(KeyEvent.KEYCODE_MOVE_HOME, "Home")
    put(KeyEvent.KEYCODE_MOVE_END, "End")
    put(KeyEvent.KEYCODE_PAGE_UP, "PageUp")
    put(KeyEvent.KEYCODE_PAGE_DOWN, "PageDown")
    put(KeyEvent.KEYCODE_DPAD_LEFT, "ArrowLeft")
    put(KeyEvent.KEYCODE_DPAD_RIGHT, "ArrowRight")
    put(KeyEvent.KEYCODE_DPAD_UP, "ArrowUp")
    put(KeyEvent.KEYCODE_DPAD_DOWN, "ArrowDown")
    put(KeyEvent.KEYCODE_MINUS, "Minus")
    put(KeyEvent.KEYCODE_EQUALS, "Equal")
    put(KeyEvent.KEYCODE_LEFT_BRACKET, "BracketLeft")
    put(KeyEvent.KEYCODE_RIGHT_BRACKET, "BracketRight")
    put(KeyEvent.KEYCODE_BACKSLASH, "Backslash")
    put(KeyEvent.KEYCODE_SEMICOLON, "Semicolon")
    put(KeyEvent.KEYCODE_APOSTROPHE, "Quote")
    put(KeyEvent.KEYCODE_COMMA, "Comma")
    put(KeyEvent.KEYCODE_PERIOD, "Period")
    put(KeyEvent.KEYCODE_GRAVE, "Backquote")
    put(KeyEvent.KEYCODE_SLASH, "Slash")
  }

  /** DOM `key` for keys that do not produce a character. */
  private val NAMED_KEYS: Map<String, String> = (1..12).associate { "F$it" to "F$it" } + mapOf(
    "Space" to " ",
    "Enter" to "Enter",
    "NumpadEnter" to "Enter",
    "Escape" to "Escape",
    "Tab" to "Tab",
    "Backspace" to "Backspace",
    "Delete" to "Delete",
    "Insert" to "Insert",
    "Home" to "Home",
    "End" to "End",
    "PageUp" to "PageUp",
    "PageDown" to "PageDown",
    "ArrowLeft" to "ArrowLeft",
    "ArrowRight" to "ArrowRight",
    "ArrowUp" to "ArrowUp",
    "ArrowDown" to "ArrowDown",
  )

  fun code(keyCode: Int): String? = CODES[keyCode]

  /**
   * The character the key types with Shift and Caps Lock applied but not Ctrl, Alt or
   * Meta, like DOM `key` on Windows and Linux (Ctrl+Shift+K reports "K").
   */
  fun key(event: KeyEvent): String {
    CODES[event.keyCode]?.let { code -> NAMED_KEYS[code]?.let { return it } }
    val metaState = event.metaState and (KeyEvent.META_SHIFT_MASK or KeyEvent.META_CAPS_LOCK_ON)
    val char = event.getUnicodeChar(metaState) and KeyCharacterMap.COMBINING_ACCENT_MASK
    return if (char == 0) "Unidentified" else String(Character.toChars(char))
  }
}
