package sh.paseo.keyboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerSubmitKeysTest {
  private fun enter(keyCode: Int = 66) = ComposerSubmitPress(keyCode, true, false, true, true, true, false, true, false, false)

  @Test fun submitsEnterAndNumpadEnterOnceAndOwnsTheirRelease() {
    for (code in listOf(66, 160)) {
      val router = ComposerSubmitKeys().apply { enabled = true }
      var calls = 0
      val press = enter(code)
      assertTrue(router.dispatch(press) { calls++ })
      router.enabled = false
      val changed = press.copy(repeat = true, physical = false, unmodified = false, composing = true, editable = false, overlayOwnsKey = true)
      assertTrue(router.dispatch(changed) { calls++ })
      assertTrue(router.dispatch(changed.copy(down = false)) { calls++ })
      assertFalse(router.dispatch(changed.copy(down = false)) { calls++ })
      assertEquals(1, calls)
    }
  }

  @Test fun leavesOtherInputAndOverlayEnterToTheirOwners() {
    val press = enter()
    val cases = listOf(press.copy(repeat = true), press.copy(enter = false),
      press.copy(physical = false), press.copy(unmodified = false), press.copy(composing = true),
      press.copy(editable = false), press.copy(terminal = true), press.copy(overlayOwnsKey = true))
    for (excluded in cases) {
      val router = ComposerSubmitKeys().apply { enabled = true }
      assertFalse(router.dispatch(excluded) { throw AssertionError("Excluded event submitted") })
      assertFalse(router.dispatch(excluded.copy(down = false)) { throw AssertionError("Unowned release submitted") })
    }
  }

  @Test fun disabledAndDestroyedOwnersDoNotSubmitOrRetainPresses() {
    val router = ComposerSubmitKeys()
    assertFalse(router.dispatch(enter()) { throw AssertionError("Disabled submit") })
    router.enabled = true
    assertTrue(router.dispatch(enter()) {})
    router.reset()
    assertFalse(router.enabled)
    assertFalse(router.dispatch(enter().copy(down = false)) {})
    assertFalse(router.dispatch(enter()) { throw AssertionError("Destroyed submit") })
  }

  @Test fun nestedWindowDispatchSubmitsOnceWithoutDeliveringToTheTextView() {
    val router = ComposerSubmitKeys().apply { enabled = true }
    val windows = WindowKeyDispatcher<Any>()
    val event = Any()
    var calls = 0
    var deliveries = 0
    fun observe() = router.dispatch(enter()) { calls++ }
    assertTrue(windows.dispatch(event, ::observe, {
      windows.dispatch(event, ::observe, { deliveries++; false })
    }))
    assertEquals(1, calls)
    assertEquals(0, deliveries)
  }
}
