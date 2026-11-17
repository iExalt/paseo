package sh.paseo.keyboard

import android.content.ComponentCallbacks
import android.content.res.Configuration
import android.hardware.input.InputManager
import android.os.Handler
import android.os.Looper
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.Window
import android.widget.EditText
import android.view.inputmethod.BaseInputConnection
import com.facebook.react.R
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.ReactContext
import com.facebook.react.interfaces.ExtraWindowEventListener
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Matched against the hidden terminal input's `nativeID`
// (TERMINAL_INPUT_NATIVE_ID in terminal-input.native.tsx).
private const val TERMINAL_INPUT_NATIVE_ID = "paseo-terminal-input"

internal object HardwareKeyboard {
  var module: PaseoHardwareKeyboardModule? = null
  val shortcutCapture = ShortcutCaptureKeys()
  @Volatile var overlayKeys: Set<String> = emptySet()
  private val windows = mutableMapOf<Window, KeyboardWindowCallback>()
  val dispatcher = WindowKeyDispatcher<KeyEvent>()
  val composerSubmit = ComposerSubmitKeys()
  private val consumedPresses = mutableSetOf<Int>()
  private val terminalArrowCodes = setOf("ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight")

  fun observe(window: Window) {
    if (windows.containsKey(window)) return
    val callback = KeyboardWindowCallback(window, window.callback)
    windows[window] = callback
    window.callback = callback
  }
  fun release(window: Window) {
    val callback = windows.remove(window) ?: return
    if (window.callback === callback) window.callback = callback.previous
  }
  fun releaseAll() {
    windows.keys.toList().forEach { release(it) }
    consumedPresses.clear()
    shortcutCapture.reset()
  }

  fun dispatch(event: KeyEvent, composing: Boolean, terminalFocused: Boolean, editableFocused: Boolean): Boolean {
    if (event.action != KeyEvent.ACTION_DOWN && event.action != KeyEvent.ACTION_UP) return false
    val code = code(event.keyCode)
    val unmodified = !event.isAltPressed && !event.isCtrlPressed && !event.isMetaPressed && !event.isShiftPressed
    val physical = event.flags and KeyEvent.FLAG_SOFT_KEYBOARD == 0 &&
      event.deviceId != KeyCharacterMap.VIRTUAL_KEYBOARD && event.device?.isVirtual == false
    val capturing = shortcutCapture.active
    val submitted = (!capturing || event.action == KeyEvent.ACTION_UP) && composerSubmit.dispatch(ComposerSubmitPress(
      keyCode = event.keyCode,
      down = event.action == KeyEvent.ACTION_DOWN,
      repeat = event.repeatCount > 0,
      enter = code == "Enter",
      physical = physical,
      unmodified = unmodified,
      composing = composing,
      editable = editableFocused,
      terminal = terminalFocused,
      overlayOwnsKey = code in overlayKeys && unmodified && !composing,
    )) { module?.emitSubmit() }
    if (submitted) return true
    if (event.flags and KeyEvent.FLAG_SOFT_KEYBOARD != 0) return false
    if (code.isEmpty()) return false
    if (event.action == KeyEvent.ACTION_DOWN && shortcutCapture.owns(event.keyCode)) return true
    val textModifiers = event.metaState and KeyEvent.META_CTRL_MASK.inv() and KeyEvent.META_META_MASK.inv()
    val character = event.getUnicodeChar(textModifiers)
    val named = !code.startsWith("Key") && !code.startsWith("Digit")
    val key = when {
      code.startsWith("Control") -> "Control"
      code.startsWith("Meta") -> "Meta"
      code.startsWith("Shift") -> "Shift"
      code.startsWith("Alt") -> "Alt"
      named && (character == 0 || code == "Enter" || code == "Tab" || code == "Backspace") -> code
      character != 0 -> hardwareCharacterKey(character)
      else -> code
    }
    module?.emit(mapOf(
      "key" to key, "code" to code,
      "altKey" to event.isAltPressed, "ctrlKey" to event.isCtrlPressed,
      "metaKey" to event.isMetaPressed, "shiftKey" to event.isShiftPressed,
      "repeat" to (event.repeatCount > 0), "isComposing" to composing,
      "phase" to if (event.action == KeyEvent.ACTION_UP) "up" else "down"
    ))
    if (event.action == KeyEvent.ACTION_UP) return shortcutCapture.release(event.keyCode) || consumedPresses.remove(event.keyCode)
    if (capturing) {
      return shortcutCapture.capture(event.keyCode, ShortcutCapturePress(
        code = code, key = key, ctrl = event.isCtrlPressed, meta = event.isMetaPressed,
        alt = event.isAltPressed, shift = event.isShiftPressed,
        composing = composing, editable = editableFocused,
      ))
    }
    val overlayOwnsKey = key != "Dead" && key in overlayKeys && !event.isCtrlPressed && !event.isMetaPressed && !event.isAltPressed && !composing
    // Without this the hidden input consumes the arrows as caret movement and
    // its next text change stops being a plain append. Modifiers stay
    // forwarded: Alt/Shift+arrow are terminal editing keys.
    val terminalOwnsKey = terminalFocused && !composing && code in terminalArrowCodes
    if (overlayOwnsKey || terminalOwnsKey) consumedPresses.add(event.keyCode)
    return overlayOwnsKey || terminalOwnsKey
  }

