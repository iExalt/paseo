package sh.paseo.keyboard

internal data class ShortcutCapturePress(
  val code: String,
  val key: String,
  val ctrl: Boolean = false,
  val meta: Boolean = false,
  val alt: Boolean = false,
  val shift: Boolean = false,
  val composing: Boolean = false,
  val editable: Boolean = false,
)

// Mirrors normalizeShortcutCapture's synchronous consumption policy. Recording stays in JS.
internal fun capturesShortcutKey(press: ShortcutCapturePress): Boolean {
  if (press.composing || press.key == "Dead" || press.key == "Process" || press.code.isEmpty()) return false
  if (press.code in setOf("ControlLeft", "ControlRight", "MetaLeft", "MetaRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight")) return false
  if (press.ctrl || press.meta) return true
  if (press.editable) return false
  if (press.code in setOf("Backspace", "Escape")) return !press.alt && !press.shift
  return press.code !in setOf("Tab", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown")
}


// Disabling capture does not hand a held key back to the view or default shortcut owner.
internal class ShortcutCaptureKeys {
  @Volatile var active = false
  private val ownedPresses = mutableSetOf<Int>()
  @Synchronized fun owns(keyCode: Int): Boolean = keyCode in ownedPresses
  @Synchronized fun capture(keyCode: Int, press: ShortcutCapturePress): Boolean {
    if (keyCode in ownedPresses) return true
    if (!active || !capturesShortcutKey(press)) return false
    ownedPresses.add(keyCode)
    return true
  }
  @Synchronized fun release(keyCode: Int): Boolean = ownedPresses.remove(keyCode)
  @Synchronized fun reset() { active = false; ownedPresses.clear() }
}
