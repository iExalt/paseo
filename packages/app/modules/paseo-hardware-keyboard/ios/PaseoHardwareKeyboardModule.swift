import ExpoModulesCore
import GameController
import UIKit

private let hardwareSubmitEventName = "onHardwareKeyboardSubmit"
private let shortcutKeyEventName = "onShortcutKey"
private let hardwareKeyboardChangeEventName = "onHardwareKeyboardChange"

private weak var activeModule: PaseoHardwareKeyboardModule?
// Main-thread state, read by the root view controller's key commands.
private var isHardwareSubmitEnabled = false
private var shortcutCommands: [UIKeyCommand] = []
private var shortcutEntries: [String: ShortcutEntry] = [:]

@objc
public class PaseoHardwareKeyboardReactDelegateHandler: ExpoReactDelegateHandler {
  public override func createRootViewController() -> UIViewController? {
    return PaseoHardwareKeyboardRootViewController()
  }
}

public class PaseoHardwareKeyboardModule: Module {
  private var keyboardObservers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("PaseoHardwareKeyboard")

    Events(hardwareSubmitEventName, shortcutKeyEventName, hardwareKeyboardChangeEventName)

    OnCreate {
      activeModule = self
      let center = NotificationCenter.default
      let module = self
      self.keyboardObservers = [Notification.Name.GCKeyboardDidConnect, .GCKeyboardDidDisconnect].map {
        center.addObserver(forName: $0, object: nil, queue: .main) { [weak module] _ in
          module?.sendEvent(hardwareKeyboardChangeEventName, ["present": GCKeyboard.coalesced != nil])
        }
      }
    }

    Function("setHardwareKeyboardSubmitEnabled") { (enabled: Bool) in
      DispatchQueue.main.async {
        isHardwareSubmitEnabled = enabled
      }
    }

    Function("setShortcutPolicy") { (policyJson: String) in
      let entries = parseShortcutPolicy(policyJson)
      DispatchQueue.main.async {
        installShortcutEntries(entries)
      }
    }

    // GameController discovers keyboards asynchronously, so this can read false at
    // launch; GCKeyboardDidConnect then reports the keyboard through the change event.
    Function("hasHardwareKeyboard") { () -> Bool in
      return GCKeyboard.coalesced != nil
    }

    OnDestroy {
      self.keyboardObservers.forEach { NotificationCenter.default.removeObserver($0) }
      self.keyboardObservers = []
      if activeModule === self {
        activeModule = nil
      }
      DispatchQueue.main.async {
        isHardwareSubmitEnabled = false
        installShortcutEntries([])
      }
    }
  }

  fileprivate func emitHardwareKeyboardSubmit() {
    sendEvent(hardwareSubmitEventName, [:])
  }

  fileprivate func emitShortcutKey(_ entry: ShortcutEntry, typing: Bool) {
    sendEvent(shortcutKeyEventName, [
      "key": entry.key,
      "code": entry.code,
      "altKey": entry.modifiers.contains(.alternate),
      "ctrlKey": entry.modifiers.contains(.control),
      "metaKey": entry.modifiers.contains(.command),
      "shiftKey": entry.modifiers.contains(.shift),
      "repeat": false,
      "typing": typing,
    ])
  }
}

/** One UIKeyCommand built from a combo in the policy JS publishes (native-shortcut-policy.ts). */
private struct ShortcutEntry {
  let input: String
  let modifiers: UIKeyModifierFlags
  /** DOM `key` and `code` reported to JS. */
  let key: String
  let code: String
  /** Listed in `always`: allowed while a text input has focus. */
  let whileTyping: Bool
  /** Swallow the key. iOS cannot report a key and still deliver it, so a combo that
   * must stay deliverable is only handled while nothing is being typed into. */
  let consume: Bool

  var id: String { shortcutEntryId(input: input, modifiers: modifiers) }
}

private func shortcutEntryId(input: String, modifiers: UIKeyModifierFlags) -> String {
  return "\(input)|\(modifiers.rawValue)"
}