  private fun code(keyCode: Int): String = when (keyCode) {
    in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> "Key" + ('A'.code + keyCode - KeyEvent.KEYCODE_A).toChar()
    in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> "Digit" + (keyCode - KeyEvent.KEYCODE_0)
    in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12 -> "F" + (keyCode - KeyEvent.KEYCODE_F1 + 1)
    KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "Enter"
    KeyEvent.KEYCODE_ESCAPE -> "Escape"
    KeyEvent.KEYCODE_DEL -> "Backspace"
    KeyEvent.KEYCODE_FORWARD_DEL -> "Delete"
    KeyEvent.KEYCODE_TAB -> "Tab"
    KeyEvent.KEYCODE_SPACE -> "Space"
    KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
    KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
    KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
    KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
    KeyEvent.KEYCODE_CTRL_LEFT -> "ControlLeft"
    KeyEvent.KEYCODE_CTRL_RIGHT -> "ControlRight"
    KeyEvent.KEYCODE_META_LEFT -> "MetaLeft"
    KeyEvent.KEYCODE_META_RIGHT -> "MetaRight"
    KeyEvent.KEYCODE_SHIFT_LEFT -> "ShiftLeft"
    KeyEvent.KEYCODE_SHIFT_RIGHT -> "ShiftRight"
    KeyEvent.KEYCODE_ALT_LEFT -> "AltLeft"
    KeyEvent.KEYCODE_ALT_RIGHT -> "AltRight"
    KeyEvent.KEYCODE_COMMA -> "Comma"
    KeyEvent.KEYCODE_PERIOD -> "Period"
    KeyEvent.KEYCODE_MINUS -> "Minus"
    KeyEvent.KEYCODE_EQUALS -> "Equal"
    KeyEvent.KEYCODE_LEFT_BRACKET -> "BracketLeft"
    KeyEvent.KEYCODE_RIGHT_BRACKET -> "BracketRight"
    KeyEvent.KEYCODE_BACKSLASH -> "Backslash"
    KeyEvent.KEYCODE_SEMICOLON -> "Semicolon"
    KeyEvent.KEYCODE_APOSTROPHE -> "Quote"
    KeyEvent.KEYCODE_GRAVE -> "Backquote"
    KeyEvent.KEYCODE_SLASH -> "Slash"
    else -> ""
  }
}

private class KeyboardWindowCallback(private val window: Window, val previous: Window.Callback) : Window.Callback by previous {
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val focus = window.currentFocus
    val editable = (focus as? EditText)?.text
    val composing = editable != null && BaseInputConnection.getComposingSpanStart(editable) >= 0
    val terminalFocused = focus?.getTag(R.id.view_tag_native_id) == TERMINAL_INPUT_NATIVE_ID
    return HardwareKeyboard.dispatcher.dispatch(
      event,
      { HardwareKeyboard.dispatch(event, composing, terminalFocused, focus is EditText) },
      { previous.dispatchKeyEvent(event) },
    )
  }
}

