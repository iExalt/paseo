package sh.paseo.agentswitches

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val PREFIX = "paseo."

// Hands `adb shell am start --es paseo.<key> <value>` extras to JS, which ignores them unless the
// bundle was built with EXPO_PUBLIC_PASEO_AGENT_SWITCHES=1. See docs/agent-testing.md#debug-switches.
class PaseoAgentSwitchesModule : Module() {
  // Extras move here as soon as an intent arrives and wait until JS takes them. A cold start can
  // bring the activity to the foreground before JS subscribes, so an event alone would lose them.
  // Intents arrive on the main thread and JS takes on its own thread, so both lock the map.
  private val pending = mutableMapOf<String, String>()

  override fun definition() = ModuleDefinition {
    Name("PaseoAgentSwitches")
    Events("onSwitches")

    // Synchronous so JS has the launch switches before it acts on them.
    Function("takePendingSwitches") {
      collect(appContext.currentActivity?.intent)
      synchronized(pending) {
        val switches = pending.toMap()
        pending.clear()
        switches
      }
    }

    OnNewIntent { intent -> collect(intent) }

    OnActivityEntersForeground { collect(appContext.currentActivity?.intent) }
  }

  // Removes what it reads, so the foreground check and a recreated activity in the same process
  // do not apply the same switches again. After process death, a relaunch from recents rebuilds
  // the intent from the task and replays them.
  private fun collect(intent: Intent?) {
    val found = synchronized(pending) {
      val extras = intent?.extras ?: return
      val keys = extras.keySet().filter { it.startsWith(PREFIX) }
      for (key in keys) {
        extras.getString(key)?.let { pending[key.removePrefix(PREFIX)] = it }
        intent.removeExtra(key)
      }
      keys.isNotEmpty()
    }
    // Tells a running JS to take them; dropped harmlessly before JS subscribes.
    if (found) sendEvent("onSwitches")
  }
}