private let namedKeyInputs: [String: (input: String, key: String)] = {
  var map: [String: (input: String, key: String)] = [
    "Escape": (UIKeyCommand.inputEscape, "Escape"),
    "ArrowUp": (UIKeyCommand.inputUpArrow, "ArrowUp"),
    "ArrowDown": (UIKeyCommand.inputDownArrow, "ArrowDown"),
    "ArrowLeft": (UIKeyCommand.inputLeftArrow, "ArrowLeft"),
    "ArrowRight": (UIKeyCommand.inputRightArrow, "ArrowRight"),
    "Home": (UIKeyCommand.inputHome, "Home"),
    "End": (UIKeyCommand.inputEnd, "End"),
    "PageUp": (UIKeyCommand.inputPageUp, "PageUp"),
    "PageDown": (UIKeyCommand.inputPageDown, "PageDown"),
    "Delete": (UIKeyCommand.inputDelete, "Delete"),
    "Tab": ("\t", "Tab"),
    "Enter": ("\r", "Enter"),
    "Backspace": ("\u{8}", "Backspace"),
    "Space": (" ", " "),
  ]
  let functionKeys = [
    UIKeyCommand.f1, UIKeyCommand.f2, UIKeyCommand.f3, UIKeyCommand.f4,
    UIKeyCommand.f5, UIKeyCommand.f6, UIKeyCommand.f7, UIKeyCommand.f8,
    UIKeyCommand.f9, UIKeyCommand.f10, UIKeyCommand.f11, UIKeyCommand.f12,
  ]
  for (index, input) in functionKeys.enumerated() {
    map["F\(index + 1)"] = (input, "F\(index + 1)")
  }
  return map
}()

private func parseShortcutPolicy(_ json: String) -> [ShortcutEntry] {
  guard
    let data = json.data(using: .utf8),
    let policy = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else {
    return []
  }
  let always = (policy["always"] as? [[String: Any]]) ?? []
  let whenNotTyping = (policy["whenNotTyping"] as? [[String: Any]]) ?? []
  return always.flatMap { makeShortcutEntries(from: $0, whileTyping: true) }
    + whenNotTyping.flatMap { makeShortcutEntries(from: $0, whileTyping: false) }
}

private func makeShortcutEntries(from combo: [String: Any], whileTyping: Bool) -> [ShortcutEntry] {
  guard let code = combo["code"] as? String else { return [] }
  var modifiers: UIKeyModifierFlags = []
  if combo["meta"] as? Bool == true { modifiers.insert(.command) }
  if combo["ctrl"] as? Bool == true { modifiers.insert(.control) }
  if combo["alt"] as? Bool == true { modifiers.insert(.alternate) }
  if combo["shift"] as? Bool == true { modifiers.insert(.shift) }
  let consume = combo["consume"] as? Bool ?? true

  func entry(input: String, key: String, code: String) -> ShortcutEntry {
    return ShortcutEntry(
      input: input, modifiers: modifiers, key: key, code: code,
      whileTyping: whileTyping, consume: consume
    )
  }

  if code == "Digit" {
    return (1...9).map { entry(input: "\($0)", key: "\($0)", code: "Digit\($0)") }
  }
  if let named = namedKeyInputs[code] {
    return [entry(input: named.input, key: named.key, code: code)]
  }
  guard let key = combo["key"] as? String, key.count == 1 else { return [] }
  var entries = [entry(input: key, key: key, code: code)]
  // Shift+/ may arrive as "?" or as "/" with Shift; register both spellings.
  if let shiftedKey = combo["shiftedKey"] as? String, modifiers.contains(.shift), shiftedKey.count == 1 {
    entries.append(entry(input: shiftedKey, key: shiftedKey, code: code))
  }
  return entries
}

