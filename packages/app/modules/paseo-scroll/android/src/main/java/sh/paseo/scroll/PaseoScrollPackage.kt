package sh.paseo.scroll

import android.graphics.Matrix
import android.graphics.Rect
import android.view.MotionEvent
import com.facebook.react.ReactPackage
import com.facebook.react.ViewManagerOnDemandReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManager
import com.facebook.react.views.scroll.ReactScrollView
import com.facebook.react.views.scroll.ReactScrollViewManager

/** Keeps RN's scroll props, commands, events, and Fabric component unchanged. */
class PaseoScrollPackage : ReactPackage, ViewManagerOnDemandReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = emptyList()
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> =
    listOf(PaseoScrollViewManager())
  override fun getViewManagerNames(context: ReactApplicationContext): Collection<String> =
    listOf(ReactScrollViewManager.REACT_CLASS)
  override fun createViewManager(context: ReactApplicationContext, name: String): ViewManager<*, *>? =
    if (name == ReactScrollViewManager.REACT_CLASS) PaseoScrollViewManager() else null
}

private class PaseoScrollViewManager : ReactScrollViewManager() {
  override fun createViewInstance(context: ThemedReactContext): ReactScrollView =
    PaseoScrollView(context)
}

private class PaseoScrollView(context: ThemedReactContext) : ReactScrollView(context) {
  private val transformValues = FloatArray(9)

  // Both RN focus handling and Android selection visibility requests use this calculation.
  // Its coordinates ignore inversion. Keep focus/selection bookkeeping, but leave timeline
  // movement to user gestures and explicit scroll commands.
  override fun computeScrollDeltaToGetChildRectOnScreen(rect: Rect): Int {
    if (isVerticallyInverted()) return 0
    return super.computeScrollDeltaToGetChildRectOnScreen(rect)
  }

  // Android applies wheel and rotary scrolls in content coordinates, which an inverted list
  // draws upside down. Flip the axes so wheeling up still moves the timeline up on screen.
  override fun onGenericMotionEvent(event: MotionEvent): Boolean {
    if (event.actionMasked != MotionEvent.ACTION_SCROLL || !isVerticallyInverted()) {
      return super.onGenericMotionEvent(event)
    }
    val flipped = withVerticalScrollFlipped(event)
    try {
      return super.onGenericMotionEvent(flipped)
    } finally {
      flipped.recycle()
    }
  }

  private fun isVerticallyInverted(): Boolean {
    // RN's Android scale: -1 becomes a 180-degree rotation with positive scaleY.
    matrix.getValues(transformValues)
    return transformValues[Matrix.MSCALE_Y] < 0
  }
}

private fun withVerticalScrollFlipped(event: MotionEvent): MotionEvent {
  val count = event.pointerCount
  val properties = Array(count) {
    MotionEvent.PointerProperties().also { p -> event.getPointerProperties(it, p) }
  }
  val coords = Array(count) {
    MotionEvent.PointerCoords().also { c ->
      event.getPointerCoords(it, c)
      c.setAxisValue(MotionEvent.AXIS_VSCROLL, -c.getAxisValue(MotionEvent.AXIS_VSCROLL))
      c.setAxisValue(MotionEvent.AXIS_SCROLL, -c.getAxisValue(MotionEvent.AXIS_SCROLL))
    }
  }
  return MotionEvent.obtain(
    event.downTime,
    event.eventTime,
    event.action,
    count,
    properties,
    coords,
    event.metaState,
    event.buttonState,
    event.xPrecision,
    event.yPrecision,
    event.deviceId,
    event.edgeFlags,
    event.source,
    event.flags,
  )
}
