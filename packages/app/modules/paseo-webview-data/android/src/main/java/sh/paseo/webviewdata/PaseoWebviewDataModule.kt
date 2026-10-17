package sh.paseo.webviewdata

import android.webkit.CookieManager
import android.webkit.WebStorage
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Clears what in-app web views remember between sessions. Android keeps one cookie
 * jar and one web storage per process, so this signs every WebView in Paseo out,
 * not only browser tabs. CookieManager needs a Looper thread, hence the main queue.
 */
class PaseoWebviewDataModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoWebviewData")

    AsyncFunction("clearData") { promise: Promise ->
      try {
        WebStorage.getInstance().deleteAllData()
        val cookies = CookieManager.getInstance()
        cookies.removeAllCookies { _ ->
          cookies.flush()
          promise.resolve(null)
        }
      } catch (error: Exception) {
        // CookieManager throws when the device has no usable WebView provider.
        promise.reject("ERR_WEBVIEW_DATA", error.message ?: "Couldn't clear web view data", error)
      }
    }.runOnQueue(Queues.MAIN)
  }
}
