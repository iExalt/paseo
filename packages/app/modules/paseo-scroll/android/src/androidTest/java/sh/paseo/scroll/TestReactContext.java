package sh.paseo.scroll;

import android.content.Context;
import com.facebook.react.bridge.BridgeReactContext;
import com.facebook.react.uimanager.events.BlackHoleEventDispatcher;
import com.facebook.react.uimanager.events.EventDispatcher;
import com.facebook.react.uimanager.events.EventDispatcherProvider;

/**
 * Scroll views emit scroll events through their context's EventDispatcherProvider. React Native
 * declares that interface Kotlin-internal, so Java implements it for these tests and drops the
 * events.
 */
class TestReactContext extends BridgeReactContext implements EventDispatcherProvider {
  TestReactContext(Context base) {
    super(base);
  }

  @Override
  public EventDispatcher getEventDispatcher() {
    return BlackHoleEventDispatcher.INSTANCE;
  }
}
