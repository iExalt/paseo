package sh.paseo.keyboard

internal data class ComposerSubmitPress(
  val keyCode: Int,
  val down: Boolean,
  val repeat: Boolean,
  val enter: Boolean,
  val physical: Boolean,
  val unmodified: Boolean,
  val composing: Boolean,
  val editable: Boolean,
  val terminal: Boolean,
  val overlayOwnsKey: Boolean,
)

// Ownership spans repeats and release, even if focus or policy changes meanwhile.
internal class ComposerSubmitKeys {
  @Volatile var enabled = false
  private val ownedPresses = mutableSetOf<Int>()

  @Synchronized fun dispatch(press: ComposerSubmitPress, submit: () -> Unit): Boolean {
    if (!press.down) return ownedPresses.remove(press.keyCode)
    if (press.keyCode in ownedPresses) return true
    if (!enabled || press.repeat || !press.enter || !press.physical || !press.unmodified ||
      press.composing || !press.editable || press.terminal || press.overlayOwnsKey) return false
    ownedPresses.add(press.keyCode)
    submit()
    return true
  }

  @Synchronized fun reset() {
    enabled = false
    ownedPresses.clear()
  }
}