class PaseoHardwareKeyboardModule : Module(), ExtraWindowEventListener, InputManager.InputDeviceListener, ComponentCallbacks {
  private var inputManager: InputManager? = null
  private var registeredReactContext: ReactContext? = null
  private fun keyboardPresent(): Boolean {
    val config = registeredReactContext?.resources?.configuration
    return (config?.keyboard == Configuration.KEYBOARD_QWERTY && config.hardKeyboardHidden != Configuration.HARDKEYBOARDHIDDEN_YES) ||
      InputDevice.getDeviceIds().any { id -> InputDevice.getDevice(id)?.let { !it.isVirtual && it.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC } == true }
  }
  private fun presenceChanged() { sendEvent("onHardwareKeyboardPresenceChanged", emptyMap<String, Any>()) }
  override fun onInputDeviceAdded(id: Int) { presenceChanged() }
  override fun onInputDeviceRemoved(id: Int) { presenceChanged() }
  override fun onInputDeviceChanged(id: Int) { presenceChanged() }
  override fun onConfigurationChanged(config: Configuration) { presenceChanged() }
  override fun onLowMemory() {}
  override fun onExtraWindowCreate(window: Window) { HardwareKeyboard.observe(window) }
  override fun onExtraWindowDestroy(window: Window) { HardwareKeyboard.release(window) }
  override fun definition() = ModuleDefinition {
    Name("PaseoHardwareKeyboard")
    Events("onHardwareKeyboardShortcut", "onHardwareKeyboardPresenceChanged", "onHardwareKeyboardSubmit")
    OnCreate {
      HardwareKeyboard.module = this@PaseoHardwareKeyboardModule
      val context = appContext.reactContext
      require(context is ReactContext) { "Hardware keyboard observation requires a React context" }
      registeredReactContext = context
      context.registerComponentCallbacks(this@PaseoHardwareKeyboardModule)
      inputManager = context.getSystemService(InputManager::class.java)
      inputManager?.registerInputDeviceListener(this@PaseoHardwareKeyboardModule, Handler(Looper.getMainLooper()))
      context.addExtraWindowEventListener(this@PaseoHardwareKeyboardModule)
      UiThreadUtil.runOnUiThread { appContext.currentActivity?.window?.let { HardwareKeyboard.observe(it) } }
    }
    OnDestroy {
      inputManager?.unregisterInputDeviceListener(this@PaseoHardwareKeyboardModule)
      inputManager = null
      registeredReactContext?.unregisterComponentCallbacks(this@PaseoHardwareKeyboardModule)
      registeredReactContext?.removeExtraWindowEventListener(this@PaseoHardwareKeyboardModule)
      registeredReactContext = null
      if (HardwareKeyboard.module === this@PaseoHardwareKeyboardModule) {
        HardwareKeyboard.module = null
        HardwareKeyboard.shortcutCapture.reset()
        HardwareKeyboard.composerSubmit.reset()
        HardwareKeyboard.overlayKeys = emptySet()
        UiThreadUtil.runOnUiThread { if (HardwareKeyboard.module == null) HardwareKeyboard.releaseAll() }
      }
    }
    Function("setHardwareKeyboardSubmitEnabled") { enabled: Boolean ->
      HardwareKeyboard.composerSubmit.enabled = enabled
    }
    Function("getHardwareKeyboardPresent") { keyboardPresent() }
    Function("setShortcutCaptureActive") { active: Boolean ->
      HardwareKeyboard.shortcutCapture.active = active
    }
    Function("setOverlayKeys") { keys: List<String> ->
      HardwareKeyboard.overlayKeys = keys.filter { it in setOf("Escape", "Enter", "ArrowUp", "ArrowDown") }.toSet()
    }
  }
  internal fun emitSubmit() { sendEvent("onHardwareKeyboardSubmit", emptyMap<String, Any>()) }
  internal fun emit(event: Map<String, Any>) { sendEvent("onHardwareKeyboardShortcut", event) }
}
