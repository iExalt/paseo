import ExpoModulesCore
import WebKit

/// Clears what in-app web views remember between sessions. react-native-webview uses
/// the default website data store unless a view is incognito, so this signs every
/// persistent WKWebView in Paseo out, not only browser tabs.
public class PaseoWebviewDataModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoWebviewData")

    AsyncFunction("clearData") { (promise: Promise) in
      WKWebsiteDataStore.default().removeData(
        ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
        modifiedSince: Date.distantPast
      ) {
        promise.resolve(nil)
      }
    }.runOnQueue(.main)
  }
}
