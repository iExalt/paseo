package sh.paseo.keyboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

class WindowKeyDispatcherTest {
  @Test fun observesOnePressAcrossNestedWindows() {
    val dispatcher = WindowKeyDispatcher<Any>()
    val event = Any()
    var observations = 0
    var deliveries = 0
    dispatcher.dispatch(event, { observations++; false }, {
      dispatcher.dispatch(event, { observations++; false }, { deliveries++; false })
    })
    assertEquals(1, observations)
    assertEquals(1, deliveries)
    dispatcher.dispatch(event, { observations++; false }, { false })
    assertEquals(2, observations)
  }
  @Test fun consumedOverlayKeyDoesNotReachTheView() {
    val dispatcher = WindowKeyDispatcher<Any>()
    var deliveries = 0
    assertTrue(dispatcher.dispatch(Any(), { true }, { deliveries++; false }))
    assertEquals(0, deliveries)
  }

  @Test fun captureReservesNavigationAndFocusedTyping() {
    val capture = ShortcutCaptureKeys()
    capture.active = true
    for (code in listOf("Enter", "Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown")) {
      assertFalse(capture.capture(1, ShortcutCapturePress(code, code)))
      assertFalse(capture.capture(1, ShortcutCapturePress(code, code, shift = true)))
      assertTrue(capture.capture(1, ShortcutCapturePress(code, code, ctrl = true, editable = true)))
      assertTrue(capture.release(1))
    }
    for (code in listOf("Backspace", "Escape", "KeyA", "Space")) {
      assertFalse(capture.capture(2, ShortcutCapturePress(code, code, editable = true)))
      assertTrue(capture.capture(2, ShortcutCapturePress(code, code)))
      assertTrue(capture.release(2))
    }
    assertFalse(capture.capture(3, ShortcutCapturePress("KeyA", "Dead")))
    assertFalse(capture.capture(3, ShortcutCapturePress("KeyA", "a", composing = true)))
    assertFalse(capture.capture(3, ShortcutCapturePress("ControlLeft", "Control", ctrl = true)))
  }
  @Test fun captureRetainsRepeatsAndReleaseAfterSaveOrCancel() {
    val capture = ShortcutCaptureKeys()
    capture.active = true
    assertTrue(capture.capture(7, ShortcutCapturePress("KeyJ", "j", ctrl = true)))
    capture.active = false
    assertTrue(capture.owns(7))
    assertTrue(capture.capture(7, ShortcutCapturePress("KeyJ", "j", ctrl = true)))
    assertTrue(capture.release(7))
    assertFalse(capture.release(7))
    assertFalse(capture.capture(7, ShortcutCapturePress("KeyJ", "j", ctrl = true)))
    capture.active = true
    assertTrue(capture.capture(8, ShortcutCapturePress("Escape", "Escape")))
    capture.reset()
    assertFalse(capture.active)
    assertFalse(capture.release(8))
  }
}