private func installShortcutEntries(_ entries: [ShortcutEntry]) {
  var byId: [String: ShortcutEntry] = [:]
  for entry in entries where byId[entry.id] == nil {
    byId[entry.id] = entry
  }
  shortcutEntries = byId
  shortcutCommands = byId.values.map { entry in
    let command = UIKeyCommand(
      input: entry.input,
      modifierFlags: entry.modifiers,
      action: #selector(PaseoHardwareKeyboardRootViewController.handleShortcut(_:))
    )
    if #available(iOS 15.0, *) {
      command.wantsPriorityOverSystemBehavior = true
    }
    return command
  }
}

private final class PaseoHardwareKeyboardRootViewController: UIViewController {
  private static let submitCommandId = shortcutEntryId(input: "\r", modifiers: [])

  private var isSubmitCommandActive: Bool {
    return isHardwareSubmitEnabled && UIDevice.current.userInterfaceIdiom == .pad
  }

  override var keyCommands: [UIKeyCommand]? {
    var commands = super.keyCommands ?? []
    if isSubmitCommandActive {
      let command = UIKeyCommand(
        input: "\r",
        modifierFlags: [],
        action: #selector(handleHardwareKeyboardSubmit(_:))
      )
      if #available(iOS 15.0, *) {
        command.wantsPriorityOverSystemBehavior = true
      }
      commands.append(command)
    }
    for command in shortcutCommands {
      let id = shortcutEntryId(input: command.input ?? "", modifiers: command.modifierFlags)
      // Enter-to-submit owns plain Enter while it is active.
      if isSubmitCommandActive && id == Self.submitCommandId { continue }
      commands.append(command)
    }
    return commands
  }

  // UIKit asks before running a key command. Declining lets the key continue to the
  // focused view, which is how a combo bound only outside text fields passes through.
  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(handleShortcut(_:)) {
      guard let entry = shortcutEntry(for: sender) else { return false }
      return isShortcutAllowed(entry, typing: isTyping())
    }
    return super.canPerformAction(action, withSender: sender)
  }

  @objc
  fileprivate func handleShortcut(_ sender: UIKeyCommand) {
    guard let entry = shortcutEntry(for: sender) else { return }
    let typing = isTyping()
    guard isShortcutAllowed(entry, typing: typing) else { return }
    activeModule?.emitShortcutKey(entry, typing: typing)
  }

  @objc
  private func handleHardwareKeyboardSubmit(_ sender: UIKeyCommand) {
    guard canSubmitCurrentTextInput() else {
      return
    }
    activeModule?.emitHardwareKeyboardSubmit()
  }

  private func shortcutEntry(for sender: Any?) -> ShortcutEntry? {
    guard let command = sender as? UIKeyCommand, let input = command.input else { return nil }
    return shortcutEntries[shortcutEntryId(input: input, modifiers: command.modifierFlags)]
  }

  private func isShortcutAllowed(_ entry: ShortcutEntry, typing: Bool) -> Bool {
    if !typing { return true }
    guard entry.whileTyping && entry.consume else { return false }
    // Leave keys to an IME that is composing.
    let textInput = UIResponder.paseoCurrentFirstResponder as? UITextInput
    return textInput?.markedTextRange == nil
  }

  private func isTyping() -> Bool {
    return UIResponder.paseoCurrentFirstResponder is UITextInput
  }

  private func canSubmitCurrentTextInput() -> Bool {
    guard let responder = UIResponder.paseoCurrentFirstResponder else {
      return false
    }
    guard let textInput = responder as? UITextInput else {
      return false
    }
    return textInput.markedTextRange == nil
  }
}

private extension UIResponder {
  private static weak var currentFirstResponder: UIResponder?

  static var paseoCurrentFirstResponder: UIResponder? {
    currentFirstResponder = nil
    UIApplication.shared.sendAction(
      #selector(captureCurrentFirstResponder(_:)),
      to: nil,
      from: nil,
      for: nil
    )
    return currentFirstResponder
  }

  @objc
  private func captureCurrentFirstResponder(_ sender: Any?) {
    UIResponder.currentFirstResponder = self
  }
}
